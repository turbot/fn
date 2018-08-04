const assert = require("chai").assert;

const tfn = require("..");

describe("@turbot/fn", function() {
  it("has turbot variable", function(done) {
    const wrappedFn = tfn(turbot => (event, context, callback) => {
      assert.exists(turbot);
      assert.isFunction(turbot.ok);
      assert.isFunction(turbot.resource.create);
      done();
    });
    wrappedFn({}, {}, (err, ignore) => {});
  });
});
