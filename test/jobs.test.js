/**
 * DSH background-job bridge tests (offline).
 *
 * Contract: a started Markji sync task is exposed through @deepseek-ai/dsh-jobs
 * so the Web UI lists it, job_output can read it, and dsh-tool-jobs owns the
 * completion notice. The persisted Markji task stays the source of truth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyncJob, syncJobLabel, syncJobProgress, syncJobSummary, syncJobOutcome } from '../lib/jobs.js';
import { registerTools } from '../lib/tools.js';

function task(overrides = {}) {
  return {
    task_id: 'sync_abc',
    status: 'running',
    mode: 'auto',
    full: false,
    resume_count: 0,
    stage: 'pull',
    progress: { message: 'pull: deck 1/3', decks_total: 3, decks_done: 1, cards: 12 },
    ...overrides,
  };
}

test('job labels, progress and summary describe the task', () => {
  const running = task();
  assert.equal(syncJobLabel(running), 'Markji sync (auto)');
  assert.match(syncJobProgress(running), /pull: deck 1\/3/);
  assert.match(syncJobProgress(running), /decks 1\/3/);
  const completed = task({
    status: 'completed',
    report: { pull: { decks: 3, cards: 9 }, push: { cards_created: 2, cards_updated: 1 }, conflicts: [], errors: [] },
  });
  assert.match(syncJobSummary(completed), /pull: 3 deck\(s\), 9 card\(s\)/);
  assert.match(syncJobSummary(completed), /push: 2 created, 1 updated/);
  assert.equal(syncJobOutcome(completed).status, 'completed');
  assert.equal(syncJobOutcome(task({ status: 'failed' })).status, 'failed');
  assert.equal(syncJobOutcome(task({ status: 'interrupted' })).status, 'killed');
});

test('startSyncJob mirrors progress and settles with the task', async () => {
  let spec;
  const jobs = {
    start(input) {
      spec = input;
      return 'markji-sync-job-1';
    },
  };
  const terminal = new Map();
  const progress = new Map();
  const engine = {
    watchTask(id, callback) {
      terminal.set(id, callback);
      return true;
    },
    watchTaskProgress(id, callback) {
      progress.set(id, callback);
      return true;
    },
  };
  const started = task();
  const jobId = startSyncJob({ jobs, engine, owner: 'session-1', task: started, toolCall: { callId: 'call-1' }, log: () => {} });
  assert.equal(jobId, 'markji-sync-job-1');
  assert.equal(spec.kind, 'markji-sync');
  assert.equal(spec.label, 'Markji sync (auto)');
  assert.equal(spec.owner, 'session-1');
  assert.deepEqual(spec.toolCall, { callId: 'call-1' });

  const updates = [];
  const output = [];
  const hooks = spec.run({ updateProgress: (line) => updates.push(line), append: (text) => output.push(text) });
  assert.equal(updates.length, 1, 'seeds progress immediately');
  progress.get('sync_abc')(task({ progress: { message: 'pull: deck 2/3', decks_total: 3, decks_done: 2, cards: 20 } }));
  assert.match(updates.at(-1), /deck 2\/3/);

  terminal.get('sync_abc')(task({ status: 'completed', report: { pull: { decks: 3, cards: 20 }, push: { cards_created: 1, cards_updated: 2 }, conflicts: [], errors: [] } }));
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'completed');
  assert.equal(typeof outcome.result, 'string', 'JobOutcome.result must be a string for job_output');
  assert.equal(JSON.parse(outcome.result).task_id, 'sync_abc');
  assert.match(output.at(-1), /Markji sync \(auto\) completed/);
});

test('a foreign running task does not create a job that can never settle', async () => {
  const registered = new Map();
  let started = 0;
  const ctx = {
    tools: {
      register(spec) {
        registered.set(spec.name, spec);
        return () => {};
      },
    },
    get(name) {
      return name === 'jobs' ? { start() { started += 1; return 'should-not-happen'; } } : undefined;
    },
  };
  const engine = {
    async ready() {},
    async startSync() {
      return { task: task(), already_running: true };
    },
    ownsTask() {
      return false;
    },
    watchTask() {
      return true;
    },
    watchTaskProgress() {
      return true;
    },
  };
  const dispose = registerTools(ctx, { engine, config: { maxOutputChars: 20000 }, log: () => {} });
  try {
    const result = await registered.get('markji_sync').execute(
      { action: 'start' },
      { agent: { id: 'session-2' }, callId: 'call-2' },
    );
    assert.equal(result.job_id, undefined);
    assert.equal(started, 0);
  } finally {
    dispose();
  }
});

test('markji_sync action=start exposes one DSH job per session and task', async () => {
  const registered = new Map();
  const starts = [];
  const jobs = {
    start(input) {
      starts.push(input);
      return 'markji-sync-job-' + starts.length;
    },
  };
  const engine = {
    async ready() {},
    async startSync() {
      return { task: task() };
    },
    ownsTask() {
      return true;
    },
    watchTask() {
      return true;
    },
    watchTaskProgress() {
      return true;
    },
  };
  const ctx = {
    tools: {
      register(spec) {
        registered.set(spec.name, spec);
        return () => {};
      },
    },
    get(name) {
      return name === 'jobs' ? jobs : undefined;
    },
  };
  const dispose = registerTools(ctx, { engine, config: { maxOutputChars: 20000 }, log: () => {} });
  try {
    const tool = registered.get('markji_sync');
    assert.ok(tool);
    const exec = { agent: { id: 'session-1' }, callId: 'call-1', rootCallId: 'root-1' };
    const first = await tool.execute({ action: 'start', mode: 'pull' }, exec);
    assert.equal(first.task.task_id, 'sync_abc');
    assert.equal(first.job_id, 'markji-sync-job-1');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].owner, 'session-1');
    const second = await tool.execute({ action: 'start', mode: 'pull' }, exec);
    assert.equal(second.job_id, 'markji-sync-job-1');
    assert.equal(starts.length, 1, 'same session and task reuse the job');
  } finally {
    dispose();
  }
});
