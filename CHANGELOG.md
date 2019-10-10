# Turbot Fn

# Release History

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
