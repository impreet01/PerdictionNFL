/**
 * Promise caching utilities
 * Extracted from train_multi.js to reduce duplication
 */

/**
 * Cache a promise factory to avoid redundant async operations
 *
 * @param {Map} cache - Map to store cached promises
 * @param {string|number} key - Cache key
 * @param {Function} factory - Async factory function to generate value
 * @returns {Promise} Cached or new promise
 */
export function cachePromise(cache, key, factory) {
  if (cache.has(key)) {
    return cache.get(key);
  }

  const promise = Promise.resolve()
    .then(factory)
    .then(
      (value) => {
        cache.set(key, Promise.resolve(value));
        return value;
      },
      (err) => {
        cache.delete(key);
        throw err;
      }
    );

  cache.set(key, promise);
  return promise;
}

/**
 * Create a concurrency limiter for async operations
 *
 * @param {number} maxConcurrent - Maximum concurrent operations
 * @returns {Function} Limiter function
 */
export function createLimiter(maxConcurrent) {
  let running = 0;
  const queue = [];

  function dequeue() {
    if (queue.length === 0 || running >= maxConcurrent) return;
    running += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running -= 1;
        dequeue();
      });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      dequeue();
    });
  };
}
