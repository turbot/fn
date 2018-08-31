const _ = require("lodash");
const { Turbot } = require("@turbot/sdk");
const taws = require("@turbot/aws-sdk");
const log = require("@turbot/log");

/***
 * Action pattern: https://github.com/redux-utilities/flux-standard-action
 *
 * LOGGING -> turbot.log/turbot.debug -> we no longer send to redis
 * we should only send to redis when we're in debug mode and we're watching
 * the log
 *
 */

const initialize = (event, context, callback) => {
  log.debug("Received event", { event: event, context: context });

  const eventRecords = _.get(event, "Records");
  if (!Array.isArray(eventRecords) || eventRecords.length == 0) {
    log.debug("event.Records is not an array or empty, creating a Turbot object with no metadata");
    const turbot = new Turbot({});
    turbot.$ = {};
    return callback(null, { turbot });
  }

  const message = event.Records[0].Sns.Message;
  if (_.isEmpty(message)) {
    log.debug("SNS message is empty, creating a Turbot object with no metadata");
    const turbot = new Turbot({});
    turbot.$ = {};
    return callback(null, { turbot });
  }

  const msgObj = JSON.parse(message);

  const turbot = new Turbot(msgObj.payload.input.turbotMetadata);

  // Convenient access
  turbot.$ = msgObj.payload.input;

  const contextRegion = _.get(turbot.$, "region.Aws.RegionName");
  const contextAccount = _.get(turbot.$, "region.Aws.AccountId");

  // Store the credentials we receive in the SNS message in the environment variable
  // this is a convenience for the mod developers so they can just use our
  // aws-sdk without worrying the credentials. We automatically set the
  // the credentials in @turbot/aws-sdk
  process.env.TURBOT_CONTROL_AWS_CREDENTIALS = JSON.stringify(msgObj.meta.awsCredentials);
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
  if (process.env.TURBOT_CLI_LAMBDA_TEST_MODE === "true") {
    result = {
      result,
      turbot: init.turbot
    };
  }

  // We're back in the current Turbot context for the lamdba execution, so we don't want
  // to use the credentials that we get from the SNS message
  delete process.env.TURBOT_CONTROL_AWS_CREDENTIALS;
  delete process.env.TURBOT_CONTROL_AWS_REGION;
  delete process.env.TURBOT_CONTROL_AWS_ACCOUNT_ID;

  const processEvent = init.turbot.asProcessEvent();

  const params = {
    Message: JSON.stringify(processEvent),
    MessageAttributes: {}
  };

  // Do not republish to SNS is we're in test mode
  if (process.env.TURBOT_TEST) {
    return callback(null, processEvent);
  }

  // TURBOT_EVENT_SNS_ARN should be set as part of lambda installation
  params.TopicArn = process.env.TURBOT_EVENT_SNS_ARN;

  log.debug("Publishing to sns with params", { params });

  const sns = new taws.connect("SNS");
  sns.publish(params, (err, publishResult) => {
    if (err) {
      log.error("Error publishing commands to SNS", { error: err });
      return callback(err);
    }
    return callback(null, publishResult);
  });
};

module.exports = turbotWrappedHandler => {
  return (event, context, callback) => {
    initialize(event, context, (err, init) => {
      if (err) return callback(err);

      const turbot = init.turbot;
      const handler = turbotWrappedHandler(turbot);
      try {
        handler(event, context, (err, result) => {
          finalize(event, context, init, err, result, callback);
        });
      } catch (err) {
        log.error("Exception while executing the handler", { error: err, event, context });
        finalize(event, context, init, err, null, callback);
      }
    });
  };
};
