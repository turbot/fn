const _ = require("lodash");
const { Turbot } = require("@turbot/sdk");
const archiver = require("archiver");
const asyncjs = require("async");
const errors = require("@turbot/errors");
const extract = require("extract-zip");
const fs = require("fs-extra");
const https = require("https");
const log = require("@turbot/log");
const os = require("os");
const path = require("path");
const request = require("request");
const rimraf = require("rimraf");
const streamBuffers = require("stream-buffers");
const taws = require("@turbot/aws-sdk");
const tmp = require("tmp");
const url = require("url");
const util = require("util");
const MessageValidator = require("@vhadianto/sns-validator");
const validator = new MessageValidator();

const cachedCredentials = new Map();

const cachedRegions = new Map();
const credentialEnvMapping = new Map([
  ["accesskey", "AWS_ACCESS_KEY"],
  ["accesskeyid", "AWS_ACCESS_KEY_ID"],
  ["secretkey", "AWS_SECRET_KEY"],
  ["secretaccesskey", "AWS_SECRET_ACCESS_KEY"],
  ["sessiontoken", "AWS_SESSION_TOKEN"],
  ["securitytoken", "AWS_SECURITY_TOKEN"],
]);
const regionEnvMapping = new Map([
  ["awsRegion", "AWS_REGION"],
  ["awsDefaultRegion", "AWS_DEFAULT_REGION"],
]);

// used by container, no issue with concurrency
let _containerSnsParam;

// this is OK to be shared by multiple Lambda instances because it should be
// Turbot credentials
let _lambdaSnsParam;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  _lambdaSnsParam = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION,
    maxRetries: 4,
    retryDelayOptions: {
      customBackoff: taws.customBackoffForDiscovery,
    },
  };
}

// Store the credentials and region we receive in the SNS message in the AWS environment variables
const setAWSEnvVars = ($) => {
  // We assume that the AWS credentials from graphql are available in the
  // standard locations (best we can do without a lot of complexity). We
  // go from most rare find to least rare, which is most likely what the
  // developer will expect.
  let credentials = _.get($, ["organization", "credentials"]);
  if (!credentials) {
    credentials = _.get($, ["organizationalUnit", "credentials"]);
    if (!credentials) {
      credentials = _.get($, ["account", "credentials"]);
    }
  }

  if (credentials) {
    // AWS generates accessKeyId (with lower case a) for IAM Role but AccessKeyId
    // (with upper case A) for access key pair.
    credentials = Object.keys(credentials).reduce((c, k) => ((c[k.toLowerCase()] = credentials[k]), c), {});

    for (const [key, envVar] of credentialEnvMapping.entries()) {
      // cache and clear current value
      if (process.env[envVar]) {
        log.debug(`caching env variable ${envVar}`);
        cachedCredentials.set(envVar, process.env[envVar]);

        delete process.env[envVar];
      }
      if (credentials[key.toLowerCase()]) {
        // set env var to value if present in cred

        log.debug(`setting env variable ${envVar}`);
        process.env[envVar] = credentials[key.toLowerCase()];
      }
    }
  }

  let region = _.get(
    $,
    "item.turbot.custom.aws.regionName",
    _.get($, "item.turbot.metadata.aws.regionName", _.get($, "item.metadata.aws.regionName"))
  );

  if (!region) {
    // Guess from the partition which default region we should be, this crucial for
    // the setup where we run Turbot Master in AWS Commercial and we manage accounts in AWS GovCloud or AWS China
    // without this "default region" setup the default region will be the current region where Lambda is executing.
    // it's fine when the accounts are in the partition (All in commercial, all in GovCloud) but it will
    // fail miserably if the target account is in GovCloud/China while Turbot Master is in Commercial
    const defaultPartition = _.get($, "item.metadata.aws.partition", _.get($, "item.turbot.custom.aws.partition"));
    if (defaultPartition === "aws-us-gov") {
      region = "us-gov-west-1";
    } else if (defaultPartition === "aws-cn") {
      region = "cn-north-1";
    }
  }

  if (region) {
    for (const [, envVar] of regionEnvMapping.entries()) {
      // cache current value
      if (process.env[envVar]) {
        log.debug(`caching env variable ${envVar}`);
        cachedRegions.set(envVar, process.env[envVar]);
      }

      // set env var to region
      log.debug(`setting env variable ${envVar}`);
      process.env[envVar] = region;
    }
  }
};

const restoreCachedAWSEnvVars = () => {
  if (cachedCredentials.size > 0) {
    for (const [, envVar] of credentialEnvMapping.entries()) {
      if (process.env[envVar]) {
        delete process.env[envVar];
      }
    }
    for (const [envVar, value] of cachedCredentials.entries()) {
      process.env[envVar] = value;
    }
  }

  if (cachedRegions.size > 0) {
    for (const [, envVar] of regionEnvMapping.entries()) {
      if (process.env[envVar]) {
        delete process.env[envVar];
      }
    }
    for (const [envVar, value] of cachedRegions.entries()) {
      process.env[envVar] = value;
    }
  }
};

const initialize = (event, context, callback) => {
  const turbotOpts = {};

  // When in "turbot test" the lambda is being initiated directly, not via
  // SNS. In this case we short cut all of the extraction of credentials etc,
  // and just run directly with the input passed in the event.
  if (process.env.TURBOT_TEST) {
    turbotOpts.type = _.get(event, "meta.runType", process.env.TURBOT_FUNCTION_TYPE);

    // In test mode there is no metadata (e.g. AWS credentials) for Turbot,
    // they are all inherited from the underlying development environment.
    const turbot = new Turbot(event.meta || {}, turbotOpts);

    // In test mode, the input is in the payload of the event (no SNS wrapper).
    // default to using event directly for backwards compatibility
    turbot.$ = _.get(event, ["payload", "input"], event);

    // set the AWS credentials and region env vars using the values passed in the control input
    setAWSEnvVars(turbot.$);
    return callback(null, { turbot });
  }

  // SNS sends a single record at a time to Lambda.
  const rawMessage = _.get(event, "Records[0].Sns.Message");
  if (!rawMessage) {
    return callback(
      errors.badRequest("Turbot controls should be called via SNS, or with TURBOT_TEST set to true", { event, context })
    );
  }

  return validator.validate(event.Records[0].Sns, (err, snsMessage) => {
    if (err) {
      log.error("Error in validating SNS message", { error: err, message: event.Records[0].Sns });
      return callback(
        errors.badRequest("Failed SNS message validation", { error: err, message: event.Records[0].Sns })
      );
    }

    let msgObj;
    try {
      msgObj = JSON.parse(snsMessage.Message);
    } catch (e) {
      log.error("Invalid input data while starting the lambda function. Message should be received via SNS", {
        error: e,
      });
      return callback(
        errors.badRequest("Invalid input data while starting the lambda function. Message should be received via SNS", {
          error: e,
        })
      );
    }

    log.info("Received message", {
      actionId: _.get(msgObj, "meta.actionId"),
      controlId: _.get(msgObj, "meta.controlId"),
      policyId: _.get(msgObj, "meta.policyValueId", _.get(msgObj, "meta.policyId")),
    });

    expandEventData(msgObj, (err, updatedMsgObj) => {
      if (err) {
        return callback(err);
      }

      // create the turbot object
      turbotOpts.senderFunction = messageSender;

      // Prefer the runType specified in the meta (for backward compatibility with anything prior to beta 46)
      turbotOpts.type = _.get(updatedMsgObj, "meta.runType", process.env.TURBOT_FUNCTION_TYPE);
      // if a function type was passed in the env vars use that
      if (!turbotOpts.type) {
        // otherwise default to control
        turbotOpts.type = "control";
      }

      const turbot = new Turbot(updatedMsgObj.meta, turbotOpts);
      // Convenient access
      turbot.$ = updatedMsgObj.payload.input;

      // set the AWS credentials and region env vars using the values passed in the control input
      setAWSEnvVars(turbot.$);

      callback(null, { turbot });
    });
  });
};

const expandEventData = (msgObj, callback) => {
  const payloadType = _.get(msgObj, "payload.type");
  if (payloadType !== "large_parameter") {
    return callback(null, msgObj);
  }
  asyncjs.auto(
    {
      tmpDir: [
        (cb) => {
          tmp.dir({ keep: true }, (err, path) => {
            if (err) {
              return cb(err);
            }
            return cb(null, path);
          });
        },
      ],
      downloadLargeParameterZip: [
        "tmpDir",
        (results, cb) => {
          const largeParameterZipUrl = msgObj.payload.s3PresignedUrlForParameterGet;
          const largeParamFileName = path.resolve(results.tmpDir, "large-parameter.zip");

          // TODO: should we remove? how to re-run the control installed?
          const file = fs.createWriteStream(largeParamFileName);

          return request
            .get(largeParameterZipUrl)
            .pipe(file)
            .on("error", function (err) {
              console.error("Error downloading large parameter", {
                url: largeParameterZipUrl,
                error: err,
              });
              return cb(err, largeParamFileName);
            })
            .on("close", () => {
              return cb(null, largeParamFileName);
            });
        },
      ],
      extract: [
        "downloadLargeParameterZip",
        (results, cb) => {
          extract(results.downloadLargeParameterZip, { dir: results.tmpDir })
            .then(() => {
              return cb(null, results.downloadLargeParameterZip);
            })
            .catch((ex) => {
              return cb(ex);
            });
        },
      ],
      parsedData: [
        "extract",
        (results, cb) => {
          fs.readJson(path.resolve(results.tmpDir, "large-input.json"), (err, obj) => {
            return cb(err, obj);
          });
        },
      ],
    },
    (err, results) => {
      if (err) {
        console.error("Error while processing large parameter input", { error: err, msgObj });
        return callback(err);
      }

      if (results.tmpDir) {
        rimraf.sync(results.tmpDir);
      }

      _.defaultsDeep(msgObj.payload, results.parsedData.payload);

      return callback(null, msgObj);
    }
  );
};

/**
 * The callback here is the Lambda's callback. When it's called the lambda will be terminated
 */
const messageSender = (message, opts, callback) => {
  const snsArn = message.meta.returnSnsArn;

  const params = {
    Message: JSON.stringify(message),
    MessageAttributes: {},
    TopicArn: snsArn,
  };
  log.debug("messageSender: Publishing to sns with params", { params });
  log.info("messageSender: publish to sns", {
    snsArn,
    actionId: _.get(message, "meta.actionId"),
    controlId: _.get(message, "meta.controlId"),
    policyId: _.get(message, "meta.policyValueId", _.get(message, "meta.policyId")),
  });

  const paramToUse = _mode === "container" ? _containerSnsParam : _lambdaSnsParam;
  const sns = new taws.connect("SNS", paramToUse);

  sns.publish(params, (xErr, results) => {
    if (xErr) {
      log.error("Error publishing commands to SNS", { error: xErr });
      if (callback) {
        return callback(xErr);
      }
      return;
    }

    log.info("SNS message published", { results });

    // Unless it is the final send, there's no need to call callback. However ... if it's the final send and the callback is not supplied
    // this lambda will not terminate in good time.
    if (callback) {
      return callback(xErr, results);
    }
  });
};

const persistLargeCommands = (cargoContainer, opts, callback) => {
  let largeCommands;
  if (cargoContainer.largeCommandV2) {
    largeCommands = {
      commands: cargoContainer.commands,
      logEntries: cargoContainer.logEntries,
    };
  } else {
    largeCommands = cargoContainer.largeCommands;
  }

  if (_.isEmpty(largeCommands)) {
    cargoContainer.largeCommandState = "finalised";
    return callback();
  }

  asyncjs.auto(
    {
      tempDir: [
        (cb) => {
          const osTempDir = _.isEmpty(process.env.TURBOT_TMP_DIR) ? os.tmpdir() : process.env.TURBOT_TMP_DIR;
          const tmpDir = `${osTempDir}/commands`;

          fs.access(tmpDir, (err) => {
            if (err && err.code === "ENOENT") {
              opts.log.debug("Temporary directory does not exist. Creating ...", { modDir: tmpDir });
              fs.ensureDir(tmpDir, (err) => cb(err, tmpDir));
            } else {
              cb(null, tmpDir);
            }
          });
        },
      ],
      largeCommandZip: [
        "tempDir",
        (results, cb) => {
          const outputStreamBuffer = new streamBuffers.WritableStreamBuffer({
            initialSize: 1000 * 1024, // start at 1000 kilobytes.
            incrementAmount: 1000 * 1024, // grow by 1000 kilobytes each time buffer overflows.
          });

          const archive = archiver("zip", {
            zlib: { level: 9 }, // Sets the compression level.
          });
          archive.pipe(outputStreamBuffer);

          archive.append(JSON.stringify(largeCommands), { name: "large-commands.json" });

          outputStreamBuffer.on("finish", () => {
            const zipFilePath = path.resolve(results.tempDir, `${opts.processId}.zip`);
            fs.writeFile(zipFilePath, outputStreamBuffer.getContents(), () => cb(null, zipFilePath));
          });

          archive.finalize();
        },
      ],
      putLargeCommands: [
        "largeCommandZip",
        (results, cb) => {
          const stream = fs.createReadStream(results.largeCommandZip);
          fs.stat(results.largeCommandZip, (err, stat) => {
            if (err) {
              console.error("Error stat large command zip file", { error: err });
              return cb(err);
            }

            const urlOpts = url.parse(opts.s3PresignedUrl);
            const reqOptions = {
              method: "PUT",
              host: urlOpts.host,
              path: urlOpts.path,
              headers: {
                "content-type": "application/zip",
                "content-length": stat.size,
                "content-encoding": "zip",
                "cache-control": "public, no-transform",
              },
            };

            opts.log.debug("Options to put large commands", { options: reqOptions });
            log.info("Saving large command with options", { options: reqOptions });
            const req = https
              .request(reqOptions, (resp) => {
                let data = "";

                // Do not remove this block, somehow request does not complete if I remove ths (?)
                resp.on("data", (chunk) => {
                  data += chunk;
                });

                resp.on("end", () => {
                  opts.log.debug("End put large commands", { data: data });
                  log.info("Large command saving completed", { data: data });
                  cb();
                });
              })
              .on("error", (err) => {
                console.error("Error putting commands to S3", { error: err });
                return cb(err);
              });

            stream.pipe(req);
          });
        },
      ],
    },
    (err, results) => {
      // Do not add any more content to the cargo because it may trip the size over
      const tempDir = results.tempDir;

      if (!_.isEmpty(tempDir)) {
        // Just use sync since this is Lambda and we're not doing anything else.
        rimraf.sync(tempDir);
      }

      log.info("Cargo state set to finalized no further data will be added.");
      cargoContainer.largeCommandState = "finalised";
      return callback(err, results);
    }
  );
};

const finalize = (event, context, init, err, result, callback) => {
  if (!callback) {
    // If called from a container, callback does not exist
    callback = () => {};
  }

  if (_mode === "container") {
    delete process.env.AWS_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_KEY;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_SECURITY_TOKEN;
  } else {
    // restore the cached credentials and region values
    restoreCachedAWSEnvVars();
  }

  if (!init || !init.turbot) {
    // can't do anything here .. have to just silently return
    console.error("Error reported but no turbot object, unable to send anything back", { error: err });
  }

  // DO NOT log error here - we've persisted the large commands, let's avoid adding
  // any new information into the cargo

  // Do not wait for empty callback look to terminate the process
  context.callbackWaitsForEmptyEventLoop = false;

  // If in test mode, then do not publish to SNS. Instead, morph the response to include
  // both the turbot information and the raw result so they can be used for assertions.
  if (process.env.TURBOT_TEST) {
    // include process event with result

    // get the function result as a process event
    const processEvent = init.turbot.sendFinal();
    result = { result, turbot: processEvent };

    if (err) {
      // if there is an error, lambda does not return the result, so include it with the error
      // lambda returns a standard error object so to pass a custom object we must stringify
      const utils = require("@turbot/utils");
      return callback(JSON.stringify(utils.data.sanitize({ err, result }, { breakCircular: true })));
    }
    return callback(null, result);
  }

  // On error we just send back all the existing data. Lambda will re-try 3 times, the receiving end (Turbot Core) will
  // receive the same log 3 times (providing it's the same execution). On the receiving end (Turbot Core) we
  // will detect if the same error happens 3 time and terminate the process.
  //
  // NOTE: we should time limit the Lambda execution to stop running Lambda costing us $$$

  init.turbot.stop();
  if (!err) {
    return init.turbot.sendFinal((_err) => {
      if (_err) {
        console.error("Error in send final function", { error: _err });
      }
      // if there's an error in the sendFinal function ... that means our SNS message may not
      // make it back to Turbot Worker, so we need to retry and return the error.

      // Lambda will retries 2 times then it will end up in the DLQ. If we don't return the error (previous version of the code)
      // we will end up as "missing" control run -> we don't send the result back to Turbot Server
      // but Lambda doesn't retru.
      return callback(_err);
    });
  }

  // Don't do this for Lambda, see comment above
  if (_mode === "container") {
    init.turbot.log.error("Error running container", { error: err });
    init.turbot.error("Error running container");
  }

  init.turbot.send((_err) => {
    if (_err) {
      console.error("Error in send function", { error: _err });
    }
    return callback(err);
  });
};

// Container specific - no issue with multiple Lambda functions running
// at the same time
let _event, _context, _init, _callback, _mode;

function tfn(handlerCallback) {
  _mode = "lambda";

  // Return a function in Lambda signature format, so it can be registered as a
  // handler.
  return (event, context, callback) => {
    // Initialize the Turbot metadata and context, configuring the lambda function
    // for simpler writing and use by mods.
    initialize(event, context, (err, init) => {
      // Errors in the initialization should be returned immediately as errors in
      // the lambda function itself.
      if (err) return callback(err);

      _event = event;
      _context = context;
      _init = init;
      _callback = callback;

      try {
        // Run the handler function. Wrapped in a try block to catch any
        // crashes or unexpected errors.
        handlerCallback(init.turbot, init.turbot.$, (err, result) => {
          if (err) {
            if (err.fatal) {
              if (_.get(init, "turbot")) {
                init.turbot.log.error(
                  `Unexpected fatal error while executing Lambda/Container function. Container error is always fatal. Execution will be terminated immediately.`,
                  {
                    error: err,
                    mode: _mode,
                  }
                );
              }

              // for a fatal error, set control state to error and return a null error
              // so SNS will think the lambda execution is successful and will not retry
              result = init.turbot.error(err.message, { error: err });

              err = null;
            } else {
              // If we receive error we want to add it to the turbot object.
              init.turbot.log.error(
                `Unexpected non-fatal error while executing Lambda function. Lambda will be retried based on AWS Lambda retry policy`,
                {
                  error: err,
                  mode: _mode,
                }
              );
            }
          }

          persistLargeCommands(
            init.turbot.cargoContainer,
            {
              log: init.turbot.log,
              s3PresignedUrl: init.turbot.meta.s3PresignedUrlLargeCommands,
              processId: init.turbot.meta.processId,
            },
            () => {
              // Handler is complete, so finalize the turbot handling.
              finalize(event, context, init, err, result, callback);
            }
          );
        });
      } catch (err) {
        console.error("Caught exception while executing the handler", { error: err, event, context });

        // Try our best - it should really call persist large command, but not much we can do here
        finalize(event, context, init, err, null, callback);
      }
    });
  };
}

const unhandledExceptionHandler = (err) => {
  if (err) {
    err.fatal = true;
  }
  finalize(_event, _context, _init, err, null, _callback);
};

/**
 * AWS added their own unhandledRejection for Node 10 Lambda (!)
 *
 * Added all the others to ensure that our wrapper is the only one adding the the following events.
 *
 * https://forums.aws.amazon.com/thread.jspa?messageID=906365&tstart=0
 */
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
process.removeAllListeners("uncaughtException");
process.removeAllListeners("unhandledRejection");

process.on("SIGINT", (e) => {
  log.error("Lambda process received SIGINT", { error: e });
  unhandledExceptionHandler(e);
});

process.on("SIGTERM", (e) => {
  log.error("Lambda process received SIGTERM", { error: e });
  unhandledExceptionHandler(e);
});

process.on("uncaughtException", (e) => {
  log.error("Lambda process received Uncaught Exception", { error: e });
  unhandledExceptionHandler(e);
});

process.on("unhandledRejection", (e) => {
  log.error("Lambda process received Unhandled Rejection, do not ignore", { error: e });
  unhandledExceptionHandler(e);
});

const decryptContainerParameters = ({ envelope }, callback) => {
  const crypto = require("crypto");
  const ALGORITHM = "aes-256-gcm";

  asyncjs.auto(
    {
      decryptedEphemeralDataKey: [
        (cb) => {
          const params = {
            KeyId: envelope.kmsKey,
            CiphertextBlob: Buffer.from(envelope.$$dataKey, "base64"),
            EncryptionContext: { purpose: "turbot-control" },
          };

          const kms = taws.connect("KMS");
          kms.decrypt(params, (err, data) => {
            if (err) {
              console.error("ERROR in decrypting data key", { error: err });
              return cb(err);
            }
            return cb(null, data.Plaintext.toString("utf8"));
          });
        },
      ],
      decryptedData: [
        "decryptedEphemeralDataKey",
        (results, cb) => {
          const plaintextEncoding = "utf8";
          const keyBuffer = Buffer.from(results.decryptedEphemeralDataKey, "base64");
          const cipherBuffer = Buffer.from(envelope.$$data, "base64");
          const ivBuffer = cipherBuffer.slice(0, 12);
          const chunk = cipherBuffer.slice(12, -16);
          const tagBuffer = cipherBuffer.slice(-16);
          const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, ivBuffer);
          decipher.setAuthTag(tagBuffer);
          const plaintext = decipher.update(chunk, null, plaintextEncoding) + decipher.final(plaintextEncoding);

          const paramObj = JSON.parse(plaintext);
          return cb(null, paramObj);
        },
      ],
    },
    (err, results) => {
      return callback(err, results.decryptedData);
    }
  );
};

class Run {
  constructor() {
    _mode = "container";

    this._runnableParameters = process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;

    if (_.isEmpty(this._runnableParameters) || this._runnableParameters === "undefined") {
      log.error("No parameters supplied", this._runnableParameters);
      throw new errors.badRequest("No parameters supplied", this._runnableParameters);
    }
  }

  run() {
    const self = this;
    asyncjs.auto(
      {
        rawLaunchParameters: [
          (cb) => {
            const requestOptions = {
              timeout: 10000,
              gzip: true,
            };

            request(Object.assign({ url: self._runnableParameters }, requestOptions), (err, response, body) => {
              if (err) {
                return cb(errors.internal("Unexpected error retrieving container run parameters", { error: err }));
              }
              cb(null, JSON.parse(body));
            });
          },
        ],
        launchParameters: [
          "rawLaunchParameters",
          (results, cb) => {
            if (!results.rawLaunchParameters.$$dataKey) {
              return cb(null, results.rawLaunchParameters);
            }

            return decryptContainerParameters({ envelope: results.rawLaunchParameters }, cb);
          },
        ],
        containerMetadata: [
          "launchParameters",
          (results, cb) => {
            // backward compatibility let's only do this for EC2 launch type
            if (results.launchParameters.meta.launchType !== "EC2") {
              return cb();
            }
            const request = require("request");
            request(
              `http://169.254.170.2${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`,
              function (err, response, body) {
                if (err) {
                  return cb(err);
                }
                const containerMetadata = JSON.parse(body);
                _containerSnsParam = {
                  accessKeyId: containerMetadata.AccessKeyId,
                  secretAccessKey: containerMetadata.SecretAccessKey,
                  sessionToken: containerMetadata.Token,
                  region: process.env.TURBOT_REGION,
                  maxRetries: 4,
                  retryDelayOptions: {
                    customBackoff: taws.customBackoffForDiscovery,
                  },
                };
                return cb(null, containerMetadata);
              }
            );
          },
        ],
        turbot: [
          "launchParameters",
          "containerMetadata",
          (results, cb) => {
            const turbotOpts = {
              senderFunction: messageSender,
            };
            //results.launchParameters.meta.live = false;
            const turbot = new Turbot(results.launchParameters.meta, turbotOpts);
            turbot.$ = results.launchParameters.payload.input;
            return cb(null, turbot);
          },
        ],
        setCaches: [
          "turbot",
          (results, cb) => {
            _event = {};
            _context = {};
            _init = {
              turbot: results.turbot,
            };
            _callback = null;
            cb();
          },
        ],
        handling: [
          "turbot",
          (results, cb) => {
            setAWSEnvVars(results.launchParameters.payload.input);
            this.handler(results.turbot, results.launchParameters.payload.input, cb);
          },
        ],
      },
      (err, results) => {
        if (err) {
          log.error("Error while running", { error: err, results: results });
          if (results.turbot) {
            results.turbot.log.error("Error while running container", { error: err });
            results.turbot.error("Error while running container");
            results.turbot.stop();
            return results.turbot.sendFinal(() => {
              return process.exit(0);
            });
          }
          return finalize(_event, _context, _init, err, null, (err) => {
            console.error("Error in finalizing the container run due to error", { error: err });
            return process.exit(0);
          });
        }

        // this is a container so need to delete these.
        log.debug(
          "Deleting env variables: AWS_ACCESS_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_SECURITY_TOKEN"
        );

        delete process.env.AWS_ACCESS_KEY;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_KEY;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_SESSION_TOKEN;
        delete process.env.AWS_SECURITY_TOKEN;

        persistLargeCommands(
          results.turbot.cargoContainer,
          {
            log: results.turbot.log,
            s3PresignedUrl: results.turbot.meta.s3PresignedUrlLargeCommands,
            processId: results.turbot.meta.processId,
          },
          (err) => {
            if (err) {
              log.error("Error persisting large commands for containers", { error: err });
            }
            log.debug("Finalize in container");
            results.turbot.stop();
            results.turbot.sendFinal(() => {
              process.exit(0);
            });
          }
        );
      }
    );
  }

  handler(turbot, $, callback) {
    log.warning("Base class handler is called, nothing to do");
    return callback();
  }
}

// Allow the callback version to be included with:
//   { fn } = require("@turbot/fn");
//   exports.control = fn((turbot, $) => {
tfn.fn = tfn;

// Allow the async version to be included with:
//   { fnAsync } = require("@turbot/fn");
//   exports.control = fnAsync(async (turbot, $) => {
tfn.fnAsync = (asyncHandler) => {
  return tfn(util.callbackify(asyncHandler));
};

// Generic runner
tfn.Run = Run;

// Allow the callback version to be the default require (mostly for backwards compatibility):
//   tfn = require("@turbot/fn");
//   exports.control = tfn((turbot, $) => {
module.exports = tfn;
