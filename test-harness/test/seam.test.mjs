/**
 * Unit tests for the late-mount seam polling.
 *
 * These exercise the mechanism directly (probe / use / retry), with the fake
 * timer channel the module exposes for exactly this purpose: the production
 * budget is ~10 minutes, so nothing here may wait in real time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollOnBudget, registerSeamWithRetry, whenSeamMounted,
  SEAM_FAST_ATTEMPTS, SEAM_FAST_DELAY_MS, SEAM_SLOW_DELAY_MS,
} from 'dsh-tui-rewrite/seam';

/** A context whose effect scope can be torn down like an activation's. */
function makeContext() {
  const lines = [];
  const stops = [];
  return {
    lines,
    stops,
    logger: {
      info: message => lines.push({ level: 'info', message }),
      warn: message => lines.push({ level: 'warn', message }),
      debug: message => lines.push({ level: 'debug', message }),
    },
    // Cordis runs the effect body immediately and keeps what it RETURNS.
    effect: fn => {
      const disposer = fn();
      if (typeof disposer === 'function') stops.push(disposer);
    },
    /** Fire every registered effect disposer (what an unload does). */
    unload: () => { for (const stop of stops.splice(0)) stop(); },
    warns: () => lines.filter(line => line.level === 'warn').map(line => line.message),
  };
}

/** Deterministic timers: nothing runs until `flush()`. */
function makeTimers() {
  const queue = [];
  return {
    queue,
    schedule: (fn, ms) => { const handle = { fn, ms }; queue.push(handle); return handle; },
    cancel: handle => { const at = queue.indexOf(handle); if (at >= 0) queue.splice(at, 1); },
    /** Run pending timers in order until the queue drains or `limit` steps pass. */
    flush(limit = 10000) {
      let steps = 0;
      while (queue.length > 0 && steps < limit) {
        const handle = queue.shift();
        handle.fn();
        steps += 1;
      }
      return steps;
    },
  };
}

test('a seam that is already mounted is used synchronously, with no poll', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  const used = [];
  const mounted = whenSeamMounted(ctx, 'tuiScenes', () => ({ id: 'seam' }), seam => used.push(seam), { timers });

  assert.equal(mounted, true);
  assert.equal(used.length, 1);
  assert.equal(timers.queue.length, 0, 'no timer may be left behind');
  assert.deepEqual(ctx.warns(), []);
});

test('a seam that mounts late is used on a later tick', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  let seam;
  let mounted;
  const used = [];
  mounted = whenSeamMounted(ctx, 'tuiScenes', () => seam, value => used.push(value), { timers });

  assert.equal(mounted, false, 'the synchronous probe found nothing');
  assert.equal(used.length, 0);
  assert.equal(timers.queue.length, 1, 'a bounded poll must be scheduled instead of giving up');

  // two empty ticks, then the service appears
  timers.flush(1);
  timers.flush(1);
  assert.equal(used.length, 0);
  seam = { id: 'late' };
  timers.flush(1);

  assert.deepEqual(used, [seam]);
  assert.equal(timers.queue.length, 0, 'the poll must stop once the seam is used');
  assert.equal(timers.queue.length, 0);
});

test('the fast phase gives way to the slow cadence after its attempt budget', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  whenSeamMounted(ctx, 'tuiScenes', () => undefined, () => {}, { timers });

  const delays = [];
  for (let i = 0; i < SEAM_FAST_ATTEMPTS + 3 && timers.queue.length > 0; i += 1) {
    delays.push(timers.queue[0].ms);
    timers.flush(1);
  }
  assert.equal(delays[0], SEAM_FAST_DELAY_MS);
  assert.equal(delays[SEAM_FAST_ATTEMPTS - 1], SEAM_FAST_DELAY_MS);
  assert.equal(delays[SEAM_FAST_ATTEMPTS], SEAM_SLOW_DELAY_MS, 'the cadence must relax, not stop');
});

test('a seam that never appears is given up on with a bounded report, not a crash', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  whenSeamMounted(ctx, 'tuiScenes', () => undefined, () => {}, { timers: { ...timers, budgetMs: 100 } });

  const steps = timers.flush();
  assert.ok(steps > 0);
  assert.equal(timers.queue.length, 0, 'polling must stop at the deadline');
  // Exactly one report, at the warn level: the composed boot cannot have this
  // seam and stay silent, and the line names the budget it waited out.
  assert.deepEqual(ctx.warns(), ['dsh-tui-rewrite: tuiScenes never mounted within the 0 s budget; the feature stays unavailable this session']);
});

test('an unload stops the poll', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  whenSeamMounted(ctx, 'tuiScenes', () => undefined, () => {}, { timers });
  assert.equal(timers.queue.length, 1);

  ctx.unload();
  assert.equal(timers.queue.length, 0, 'the activation must not leave a tick behind');
  timers.flush();
  assert.equal(timers.queue.length, 0);
});

test('a throwing probe is contained and retried', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  let calls = 0;
  const used = [];
  whenSeamMounted(ctx, 'tuiScenes', () => {
    calls += 1;
    if (calls === 1) throw new Error('store exploded');
    return { id: 'recovered' };
  }, seam => used.push(seam), { timers });

  assert.equal(used.length, 0);
  assert.match(ctx.warns()[0], /probing the seam threw \(store exploded\)/u);
  timers.flush(1);
  assert.equal(used.length, 1);
});

test('a throwing setup stops the outer poll and leaves the retry to the caller', () => {
  // The caller (registerScene) owns registerSeamWithRetry in this case; two
  // loops racing the same registration is the bug this guards.
  const ctx = makeContext();
  const timers = makeTimers();
  let uses = 0;
  const mounted = whenSeamMounted(ctx, 'tuiScenes', () => ({ id: 'seam' }), () => {
    uses += 1;
    throw new Error('liveness gate');
  }, { timers });

  assert.equal(mounted, true, 'the seam WAS found; that the setup failed is the caller\'s business');
  assert.equal(uses, 1);
  assert.equal(timers.queue.length, 0, 'no second loop may be left polling the same seam');
  assert.match(ctx.warns()[0], /setup failed \(liveness gate\)/u);
});

test('registerSeamWithRetry registers on a later tick and scopes the disposer', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  let attempts = 0;
  const attached = [];
  const dispose = () => {};
  registerSeamWithRetry(ctx, 'scene', () => {
    attempts += 1;
    if (attempts < 3) throw new Error('COMPONENT_NOT_ADMITTED');
    return dispose;
  }, value => attached.push(value), new Error('COMPONENT_NOT_ADMITTED'), { timers });

  assert.equal(attempts, 0, 'nothing is attempted until a timer fires - apply must not block');
  assert.match(ctx.warns()[0], /registration was refused \(COMPONENT_NOT_ADMITTED\)/u);
  const steps = timers.flush();
  assert.equal(steps, 3, 'the retry succeeds on the third tick');
  assert.equal(attempts, 3);
  assert.deepEqual(attached, [dispose]);
  assert.equal(timers.queue.length, 0, 'a successful retry ends the poll');
  // The attempt counter starts at 1 (the tick already scheduled when the poll
  // is armed), so the third register call reports as retry #4. What matters is
  // that a recovery is reported at all: a silent retry hides a real degradation.
  assert.ok(ctx.warns().some(line => /registered on retry #4 \(boot race: COMPONENT_NOT_ADMITTED\)/u.test(line)));
});

test('registerSeamWithRetry gives up loudly without throwing', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  let attempts = 0;
  assert.doesNotThrow(() => {
    registerSeamWithRetry(ctx, 'scene', () => {
      attempts += 1;
      throw new Error('still not admitted');
    }, () => {}, new Error('first'), { timers: { ...timers, budgetMs: 60 } });
  });

  timers.flush();
  assert.ok(attempts > 1);
  assert.equal(timers.queue.length, 0);
  assert.ok(ctx.warns().some(line => /failed within the 0 s budget/u.test(line)), 'a terminal failure must be reported');
});

test('pollOnBudget contains a throwing tick and keeps its cadence', () => {
  const ctx = makeContext();
  const timers = makeTimers();
  let ticks = 0;
  pollOnBudget(ctx, 'probe', () => {
    ticks += 1;
    throw new Error('tick exploded');
  }, 'gave up', { ...timers, budgetMs: 60 });

  assert.doesNotThrow(() => timers.flush());
  assert.ok(ticks > 1, 'a throwing tick must not end the poll');
  // every warning except the terminal give-up line is the contained tick throw
  const warns = ctx.warns();
  assert.equal(warns.at(-1), 'gave up');
  assert.ok(warns.slice(0, -1).every(line => /retry attempt threw \(tick exploded\)/u.test(line)));
  assert.equal(warns.filter(line => line !== 'gave up').length, ticks);
});