const chai = require("chai");
const { assert, expect } = chai;
chai.use(require("@turbot/sdk-test").plugin);

const tfn = require("..");

describe("@turbot/fn", function() {
  it("has turbot variable", function(done) {
    const wrappedFn = tfn(turbot => (event, context, callback) => {
      assert.exists(turbot);
      assert.isFunction(turbot.ok);
      assert.isFunction(turbot.resource.create);
      callback(null, true);
    });
    wrappedFn({}, {}, done);
  });

  it("turbot.ok works", function(done) {
    const wrappedFn = tfn(turbot => (event, context, callback) => {
      turbot.ok();
      expect(turbot).to.be.ok;
      expect(turbot).to.not.be.alarm;
      callback(null, true);
    });
    wrappedFn({}, {}, done);
  });
});
