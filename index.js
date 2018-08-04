const { Turbot } = require("@turbot/sdk");

const initialize = (event, context, callback) => {
  const turbot = new Turbot({});
  process.env.TURBOT = true;
  callback(null, { turbot });
};

const finalize = (event, context, init, err, result, callback) => {
  console.log("TODO - publish Turbot commands:");
  console.log(err || result);
  callback(err, result);
};

module.exports = turbotWrappedHandler => {
  return (event, context, callback) => {
    initialize(event, context, (err, init) => {
      if (err) return callback(err);
      const turbot = init.turbot;
      const handler = turbotWrappedHandler(turbot);
      handler(event, context, (err, result) => {
        finalize(event, context, init, err, result, callback);
      });
    });
  };
};
