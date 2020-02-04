# Turbot Fn

# Release History

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
