# Turbot Fn

# Release History

## 5.24.0 [2024-09-10]

- Updated: @turbot/aws-sdk to 5.23.0.

## 5.23.0 [2024-05-22]

- Updated: @turbot/aws-sdk to 5.14.0.

## 5.22.0 [2024-05-07]

- Updated: @turbot/sdk to 5.15.0.

## 5.21.0 [2023-12-06]

- Updated: @turbot/aws-sdk to 5.13.0.

## 5.20.0 [2023-11-21]

- Updated: @turbot/utils to 5.6.0. @turbot/log to 5.5.0. @turbot/aws-sdk to 5.12.0. @turbot/sdk to 5.14.0. @turbot/errors to 5.3.0. url to 0.11.1. chai to 4.3.10.

## 5.19.1 [2022-07-06]

- Updated: log Tenant, Process ID and Resource ID information when available.

## 5.19.0 [2022-06-22]

- Updated: @turbot/utils to 5.5.0. @turbot/log to 5.4.0. @turbot/aws-sdk to 5.11.0. @turbot/sdk to 5.13.0.

## 5.18.0 [2022-04-07]

- Updated: @turbot/aws-sdk to 5.10.0.

## 5.17.0 [2022-04-04]

- Updated: @turbot/aws-sdk to 5.9.0.
- Fixed: stop using global variable to instantiate AWS SNS parameter.

## 5.16.4 [2022-02-27]

- Updated: reduced max retry for SNS message sending to 4 (from 10).

## 5.16.3 [2022-02-27]

- Updated: increase max retry for message sending to SNS.
- Fixed: failure to send the final message to SNS is silently ignored. fn should return the error so Lambda does its 2 retries and the control will eventually end in DLQ if the message sending continue to fail during the retries.

## 5.16.2 [2021-08-16]

- Updated: @turbot/sdk to 5.12.0.

## 5.16.1 [2021-06-15]

- Updated: @turbot/sdk to 5.11.0.

## 5.16.0 [2021-06-07]

- Updated: @turbot/aws-sdk to 5.8.0. @turbot/errors to 5.2.0. @turbot/log to 5.3.0. @turbot/sdk to 5.10.0. @turbot/utils to 5.3.0. archiver to 5.3.0. fs-extra to 10.0.0.

## 5.15.3 [2021-05-20]

- Fixed: zipping large command may be completed before we register the callback function, the impact is that the zip file may not be created.

## 5.15.2 [2021-05-13]

- Updated: @turbot/aws-sdk to 5.7.0.

## 5.15.1 [2021-03-17]

- Updated: @turbot/aws-sdk to 5.6.0.

## 5.15.0 [2021-03-16]

- Added: check for TURBOT_TMP_DIR env variable to determine where is the temporary directory is.

## 5.14.3 [2021-02-18]

- Updated: sns-validator (git source) to @vhadianto/sns-validator (published in npm).

## 5.14.2 [2020-12-01]

- Updated: @turbot/sdk to 5.9.0

## 5.14.1 [2020-11-24]

- Updated: @turbot/sdk to 5.8.0

## 5.14.0 [2020-10-30]

- Added: ability to decrypt control container parameter.
- Fixed: error from running container are not caught properly.

## 5.13.3 [2020-10-28]

- Fixed: saving large command is not completing successfully.

## 5.13.2 [2020-10-22]

- Fixed: nothing should be added to the cargo after the cargo has been streamed to S3 if it's larger than maximum SQS payload. Adding data into the cargo post this processing can trip the size over the limit and will result in an error in Turbot.

## 5.13.1 [2020-09-09]

- Updated: bl to 4.0.3.
- Fixed: removed stray debug logs.

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
