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
const MessageValidator = require("sns-validator");
const validator = new MessageValidator();

const cachedCredentials = new Map();
const cachedRegions = new Map();
const credentialEnvMapping = new Map([
  ["accessKey", "AWS_ACCESS_KEY"],
  ["accessKeyId", "AWS_ACCESS_KEY_ID"],
  ["secretKey", "AWS_SECRET_KEY"],
  ["secretAccessKey", "AWS_SECRET_ACCESS_KEY"],
  ["sessionToken", "AWS_SESSION_TOKEN"],
  ["securityToken", "AWS_SECURITY_TOKEN"]
]);
const regionEnvMapping = new Map([["awsRegion", "AWS_REGION"], ["awsDefaultRegion", "AWS_DEFAULT_REGION"]]);
const _sns = new taws.connect("SNS");

// Store the credentials and region we receive in the SNS message in the AWS environment variables
const setAWSEnvVars = $ => {
  const credentials = _.get($, ["account", "credentials"]);

  if (credentials) {
    log.debug("Got credentials ...");
    for (const [key, envVar] of credentialEnvMapping.entries()) {
      // cache and clear current value
      if (process.env[envVar]) {
        log.debug(`caching env variable ${envVar}`);
        cachedCredentials.set(envVar, process.env[envVar]);

        delete process.env[envVar];
      }
      if (credentials[key]) {
        // set env var to value if present in cred

        log.debug(`setting env variable ${envVar}`);
        process.env[envVar] = credentials[key];
      }
    }
  }

  // TODO: this is assuming the existence of item.turbot.custom.Aws.RegionName
  // we need to think how we can pass the region to the controls & actions
  const region = _.get($, "item.turbot.custom.Aws.RegionName");

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
  // if a function type was passed in the env vars use that
  if (process.env.TURBOT_FUNCTION_TYPE) {
    turbotOpts.type = process.env.TURBOT_FUNCTION_TYPE;
  } else {
    // otherwise default to control
    turbotOpts.type = "control";
  }

  // When in "turbot test" the lambda is being initiated directly, not via
  // SNS. In this case we short cut all of the extraction of credentials etc,
  // and just run directly with the input passed in the event.
  if (process.env.TURBOT_TEST) {
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
        error: e
      });
      return callback(
        errors.badRequest("Invalid input data while starting the lambda function. Message should be received via SNS", {
          error: e
        })
      );
    }

    expandEventData(msgObj, (err, updatedMsgObj) => {
      if (err) {
        return callback(err);
      }

      sendNull(updatedMsgObj.meta.returnSnsArn);

      // create the turbot object
      turbotOpts.senderFunction = messageSender;

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
        cb => {
          tmp.dir({ keep: true }, (err, path) => {
            if (err) {
              return cb(err);
            }
            return cb(null, path);
          });
        }
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
            .on("error", function(err) {
              console.error("Error downloading large parameter", {
                url: largeParameterZipUrl,
                error: err
              });
              return cb(err, largeParamFileName);
            })
            .on("close", () => {
              return cb(null, largeParamFileName);
            });
        }
      ],
      extract: [
        "downloadLargeParameterZip",
        (results, cb) => {
          extract(results.downloadLargeParameterZip, { dir: results.tmpDir }, function(err) {
            return cb(err, results.downloadLargeParameterZip);
          });
        }
      ],
      parsedData: [
        "extract",
        (results, cb) => {
          fs.readJson(path.resolve(results.tmpDir, "large-input.json"), (err, obj) => {
            return cb(err, obj);
          });
        }
      ]
    },
    (err, results) => {
      if (err) {
        console.error("Error while processing large parameter input", { error: err, msgObj });
        return callback(err);
      }

      if (results.tmpDir) {
        rimraf.sync(results.tmpDir);
      }

      console.log("Large parameter retrieved, message payload modified");
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
    TopicArn: snsArn
  };
  log.debug("messageSender: Publishing to sns with params", { params });

  _sns.publish(params, (err, results) => {
    if (err) {
      log.error("Error publishing commands to SNS", { error: err });
      if (callback) return callback(err);
      return;
    }

    // Unless it is the final send, there's no need to call callback. However ... if it's the final send and the callback is not supplied
    // this lambda will not terminate in good time.
    if (callback) {
      return callback(err, results);
    }
  });
};

/**
 * If we don't use the _sns object before we start doing client related stuff,
 * the first time we use _sns it uses the client's creds!
 *
 * But if we use it before we're setting the client creds it works fine.
 */
const sendNull = snsArn => {
  log.debug("Send null");
  messageSender({ meta: { returnSnsArn: snsArn } });
};

const persistLargeCommands = (largeCommands, opts, callback) => {
  if (_.isEmpty(largeCommands)) return callback();

  asyncjs.auto(
    {
      tempDir: [
        cb => {
          const tmpDir = `${os.tmpdir()}/commands`;

          fs.access(tmpDir, err => {
            if (err && err.code === "ENOENT") {
              opts.log.debug("Temporary directory does not exist. Creating ...", { modDir: tmpDir });
              fs.ensureDir(tmpDir, err => cb(err, tmpDir));
            } else {
              cb(null, tmpDir);
            }
          });
        }
      ],
      largeCommandZip: [
        "tempDir",
        (results, cb) => {
          let outputStreamBuffer = new streamBuffers.WritableStreamBuffer({
            initialSize: 1000 * 1024, // start at 1000 kilobytes.
            incrementAmount: 1000 * 1024 // grow by 1000 kilobytes each time buffer overflows.
          });

          let archive = archiver("zip", {
            zlib: { level: 9 } // Sets the compression level.
          });
          archive.pipe(outputStreamBuffer);

          archive.append(JSON.stringify(largeCommands), { name: "large-commands.json" });
          archive.finalize();

          outputStreamBuffer.on("finish", () => {
            const zipFilePath = path.resolve(results.tempDir, `${opts.processId}.zip`);
            fs.writeFile(zipFilePath, outputStreamBuffer.getContents(), () => cb(null, zipFilePath));
          });
        }
      ],
      putLargeCommands: [
        "largeCommandZip",
        (results, cb) => {
          const stream = fs.createReadStream(results.largeCommandZip);
          fs.stat(results.largeCommandZip, (err, stat) => {
            if (err) {
              opts.log.error("Error stat large command zip file", { error: err });
              return cb(err);
            }

            const urlOpts = url.parse(opts.s3PresignedUrl);
            opts.log.debug("presigned url for large command saving", { parsed: urlOpts, urlRaw: opts.s3PresignedUrl });
            const reqOptions = {
              method: "PUT",
              host: urlOpts.host,
              path: urlOpts.path,
              headers: {
                "content-type": "application/zip",
                "content-length": stat.size,
                "content-encoding": "zip",
                "cache-control": "public, no-transform"
              }
            };

            opts.log.debug("Options to put large commands", { options: reqOptions });

            const req = https
              .request(reqOptions, resp => {
                let data = "";

                resp.on("data", chunk => {
                  data += chunk;
                });

                // The whole response has been received. Print out the result.
                resp.on("end", () => {
                  opts.log.debug("End put large commands", { data: data });
                  cb();
                });
              })
              .on("error", err => {
                opts.log.error("Error putting commands to S3", { error: err });

                return cb(err);
              });

            stream.pipe(req);
          });
        }
      ]
    },
    (err, results) => {
      const tempDir = results.tempDir;

      if (!_.isEmpty(tempDir)) {
        // Delete the entire /tmp/mods directory in case there are other leftover
        opts.log.debug("Deleting temp directory", { directory: tempDir });

        // Just use sync since this is Lambda and we're not doing anything else.
        rimraf.sync(tempDir);
        opts.log.debug("Temp directory deleted");
      }

      return callback(err, results);
    }
  );
};

const finalize = (event, context, init, err, result, callback) => {
  if (!callback) {
    // If called from a container, callback does not exist
    callback = () => {};
  }
  // restore the cached credentials and region values
  restoreCachedAWSEnvVars();

  // log errors to the process log
  if (err) {
    // If we receive error we want to add it to the turbot object.
    init.turbot.log.error("Unexpected error while executing Lambda/Container function", { error: err, mode: _mode });

    // Container always a fatal error, there's no auto retry (for now)
    if (err.fatal || _mode === "container") {
      // for a fatal error, set control state to error and return a null error
      // so SNS will think the lambda execution is successful and will not retry
      result = init.turbot.error(err.message, { error: err });
      err = null;
    }
  }

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
  init.turbot.sendFinal(callback);

  // What does not work:
  //   1. Simply setting the environment variable back, this is because the underlying
  //      AWS's SDK class caches the environment variable secrets at load time (sucks)
  //
  //
  // const turbotLambdaCreds = {
  //   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  //   sessionToken: process.env.AWS_SESSION_TOKEN
  // };
  //
  // 14/12 - New discovery:
  // doing this
  // AWS.config.credentials = null;
  // clears the internal cache of AWS SDK. This is set in Turbot's AWS SDK, so we
  // don't need to use a special construction parameters like:
  // const snsConstructionParams = { credentials: turbotLambdaCreds, region: lambdaRegion };
};

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
          persistLargeCommands(
            init.turbot.cargoContainer.largeCommands,
            {
              log: init.turbot.log,
              s3PresignedUrl: init.turbot.meta.s3PresignedUrlLargeCommands,
              processId: init.turbot.meta.processId
            },
            () => {
              // Handler is complete, so finalize the turbot handling.
              finalize(event, context, init, err, result, callback);
            }
          );
        });
      } catch (err) {
        log.error("Exception while executing the handler", { error: err, event, context });
        finalize(event, context, init, err, null, callback);
      }
    });
  };
}

const unhandledExceptionHandler = err => {
  if (err) {
    err.fatal = true;
  }
  finalize(_event, _context, _init, err, null, _callback);
};

process.on("SIGINT", e => {
  log.error("Lambda process received SIGINT", { error: e });
  log.warning("Lambda process received SIGINT");
  unhandledExceptionHandler(e);
});

process.on("SIGTERM", e => {
  log.error("Lambda process received SIGTERM", { error: e });
  log.warning("Lambda process received SIGTERM");
  unhandledExceptionHandler(e);
});

process.on("uncaughtException", e => {
  log.error("Lambda process received Uncaught Exception", { error: e });
  log.warning("Lambda process received Uncaught Exception", { error: e });
  unhandledExceptionHandler(e);
});

process.on("unhandledRejection", e => {
  log.error("Lambda process received Unhandled Rejection, do not ignore", { error: e });
  log.warning("Lambda process received Unhandled Rejection, do not ignore", { error: e });
  unhandledExceptionHandler(e);
});

class Run {
  constructor() {
    _mode = "container";

    this._runnableParameters = process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;

    if (_.isEmpty(this._runnableParameters) || this._runnableParameters === "undefined") {
      log.error("No parameters supplied", this._runnableParameters);
      log.error("No parameters supplied", this._runnableParameters);
      throw new errors.badRequest("No parameters supplied", this._runnableParameters);
    }
  }

  run() {
    const self = this;
    asyncjs.auto(
      {
        launchParameters: [
          cb => {
            const requestOptions = {
              timeout: 10000,
              gzip: true
            };

            request(Object.assign({ url: self._runnableParameters }, requestOptions), (err, response, body) => {
              if (err) {
                return cb(errors.internal("Unexpected error retrieving container run parameters", { error: err }));
              }
              cb(null, JSON.parse(body));
            });
          }
        ],
        sendNull: [
          "launchParameters",
          (results, cb) => {
            sendNull(results.launchParameters.meta.returnSnsArn);
            return cb();
          }
        ],
        turbot: [
          "sendNull",
          "launchParameters",
          (results, cb) => {
            const turbotOpts = {
              senderFunction: messageSender
            };
            //results.launchParameters.meta.live = false;
            const turbot = new Turbot(results.launchParameters.meta, turbotOpts);
            turbot.$ = results.launchParameters.payload.input;
            return cb(null, turbot);
          }
        ],
        setCaches: [
          "turbot",
          (results, cb) => {
            _event = {};
            _context = {};
            _init = {
              turbot: results.turbot
            };
            _callback = null;
            cb();
          }
        ],
        handling: [
          "turbot",
          (results, cb) => {
            setAWSEnvVars(results.launchParameters.payload.input);
            this.handler(results.turbot, results.launchParameters.payload.input, cb);
          }
        ],
        persistLargeCommands: [
          "handling",
          (results, cb) => {
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
              results.turbot.cargoContainer.largeCommands,
              {
                log: results.turbot.log,
                s3PresignedUrl: results.turbot.meta.s3PresignedUrlLargeCommands,
                processId: results.turbot.meta.processId
              },
              (err, _results) => {
                if (err) {
                  log.error("Error persisting large commands for containers", { error: err });
                }
                return cb(err, _results);
              }
            );
          }
        ],
        finalize: [
          "persistLargeCommands",
          (results, cb) => {
            log.debug("Finalize in container");
            results.turbot.stop();
            results.turbot.sendFinal(cb);
          }
        ]
      },
      (err, results) => {
        if (err) {
          log.error("Error while running", { error: err, results: results });
        }

        process.exit(0);
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
tfn.fnAsync = asyncHandler => {
  return tfn(util.callbackify(asyncHandler));
};

// Generic runner
tfn.Run = Run;

// Allow the callback version to be the default require (mostly for backwards compatibility):
//   tfn = require("@turbot/fn");
//   exports.control = tfn((turbot, $) => {
module.exports = tfn;
