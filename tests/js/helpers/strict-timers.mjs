// Timer stand-ins as strict as a browser's. A browser throws "Illegal invocation" at clearTimeout
// called as someone else's method, and Node does not mind, so a bug like that would pass every test
// here without these. Not a test file: helpers and tests import it.

/** A function that refuses to be called on anything but the global object, as the browser's timers do. */
export function strict(fn) {
  return function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return fn(...args);
  };
}

/** Make these timer functions, as they stand on the global object, that strict. */
export function makeStrict(names) {
  for (const name of names) globalThis[name] = strict(globalThis[name]);
}
