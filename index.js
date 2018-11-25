const _ = require("lodash");
const { Turbot } = require("@turbot/sdk");
const errors = require("@turbot/errors");
const log = require("@turbot/log");
const taws = require("@turbot/aws-sdk");

const MessageValidator = require("sns-validator");
const validator = new MessageValidator();

let cachedCredentials = new Map();
let cachedRegions = new Map();

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
    // console.log("Get credentials from the parameters", credentials);

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

  // console.log("Received region:", region);

  if (region) {
    for (const [key, envVar] of regionEnvMapping.entries()) {
      // cache current value
      if (process.env[envVar]) {
        cachedRegions.set(envVar, process.env[envVar]);
      }

      // set env var to region
      process.env[envVar] = region;
    }
  }

  // console.log("After caching the credentials", { credentials, cachedCredentials });
};

const restoreCachedAWSEnvVars = () => {
  console.log("Restoring cached env vars");

  if (cachedCredentials.size > 0) {
    for (const [key, envVar] of credentialEnvMapping.entries()) {
      if (process.env[envVar]) {
        delete process.env[envVar];
      }
    }
    for (const [envVar, value] of cachedCredentials.entries()) {
      process.env[envVar] = value;
    }
  }

  if (cachedRegions.size > 0) {
    for (const [key, envVar] of regionEnvMapping.entries()) {
      if (process.env[envVar]) {
        delete process.env[envVar];
      }
    }
    for (const [envVar, value] of cachedRegions.entries()) {
      process.env[envVar] = value;
    }
  }
};

// This is the region where the lambda is executing
let lambdaRegion;
const initialize = (event, context, callback) => {
  console.log("RAW MESSAGE:", { event, context });

  // I think this is better than messing about the AWS_REGION which seems to be overriden
  // all the time
  const arnList = context.invokedFunctionArn.split(":");
  lambdaRegion = arnList[3]; //region is the fourth element in a lambda function arn

  console.log("Setting lambda region to: ", lambdaRegion);

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
    const turbot = new Turbot({}, turbotOpts);
    // In test mode, the event is the actual input (no SNS wrapper).
    turbot.$ = event;
    // set the AWS credentials and region env vars using the values passed in the control input
    setAWSEnvVars(turbot.$);
    return callback(null, { turbot });
  }

  // PRE: Running in normal mode, so event should have been received via SNS.

  // SNS sends a single record at a time to Lambda.
  const rawMessage = _.get(event, "Records[0].Sns.Message");
  if (!rawMessage) {
    return callback(
      errors.badRequest("Turbot controls should be called via SNS, or with TURBOT_TEST set to true", { event, context })
    );
  }

  return validator.validate(event.Records[0].Sns, (err, snsMessage) => {
    if (err) {
      return callback(errors.badRequest("Failed SNS message validation", { error: err }));
    }

    let msgObj;
    try {
      msgObj = JSON.parse(snsMessage.Message);
      log.debug("Parsed message content", JSON.stringify(msgObj));
    } catch (e) {
      return callback(errors.badRequest("Invalid input data", { error: e }));
    }

    // console.log("Creating new Turbot object with meta", { meta: msgObj.meta, turbotOpts });

    const turbot = new Turbot(msgObj.meta, turbotOpts);

    // Convenient access
    turbot.$ = msgObj.payload.input;

    // console.log("Setting turbot.$ to", turbot.$);

    // set the AWS credentials and region env vars using the values passed in the control input
    setAWSEnvVars(turbot.$);

    process.env.TURBOT = true;

    callback(null, { turbot });
  });
};

const finalize = (event, context, init, err, result, callback) => {
  // restore the cached credentials and region values
  restoreCachedAWSEnvVars();

  // log errors to the process log
  if (err) {
    init.turbot.log.error("Error running function", err);

    if (err.fatal) {
      // for a fatal error, set control state to error and return a null error
      // so SNS will think the lambda execution is successful and will not retry
      result = init.turbot.error(err.message, { error: err });
      err = null;
    }
  }

  // get the function result as a process event
  const processEvent = init.turbot.asProcessEvent();

  // If in test mode, then do not publish to SNS. Instead, morph the response to include
  // both the turbot information and the raw result so they can be used for assertions.
  if (process.env.TURBOT_TEST) {
    // include process event with result
    result = { result, turbot: processEvent };
    if (err) {
      // if there is an error, lambda does not return the result, so include it with the error
      // lambda returns a standard error object so to pass a custom object we must stringify
      return callback(JSON.stringify({ err, result }));
    }
    return callback(null, result);
  }

  if (err) {
    return callback(err);
  }

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

  // TURBOT_EVENT_SNS_ARN should be set as part of lambda installation
  const params = {
    Message: JSON.stringify(processEvent),
    MessageAttributes: {},
    TopicArn: process.env.TURBOT_EVENT_SNS_ARN
  };

  // const snsConstrutionParams = { credentials: turbotLambdaCreds, region: lambdaRegion };
  log.debug("Publishing to sns with params", { params });

  //console.log("CLOG Publishing to sns with params", { params, snsConstrutionParams });
  console.log("CLOG Publishing to sns with params", { params });

  const sns = new taws.connect("SNS");
  sns.publish(params, (err, publishResult) => {
    if (err) {
      log.error("Error publishing commands to SNS", { error: err });
      return callback(err);
    }
    return callback(null, publishResult);
  });
};

module.exports = handlerCallback => {
  // Return a function in Lambda signature format, so it can be registered as a
  // handler.
  return (event, context, callback) => {
    // Initialize the Turbot metadata and context, configuring the lambda function
    // for simpler writing and use by mods.
    initialize(event, context, (err, init) => {
      // Errors in the initialization should be returned immediately as errors in
      // the lambda function itself.
      if (err) return callback(err);
      try {
        // Run the handler function. Wrapped in a try block to catch any
        // crashes or unexpected errors.
        handlerCallback(init.turbot, init.turbot.$, (err, result) => {
          // Handler is complete, so finalize the turbot handling.
          finalize(event, context, init, err, result, callback);
        });
      } catch (err) {
        log.error("Exception while executing the handler", { error: err, event, context });
        finalize(event, context, init, err, null, callback);
      }
    });
  };
};
