// A clock the tests drive: Date.now, setTimeout/clearTimeout and
// setInterval/clearInterval run on fake time, advanced with clock.advance(ms).
// Not a test file: tests import it.

/**
 * @param {number} startMs the fake Date.now() to begin with
 * @returns {{now: () => number, advance: (ms: number) => Promise<void>, pending: () => number, restore: () => void}}
 */
export function installClock(startMs) {
  const real = {
    now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  };
  let now = startMs;
  let nextId = 1;
  const timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn: () => fn(...args), every: 0 });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.setInterval = (fn, ms = 0, ...args) => {
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: now + every, fn: () => fn(...args), every });
    return id;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    /** Move time on, running every timer that falls due, in order (and the promises they start). */
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
    /** Timers still waiting. */
    pending: () => timers.size,
    restore() {
      Date.now = real.now;
      Object.assign(globalThis, {
        setTimeout: real.setTimeout, clearTimeout: real.clearTimeout,
        setInterval: real.setInterval, clearInterval: real.clearInterval,
      });
    },
  };
}
