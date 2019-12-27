const chai = require("chai");
const { assert, expect } = chai;
// This causes circular dependencies. Remove reference to sdk-test for now
chai.use(require("@turbot/sdk-test").plugin);

const tfn = require("..");

describe("@turbot/fn", function() {
  before(function() {
    process.env.TURBOT_TEST = true;
  });
  after(function() {
    delete process.env.TURBOT_TEST;
  });
  it("has turbot variable", function(done) {
    const wrappedFn = tfn(turbot => (event, z, callback) => {
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
