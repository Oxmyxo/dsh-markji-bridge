// dsh-markji-bridge: token-window rate limiter for the Markji OpenAPI.
// Sliding window per configured limit. acquire() is serialized through one pump:
// a single sleep timer at a time, FIFO waiters, concurrency safe.

export const DEFAULT_LIMITS = [
  { windowMs: 10000, max: 18 },      // provider 20/10s, keep headroom
  { windowMs: 60000, max: 36 },      // provider 40/60s
  { windowMs: 18000000, max: 7800 }, // provider 8000/5h
];

const NOOP = () => {};

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyDefaults() {
  return DEFAULT_LIMITS.map((limit) => ({ windowMs: limit.windowMs, max: limit.max }));
}

// Accept caller limits only when they are usable; otherwise fall back to defaults.
function normalizeLimits(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return copyDefaults();
  const out = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const windowMs = Number(entry.windowMs);
    const max = Math.floor(Number(entry.max));
    if (!Number.isFinite(windowMs) || windowMs <= 0) continue;
    if (!Number.isFinite(max) || max < 1) continue;
    out.push({ windowMs, max });
  }
  return out.length > 0 ? out : copyDefaults();
}

export function createLimiter(options = {}) {
  const limits = normalizeLimits(options.limits);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const log = typeof options.log === "function" ? options.log : NOOP;

  // stamps[i] holds the start timestamps recorded for limits[i], oldest first.
  const stamps = limits.map(() => []);
  const waiters = [];
  let pumping = false;
  // Resolver of the sleep currently held by the pump; reset() wakes it early.
  let wakeSleep = null;

  function prune(ts, windowMs, at) {
    while (ts.length > 0 && at - ts[0] >= windowMs) ts.shift();
  }

  function pruneAll(at) {
    for (let i = 0; i < limits.length; i++) prune(stamps[i], limits[i].windowMs, at);
  }

  // Milliseconds before one more acquire would fit every window at time "at".
  function waitFor(at) {
    let waitMs = 0;
    for (let i = 0; i < limits.length; i++) {
      const { windowMs, max } = limits[i];
      const ts = stamps[i];
      prune(ts, windowMs, at);
      const count = ts.length;
      if (count >= max) {
        // Need count - (max - 1) oldest entries to fall out; the last of those
        // is the one at index count - max, so it gates the next acquire.
        const gate = ts[count - max] + windowMs - at;
        if (gate > waitMs) waitMs = gate;
      }
    }
    return waitMs;
  }

  function record(at) {
    for (let i = 0; i < limits.length; i++) stamps[i].push(at);
  }

  function hold(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (wakeSleep === finish) wakeSleep = null;
        resolve();
      };
      wakeSleep = finish;
      try {
        const result = sleep(ms);
        if (result && typeof result.then === "function") result.then(finish, finish);
        else finish();
      } catch {
        finish();
      }
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiters.length > 0) {
        const waitMs = waitFor(now());
        if (waitMs > 0) {
          const rounded = Math.max(1, Math.ceil(waitMs));
          log("debug", `markji rate-limit waiting ${rounded}ms`);
          await hold(rounded);
          continue;
        }
        record(now());
        const resolve = waiters.shift();
        resolve();
      }
    } finally {
      pumping = false;
    }
  }

  function acquire() {
    return new Promise((resolve) => {
      waiters.push(resolve);
      void pump();
    });
  }

  function snapshot() {
    const at = now();
    pruneAll(at);
    return {
      used: stamps.map((ts) => ts.length),
      limits: limits.map((limit) => ({ windowMs: limit.windowMs, max: limit.max })),
      waitMs: waitFor(at),
    };
  }

  function reset() {
    for (const ts of stamps) ts.length = 0;
    if (wakeSleep) wakeSleep();
  }

  return { acquire, snapshot, reset };
}
