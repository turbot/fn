const assert = require("chai").assert;
const gcmc = require("../gcmc");
const sinon = require("sinon");

const TESTS = [
  { key: "strings", value: "my-value" },
  { key: "integer", value: 123 },
  { key: "zero", value: 0 },
  { key: "null", value: null }
];

describe("@turbot/garbage-collected-memory-cache", function() {
  TESTS.forEach(test => {
    describe(test.key, function() {
      it("get() is undefined before put()", function() {
        assert.notExists(gcmc.get(test.key));
      });
      it("put() returns value", function() {
        assert.deepEqual(gcmc.put(test.key, test.value), test.value);
      });
      it("get() returns value after put()", function() {
        assert.deepEqual(gcmc.get(test.key), test.value);
      });
      it("del() existing key returns count of 1", function() {
        assert.equal(gcmc.del(test.key), 1);
      });
      it("get() is undefined after del()", function() {
        assert.notExists(gcmc.get(test.key));
      });
    });
  });

  describe("Key expiration", function() {
    let clock;

    before(function() {
      clock = sinon.useFakeTimers();
      gcmc.put("expire @ 50ms", true, 50);
      gcmc.put("expire @ 500ms", true, 500);
    });

    after(function() {
      clock.restore();
    });

    describe("@ 0ms", function() {
      it("50ms key exists", function() {
        assert.exists(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 1ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key exists", function() {
        assert.exists(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 49ms", function() {
      before(function() {
        clock.tick(48);
      });

      it("50ms key exists", function() {
        assert.exists(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 50ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key exists", function() {
        assert.exists(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 51ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key does not exist", function() {
        assert.isUndefined(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 499ms", function() {
      before(function() {
        clock.tick(448);
      });

      it("50ms key does not exist", function() {
        assert.isUndefined(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 500ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key does not exist", function() {
        assert.isUndefined(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 501ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key does not exist", function() {
        assert.isUndefined(gcmc.get("expire @ 50ms"));
      });

      it("500ms key does not exist", function() {
        assert.isUndefined(gcmc.get("expire @ 500ms"));
      });
    });
  });

  describe("Refresh function", function() {
    let clock;

    before(function() {
      clock = sinon.useFakeTimers();
      gcmc.put("expire @ 50ms", true, 50, (k, callback) => {
        callback(null, false);
      });
      gcmc.put("expire @ 500ms", true, 500, (k, callback) => {
        callback(null, "Hello World");
      });
      gcmc.put("expire @ default ms", true, (k, callback) => {
        callback(null, "World Hello");
      });
    });

    after(function() {
      clock.restore();
    });

    describe("@ 1ms", function() {
      before(function() {
        clock.tick(1);
      });

      it("50ms key exists", function() {
        assert.exists(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });

      it("default ms key exists", function() {
        assert.exists(gcmc.get("expire @ default ms"));
      });
    });

    describe("@ 51ms", function() {
      before(function() {
        clock.tick(50);
      });

      it("50ms key has changed to false", function() {
        assert.isFalse(gcmc.get("expire @ 50ms"));
      });

      it("500ms key exists", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 501", function() {
      before(function() {
        clock.tick(450);
      });

      it("50ms key has changed to false", function() {
        assert.isFalse(gcmc.get("expire @ 50ms"));
      });

      it("500ms key although it has expired we still get it and get the background refresh function to run", function() {
        assert.exists(gcmc.get("expire @ 500ms"));
      });
    });

    describe("@ 505", function() {
      before(function() {
        clock.tick(4);
      });

      it("50ms key has changed to false", function() {
        assert.isFalse(gcmc.get("expire @ 50ms"));
      });

      it("500ms key changed to Hello World", function() {
        assert.equal("Hello World", gcmc.get("expire @ 500ms"));
      });
    });
  });

  xdescribe("TODO", function() {
    it("Should cached objects be modifiable or frozen?", function() {});
  });
});
