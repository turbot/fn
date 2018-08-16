const CACHE_DELETE_EXPIRED_INTERVAL = 4 * 60 * 60 * 1000;
const CACHE_DEFAULT_EXPIRY = 3600000;

let CACHE = {};
let CACHE_EXPIRES = Date.now() + CACHE_DELETE_EXPIRED_INTERVAL;

// Has {key} expired?
const expired = function(key) {
  if (!CACHE[key]) {
    return true;
  }
  return Date.now() > (CACHE[key].expires || 0);
};

/**
 * Get {key}, but only if it hasn't expired.
 *
 * @param {string} key Key for the cache item.
 */
const get = function(key) {
  if (!CACHE[key]) {
    return undefined;
  }
  if (expired(key)) {
    // If there's a refresh function, be optimistic and return the original cached
    // value. At the same time start the refresh function to update the cache data.
    if (CACHE[key].refreshFunc) {
      CACHE[key].refreshFunc(key, (err, data) => {
        if (err) {
          // TODO: Where to log the error??
          del(key);
          return;
        }
        CACHE[key].value = data;
        CACHE[key].expires = Date.now() + CACHE[key].ttl;
      });
      return CACHE[key].value;
    }
    del(key);
    return undefined;
  }
  return CACHE[key].value;
};

/**
 * Put {key} with {value}, setting expiration in ttl milliseconds from now.
 *
 * TODO: should we have a TTL for the background refresh function?
 *
 * @param {string} key Cache key
 * @param {object} value The data to cache.
 * @param {number} ttl Time-to-live in milliseconds.
 * @param {function} refreshFunc Refresh function that will be called when the ttl has expired. If no refresh function specified the data will simply be deleted.
 */
const put = function(key, value, ttl, refreshFunc) {
  if (ttl && typeof ttl === "function") {
    refreshFunc = ttl;
    ttl = CACHE_DEFAULT_EXPIRY;
  }

  if (!ttl) ttl = CACHE_DEFAULT_EXPIRY;

  // Put this value in the cache
  CACHE[key] = {
    value: value,
    expires: Date.now() + ttl,
    refreshFunc: refreshFunc,
    ttl: ttl
  };
  // If we are due for our periodic cleanup of expired values, then do it.
  let now = Date.now();
  if (now > CACHE_EXPIRES) {
    delExpired();
    CACHE_EXPIRES = now + CACHE_DELETE_EXPIRED_INTERVAL;
  }
  return value;
};

/**
 * Delete {key} from the cache. Return an integer count of the number of items
 * that were deleted (0 or 1).
 * @param {string} key Key to delete
 * @returns {number} Count of the number of items that were deleted (0 or 1).
 */
const del = function(key) {
  let count = 0;
  if (CACHE[key]) {
    count++;
  }
  delete CACHE[key];
  return count;
};

/**
 * Delete or refresh all expired items from the cache.
 *
 * @returns {number} count of the number of items that has expired.
 */
const delExpired = function() {
  let count = 0;
  for (let k in CACHE) {
    if (!expired(k)) {
      continue;
    }
    if (CACHE[k].refreshFunc) {
      CACHE[k].refreshFunc(k, (err, data) => {
        if (err) {
          // TODO: where to log the error?
          del(k);
          return;
        }
        CACHE[k].value = data;
        CACHE[k].expires = Date.now() + CACHE[k].ttl;
      });
    } else {
      del(k);
    }
    count++;
  }
  return count;
};

// Delete everything from the cache. Return an integer count of the number of
// items that were deleted.
const flush = function() {
  let count = Object.keys(CACHE).length;
  CACHE = {};
  return count;
};

module.exports = {
  get: get,
  put: put,
  del: del,
  expired: expired,
  delExpired: delExpired,
  flush: flush
};
