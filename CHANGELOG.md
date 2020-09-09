# Turbot Fn

# Release History

## 5.14.0 [tbd]

- Updated: Removed stray debug commands.

## 5.13.0 [2020-07-30]

- Updated: @turbot/aws-sdk to 5.5.0. @turbot/errors to 5.1.0. @turbot/log to 5.2.0. @turbot/sdk to 5.7.0 @turbot/utils to 5.2.0. async to ^3.2.0. lodash to ^4.17.19.

## 5.12.0 [2020-07-30]

- Updated: @turbot/sdk to 5.5.0, archiver to 5.0.0, lodash to 4.17.19.

## 5.11.1 [2020-07-10]

- Fixed: wrapper function should look for the partition in `$.item.metadata.aws.partition` then fall back to `$.item.turbot.custom.aws.partition`

## 5.11.0 [2020-06-22]

- Updated: @turbot/aws-sdk to 5.4.0, @turbot/sdk to 5.5.0, archiver to 4.0.1, extract-zip to 2.0.1, fs-extra to 9.0.1, eslint to 7.3.0 and eslint-plugin-prettier to 3.1.4

## 5.10.1 [2020-06-12]

- Fixed: wrapper for container task should handle error gracefully.

## 5.10.0 [2020-06-03]

- Added: support for running Mod runnable where the AWS account is imported using access key pair instead of IAM role (generates different temporary credentials format).
- Updated: fs-extra to 9.0.0, rimraf to 3.0.2, tmp to 0.2.1.
- Fixed: container run should not continue until we finish retrieving the container metadata.

## 5.9.0 [2020-04-30]

- Updated: @turbot/aws-sdk to 5.3.0, @turbot/log to 5.1.0, @turbot/sdk to 5.4.0, @turbot/utils to 5.1.0, async to 3.2.0, request to 2.88.2, various dev dependencies.

## 5.8.0 [2020-04-20]

- Updated: `@turbot/sdk` to 5.3.0.

## 5.7.0 [2020-04-17]

- Updated: removed AWS unhandledRejection handler to allow @turbot/fn handling Unhandled Rejection error.

## 5.6.1 [2020-04-03]

- Fixed: modify extract to use promise, the callback feature was removed in extract-zip 2.0.

## 5.6.0 [2020-03-31]

- Updated: @turbot/aws-sdk to 5.2.0.
- Updated: dev dependencies.

## 5.5.0 [2020-03-13]

- Updated: @turbot/sdk to 5.2.1 from 5.1.2.

## 5.4.0 [2020-03-04]

- Updated: removed initial SNS's get attributes to instantiate SNS object. However, maintain the old logic for Fargate launch type backward compatibility. This code should be removed after all environments have been migrated to ECS EC2 launch type.
- Updated: sns-validator dependency to fully specify external repo dependency.

## 5.3.0 [2020-02-21]

- Updated: @turbot/aws-sdk to 5.1.0.

## 5.2.3 [2020-02-05]

- Updated: @turbot/aws-sdk to 5.0.8, @turbot/log to 5.0.5, @turbot/sdk to 5.1.2, @turbot/utils 5.0.6.
- Fixed: Guess region setting from both custom and metadata attribute of TurbotData.

## 5.2.2 [2020-02-04]

Re-release of 5.2.1 due to error in npm publishing.

## 5.2.1 [2020-02-04]

- Updated: @turbot/sdk to 5.1.1.
- Fixed: Test mode not raising the correct action_update, control_update and policy_update commands.

## 5.2.0 [2020-01-20]

- Updated: @turbot/sdk to 5.1.0.

## 5.1.0 [2020-01-20]

- Updated: @turbot/utils to 5.0.5.
- Updated: @turbot/sdk to 5.0.2.
- Updated: sns-validator with a forked version to replace https with request package to respect proxy setting.

## 5.0.2 [2019-12-28]

- Updated: @turbot/aws-sdk to 5.0.6, @turbot/errors to 5.0.5 and @turbot/log to 5.0.4.

## 5.0.1 [2019-12-27]

- Updated: @turbot/utils to 5.0.4 and @turbot/sdk to 5.0.1.

## 5.0.0

Initial 5.0.0 release.

## 5.0.0-beta.11 [2019-12-05]

- Fixed: removed unnecessary initial message send from the Lambda function.

## 5.0.0-beta.10 [2019-11-18]

- Updated: dependencies.

## 5.0.0-beta.9 [2019-10-10]

- Updated: @turbot/sdk to 5.0.0-beta.4.

## 5.0.0-beta.8 [2019-10-09]

- Updated: non live operation shouldn't stream large data, instead collect them all and zip as "large commands" instead.

## 5.0.0-beta.7 [2019-10-04]

- Fixed: last message sent twice causing a warning on the server side.

## 5.0.0-beta.6 [2019-10-01]

- Fixed: non fatal error is not retried in Lambda.

## 5.0.0-beta.5 [2019-09-25]

- Updated: look for AWS credentials in organization, then organizationalUnit and then account.

## 5.0.0-beta.4 [2019-08-20]

- Updated: prefer meta.runType rather than TURBOT_FUNCTION_TYPE. TURBOT_FUNCTION_TYPE still exist for backward compatibility.

## 5.0.0-beta.3 [2019-08-13]

- Added: large parameter support.

## 5.0.0-beta.1 [2019-07-10]

- Initial beta release.
