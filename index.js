const _ = require("lodash");
const { Turbot } = require("@turbot/sdk");
const archiver = require("archiver");
const asyncjs = require("async");
const errors = require("@turbot/errors");
const fs = require("fs-extra");
const https = require("https");
const log = require("@turbot/log");
const os = require("os");
const path = require("path");
const request = require("request");
const rimraf = require("rimraf");
const streamBuffers = require("stream-buffers");
const taws = require("@turbot/aws-sdk");
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

// Store the credentials and region we receive in the SNS message in the AWS environment variables
const setAWSEnvVars = $ => {
  const credentials = _.get($, ["account", "credentials"]);

  if (credentials) {
    for (const [key, envVar] of credentialEnvMapping.entries()) {
      // cache and clear current value
      if (process.env[envVar]) {
        cachedCredentials.set(envVar, process.env[envVar]);

        delete process.env[envVar];
      }
      if (credentials[key]) {
        // set env var to value if present in cred

        process.env[envVar] = credentials[key];
      }
    }
  }

  // TODO: this is assuming that the structure is called item.RegionName
  // we need to think how we can pass the region to the controls & actions
  const region = _.get($, "item.Aws.RegionName");

  if (region) {
    for (const [, envVar] of regionEnvMapping.entries()) {
      // cache current value
      if (process.env[envVar]) {
        cachedRegions.set(envVar, process.env[envVar]);
      }

      // set env var to region
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

let _sns;

const initialize = (event, context, callback) => {
  // Do this before we set the AWS Env Vars;
  _sns = new taws.connect("SNS");

  const turbotOpts = {};
  // if a function type was passed in the envn vars use that
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
      console.error("Error in validating SNS message", { error: err, message: event.Records[0].Sns });
      return callback(
        errors.badRequest("Failed SNS message validation", { error: err, message: event.Records[0].Sns })
      );
    }

    let msgObj;
    try {
      msgObj = JSON.parse(snsMessage.Message);
      log.debug("Parsed message content", JSON.stringify(msgObj));
    } catch (e) {
      console.error("Invalid input data while starting the lambda function. Message should be received via SNS", {
        error: e
      });
      return callback(
        errors.badRequest("Invalid input data while starting the lambda function. Message should be received via SNS", {
          error: e
        })
      );
    }

    turbotOpts.senderFunction = messageSender;

    const turbot = new Turbot(msgObj.meta, turbotOpts);

    // Convenient access
    turbot.$ = msgObj.payload.input;

    // set the AWS credentials and region env vars using the values passed in the control input
    setAWSEnvVars(turbot.$);

    callback(null, { turbot });
  });
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
  log.debug("Publishing to sns with params", { params });

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

          outputStreamBuffer.on("finish", function() {
            const zipFilePath = path.resolve(results.tempDir, `${opts.processId}.zip`);
            fs.writeFile(zipFilePath, outputStreamBuffer.getContents(), function() {
              return cb(null, zipFilePath);
            });
          });
        }
      ],
      putLargeCommands: [
        "largeCommandZip",
        (results, cb) => {
          const stream = fs.createReadStream(results.largeCommandZip);
          fs.stat(results.largeCommandZip, (err, stat) => {
            if (err) return cb(err);

            const urlOpts = url.parse(opts.s3PresignedUrl);
            const req = https
              .request(
                {
                  method: "PUT",
                  host: urlOpts.host,
                  path: urlOpts.path,
                  headers: {
                    "content-type": "application/zip",
                    "content-length": stat.size,
                    "content-encoding": "zip",
                    "cache-control": "public, no-transform"
                  }
                },
                resp => {
                  let data = "";

                  resp.on("data", chunk => {
                    data += chunk;
                  });

                  // The whole response has been received. Print out the result.
                  resp.on("end", () => {
                    opts.log.debug("End put large commands", { data: data });
                    cb();
                  });
                }
              )
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
    callback = function() {};
  }
  // restore the cached credentials and region values
  restoreCachedAWSEnvVars();

  // log errors to the process log
  if (err) {
    // If we receive error we want to add it to the turbot object.
    console.error("Unexpected error while executing Lambda/Container function", { error: err, mode: _mode });
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
  // const snsConstrutionParams = { credentials: turbotLambdaCreds, region: lambdaRegion };
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
              s3PresignedUrl: init.turbot.meta.s3PresignedUrl,
              processId: init.turbot.meta.processId
            },
            (err, results) => {
              // Handler is complete, so finalize the turbot handling.
              finalize(event, context, init, err, result, callback);
            }
          );
        });
      } catch (err) {
        console.error("Exception while executing the handler", { error: err, event, context });
        log.error("Exception while executing the handler", { error: err, event, context });
        finalize(event, context, init, err, null, callback);
      }
    });
  };
}

const unhandledExceptionHandler = err => {
  finalize(_event, _context, _init, err, null, _callback);
};

process.on("SIGINT", e => {
  console.error("Lambda process received SIGINT", { error: e });
  log.warning("Lambda process received SIGINT");
  unhandledExceptionHandler(e);
});

process.on("SIGTERM", e => {
  console.error("Lambda process received SIGTERM", { error: e });
  log.warning("Lambda process received SIGTERM");
  unhandledExceptionHandler(e);
});

process.on("uncaughtException", e => {
  console.error("Lambda process received Uncaught Exception", { error: e });
  log.warning("Lambda process received Uncaught Exception", { error: e });
  unhandledExceptionHandler(e);
});

process.on("unhandledRejection", e => {
  console.error("Lambda process received Unhandled Rejection, ignore", { error: e });
  log.warning("Lambda process received Unhandled Rejection, ignore", { error: e });
});

class Run {
  constructor() {
    _mode = "container";

    // Do this before we set the AWS Env Vars;
    _sns = new taws.connect("SNS");

    this._runnableParameters = process.env.TURBOT_CONTROL_CONTAINER_PARAMETERS;
    log.debug("Control Container starting parameters", this._runnableParameters);

    if (_.isEmpty(this._runnableParameters) || this._runnableParameters === "undefined") {
      console.error("No parameters supplied", this._runnableParameters);
      log.error("No parameters supplied", this._runnableParameters);
      throw new errors.badRequest("No parameters supplied", this._runnableParameters);
    }
  }

  run() {
    asyncjs.auto(
      {
        launchParameters: [
          cb => {
            const requestOptions = {
              timeout: 10000,
              gzip: true
            };

            request(Object.assign({ url: this._runnableParameters }, requestOptions), function(err, response, body) {
              if (err) {
                return cb(errors.internal("Unexpected error confirming SNS subscribe request", { error: err }));
              }
              cb(null, JSON.parse(body));
            });
          }
        ],
        turbot: [
          "launchParameters",
          (results, cb) => {
            const turbotOpts = {
              senderFunction: this.containerMessageSender
            };
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
                s3PresignedUrl: results.turbot.meta.s3PresignedUrl,
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

  containerMessageSender(message, opts, callback) {
    const returnSnsArn = message.meta.returnSnsArn;

    const params = {
      Message: JSON.stringify(message),
      MessageAttributes: {},
      TopicArn: returnSnsArn
    };

    _sns.publish(params, (err, results) => {
      if (err) {
        log.error("Error publishing commands to SNS", { error: err });
        if (callback) return callback(err);
        return;
      }

      if (callback) return callback(null, results);
      return;
    });
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

// Allow the callback version to be the default require (mostly for backwards
// compatability):
//   tfn = require("@turbot/fn");
//   exports.control = tfn((turbot, $) => {
module.exports = tfn;
