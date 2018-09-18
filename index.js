const _ = require("lodash");
const { Turbot } = require("@turbot/sdk");
const errors = require("@turbot/errors");
const log = require("@turbot/log");
const taws = require("@turbot/aws-sdk");

const initialize = (event, context, callback) => {
  // When in "turbot test" the lambda is being initiated directly, not via
  // SNS. In this case we short cut all of the extraction of credentials etc,
  // and just run directly with the input passed in the event.
  if (process.env.TURBOT_TEST) {
    // In test mode there is no metadata (e.g. AWS credentials) for Turbot,
    // they are all inherited from the underlying development environment.
    const turbot = new Turbot({});
    turbot.event = event;
    turbot.context = context;
    // In test mode, the event is the actual input (no SNS wrapper).
    return callback(null, { turbot, $: event });
  }

  // PRE: Running in normal mode, so event should have been received via SNS.

  // SNS sends a single record at a time to Lambda.
  const msg = _.get(event, "Records[0].Sns.Message");
  if (!msg) {
    return callback(
      errors.badRequest("Turbot controls should be called via SNS, or with TURBOT_TEST set to true", { event, context })
    );
  }

  let msgObj;

  try {
    msgObj = JSON.parse(msg);
    log.debug("Parsed message content", JSON.stringify(msgObj));
  } catch (e) {
    return callback(errors.badRequest("Invalid input data", { event, error: e }));
  }

  const turbot = new Turbot(msgObj.payload.input.turbotMetadata);

  // Convenient access
  turbot.$ = msgObj.payload.input;

  const contextRegion = _.get(turbot.$, "region.Aws.RegionName");
  const contextAccount = _.get(turbot.$, "region.Aws.AccountId");

  // Store the credentials we receive in the SNS message in the environment variable
  // this is a convenience for the mod developers so they can just use our
  // aws-sdk without worrying the credentials. We automatically set the
  // the credentials in @turbot/aws-sdk

  if (msgObj.meta.awsCredentials) {
    log.debug("Setting AWS Credentials", { awsCredentials: msgObj.meta.awsCredentials });
    process.env.TURBOT_CONTROL_AWS_CREDENTIALS = JSON.stringify(msgObj.meta.awsCredentials);
  }
  process.env.TURBOT = true;

  if (contextRegion) {
    // TODO: do we want to set it to AWS_REGION or even AWS_DEFAULT_REGION?
    // I'm not sure because we want to set it during the execution of the Mod's lambda function
    // but at the end we want to delete these two env variables and revert to the native region & role
    // of the lambda, which could be running in a completely different region to where the contextRegion is.
    // For example this lambda is running in ap-southeast-2 but looking for items in us-east-1, it's possible.
    process.env.TURBOT_CONTROL_AWS_REGION = contextRegion;
  }

  if (contextAccount) {
    process.env.TURBOT_CONTROL_AWS_ACCOUNT_ID = contextAccount;
  }

  callback(null, { turbot });
};

const finalize = (event, context, init, err, result, callback) => {
  const processEvent = init.turbot.asProcessEvent();

  // If in test mode, then do not publish to SNS. Instead, morph the response to
  // include both the turbot information and the raw result so they can be used
  // for assertions.
  if (process.env.TURBOT_TEST) {
    return callback(null, { turbot: processEvent, result });
  }

  // We're back in the current Turbot context for the lamdba execution, so we don't want
  // to use the credentials that we get from the SNS message
  delete process.env.TURBOT_CONTROL_AWS_CREDENTIALS;
  delete process.env.TURBOT_CONTROL_AWS_REGION;
  delete process.env.TURBOT_CONTROL_AWS_ACCOUNT_ID;

  const params = {
    Message: JSON.stringify(processEvent),
    MessageAttributes: {}
  };

  // TURBOT_EVENT_SNS_ARN should be set as part of lambda installation
  params.TopicArn = process.env.TURBOT_EVENT_SNS_ARN;

  log.debug("Publishing to sns with params", { params });

  if (process.env.TURBOT_CLI_LAMBDA_TEST_MODE) {
    return callback(null, false);
  }

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
        handlerCallback(init.turbot, init.$, (err, result) => {
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
