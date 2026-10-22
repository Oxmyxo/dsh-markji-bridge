// dsh-markji-bridge: rate limiter unit tests. No real sleeps; now/sleep are injected.

import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, DEFAULT_LIMITS } from "../lib/rate-limit.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}

function fakeClock(start = 0) {
  let current = start;
  let active = 0;
  let maxActive = 0;
  const sleeps = [];
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    sleep(ms) {
      active += 1;
      if (active > maxActive) maxActive = active;
      return new Promise((resolve) => {
        sleeps.push({
          ms,
          deadline: current + ms,
          release: () => {
            active -= 1;
            resolve();
          },
        });
      });
    },
    sleeps,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    async releaseNext() {
      const next = sleeps.shift();
      if (!next) throw new Error("no pending sleep");
      if (next.deadline > current) current = next.deadline;
      next.release();
      await settle();
      return next.ms;
    },
  };
}

function makeLimiter(limits, start = 0) {
  const clock = fakeClock(start);
  const logs = [];
  const limiter = createLimiter({
    limits,
    now: clock.now,
    sleep: clock.sleep,
    log: (level, message) => logs.push({ level, message }),
  });
  return { clock, limiter, logs };
}

test("DEFAULT_LIMITS match the contract", () => {
  assert.deepEqual(DEFAULT_LIMITS, [
    { windowMs: 10000, max: 18 },
    { windowMs: 60000, max: 36 },
    { windowMs: 18000000, max: 7800 },
  ]);
});

test("records usage and estimates the wait before the next acquire", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 2 }]);
  await limiter.acquire();
  let snap = limiter.snapshot();
  assert.deepEqual(snap.used, [1]);
  assert.equal(snap.waitMs, 0);
  assert.deepEqual(snap.limits, [{ windowMs: 1000, max: 2 }]);

  clock.advance(100);
  await limiter.acquire();
  snap = limiter.snapshot();
  assert.deepEqual(snap.used, [2]);
  // Both entries sit in [0, 1000); the oldest leaves the window at now=1000.
  assert.equal(snap.waitMs, 900);
});

test("prunes entries that fall out of the window", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 2 }]);
  await limiter.acquire();
  await limiter.acquire();
  clock.advance(1000);
  const snap = limiter.snapshot();
  assert.deepEqual(snap.used, [0]);
  assert.equal(snap.waitMs, 0);
});

test("third acquire sleeps until the oldest entry leaves the window", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 2 }]);
  await limiter.acquire();
  assert.equal(clock.sleeps.length, 0);
  await limiter.acquire();
  assert.equal(clock.sleeps.length, 0);

  const pending = limiter.acquire();
  assert.equal(clock.sleeps.length, 1);
  assert.equal(clock.sleeps[0].ms, 1000);
  assert.equal(clock.active, 1);
  assert.equal(limiter.snapshot().waitMs, 1000);

  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  await settle();
  assert.equal(resolved, false);

  await clock.releaseNext();
  await pending;
  assert.equal(resolved, true);
  const snap = limiter.snapshot();
  assert.deepEqual(snap.used, [1]);
  assert.equal(snap.waitMs, 0);
  assert.equal(clock.maxActive, 1, "only one sleep timer may be active at a time");
});

test("queues waiters FIFO behind a single timer", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 100, max: 1 }]);
  await limiter.acquire();
  const order = [];
  limiter.acquire().then(() => order.push(2));
  limiter.acquire().then(() => order.push(3));
  await settle();
  assert.equal(clock.sleeps.length, 1);
  assert.equal(clock.maxActive, 1);

  await clock.releaseNext();
  assert.deepEqual(order, [2]);
  assert.equal(clock.sleeps.length, 1, "the next waiter starts its own timer after FIFO handoff");

  await clock.releaseNext();
  assert.deepEqual(order, [2, 3]);
});

test("uses the strictest window when several limits apply", async () => {
  const { clock, limiter } = makeLimiter([
    { windowMs: 1000, max: 5 },
    { windowMs: 100, max: 1 },
  ]);
  await limiter.acquire();
  clock.advance(10);
  const pending = limiter.acquire();
  assert.equal(clock.sleeps.length, 1);
  assert.equal(clock.sleeps[0].ms, 90);
  await clock.releaseNext();
  await pending;
});

test("long window gates when short windows still have headroom", async () => {
  const { clock, limiter } = makeLimiter([
    { windowMs: 10000, max: 1 },
    { windowMs: 20000, max: 5 },
  ]);
  await limiter.acquire();
  const pending = limiter.acquire();
  assert.equal(clock.sleeps[0].ms, 10000);
  await clock.releaseNext();
  await pending;
});

test("lets a full burst through without any timer", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 3 }]);
  const order = [];
  [1, 2, 3].forEach((i) => limiter.acquire().then(() => order.push(i)));
  await settle();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(clock.sleeps.length, 0);

  const fourth = limiter.acquire();
  assert.equal(clock.sleeps.length, 1);
  assert.equal(clock.sleeps[0].ms, 1000);
  await clock.releaseNext();
  await fourth;
});

test("snapshot does not consume capacity", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 1 }]);
  for (let i = 0; i < 5; i++) limiter.snapshot();
  assert.equal(clock.sleeps.length, 0);
  await limiter.acquire();
  assert.deepEqual(limiter.snapshot().used, [1]);
});

test("reset clears recorded usage and wakes a pending waiter", async () => {
  const { clock, limiter } = makeLimiter([{ windowMs: 1000, max: 1 }]);
  await limiter.acquire();
  const pending = limiter.acquire();
  assert.equal(clock.sleeps.length, 1);

  limiter.reset();
  await pending;
  const snap = limiter.snapshot();
  assert.deepEqual(snap.used, [1], "the woken waiter records its own timestamp");
  assert.equal(snap.waitMs, 1000, "the freshly recorded token fills the window again");
});

test("logs when acquire has to wait", async () => {
  const { clock, limiter, logs } = makeLimiter([{ windowMs: 1000, max: 1 }]);
  await limiter.acquire();
  const pending = limiter.acquire();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "debug");
  assert.match(logs[0].message, /waiting 1000ms/);
  await clock.releaseNext();
  await pending;
});

test("falls back to DEFAULT_LIMITS for empty or invalid limits", async () => {
  for (const limits of [[], [{ windowMs: -1, max: 2 }], [{ windowMs: 1000, max: 0 }], null]) {
    const clock = fakeClock();
    const limiter = createLimiter({ limits, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(limiter.snapshot().limits, DEFAULT_LIMITS);
  }
});

test("works with the real clock for an immediate acquire", async () => {
  const limiter = createLimiter({ limits: [{ windowMs: 50, max: 5 }] });
  await limiter.acquire();
  const snap = limiter.snapshot();
  assert.deepEqual(snap.used, [1]);
  assert.equal(snap.waitMs, 0);
});
