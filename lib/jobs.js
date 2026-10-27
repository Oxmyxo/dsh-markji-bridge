/**
 * DSH background-job bridge for Markji sync tasks.
 *
 * Markji already persists its own sync task lifecycle (cache.db, crash
 * recovery, progress and reports). This module exposes that same task through
 * @deepseek-ai/dsh-jobs so the Web UI lists it under background jobs, the model
 * can inspect it with job_output, and @deepseek-ai/dsh-tool-jobs delivers the
 * standard completion notice to the owning session. The persisted Markji task
 * remains the source of truth; a DSH job is a live view of it.
 */
export const SYNC_JOB_KIND = 'markji-sync';

function isTask(value) {
  return value !== null && typeof value === 'object' && typeof value.task_id === 'string' && value.task_id !== '';
}
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
function warn(log, message) {
  if (typeof log === 'function') log('warn', message);
}

/** Label shown in the background-jobs list. */
export function syncJobLabel(task) {
  if (!isTask(task)) return 'Markji sync';
  const mode = typeof task.mode === 'string' && task.mode !== '' ? task.mode : 'auto';
  return 'Markji sync (' + mode + (task.full === true ? ', full' : '') + ')';
}

/** One-line live progress shown beside the job. */
export function syncJobProgress(task) {
  if (!isTask(task)) return 'starting';
  const progress = task.progress !== null && typeof task.progress === 'object' ? task.progress : {};
  const bits = [];
  if (typeof progress.message === 'string' && progress.message !== '') bits.push(progress.message);
  if (progress.decks_total !== undefined) bits.push('decks ' + count(progress.decks_done) + '/' + count(progress.decks_total));
  if (progress.cards !== undefined) bits.push('cards ' + count(progress.cards));
  if (progress.cards_created !== undefined || progress.cards_updated !== undefined) {
    bits.push('push ' + count(progress.cards_created) + ' created / ' + count(progress.cards_updated) + ' updated');
  }
  if (bits.length === 0) bits.push(typeof task.stage === 'string' && task.stage !== '' ? task.stage : 'running');
  return bits.join(' · ');
}

/** Human-readable terminal report for job_output. */
export function syncJobSummary(task) {
  if (!isTask(task)) return 'Markji sync finished.';
  const lines = [syncJobLabel(task) + ' ' + (task.status || 'finished') + ' (task ' + task.task_id + ')'];
  if (task.status === 'completed' && task.report !== null && typeof task.report === 'object') {
    const report = task.report;
    const pull = report.pull !== null && typeof report.pull === 'object' ? report.pull : {};
    const push = report.push !== null && typeof report.push === 'object' ? report.push : {};
    lines.push('pull: ' + count(pull.decks) + ' deck(s), ' + count(pull.cards) + ' card(s)');
    lines.push(
      'push: ' + count(push.cards_created) + ' created, ' + count(push.cards_updated) + ' updated' +
        (count(push.cards_moved) > 0 ? ', ' + count(push.cards_moved) + ' moved' : ''),
    );
    lines.push(
      'conflicts: ' + (Array.isArray(report.conflicts) ? report.conflicts.length : 0) +
        '; errors: ' + (Array.isArray(report.errors) ? report.errors.length : 0),
    );
  } else if (task.error !== null && typeof task.error === 'object') {
    const code = typeof task.error.code === 'string' && task.error.code !== '' ? task.error.code : 'sync_failed';
    const message = typeof task.error.message === 'string' && task.error.message !== '' ? task.error.message : 'unknown error';
    lines.push('error: ' + code + ': ' + message);
  }
  lines.push('Use markji_sync action=progress task_id=' + task.task_id + ' for the stored task view.');
  return lines.join('\n');
}

/**
 * Terminal task view handed to the model by job_output. DSH's JobOutcome.result
 * is a string (it is interpolated into the read), so serialize the view here
 * instead of returning an object that would render as [object Object].
 */
export function syncJobResult(task) {
  if (!isTask(task)) return '';
  return JSON.stringify(task);
}

/** Map a terminal Markji task onto a DSH job outcome. */
export function syncJobOutcome(task) {
  if (!isTask(task)) return { status: 'failed', detail: 'Markji sync task disappeared' };
  const status = task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'killed';
  const detail = syncJobLabel(task) + ' ' + (task.status || 'finished');
  return { status, detail, result: syncJobResult(task) };
}

/**
 * Register a DSH job that mirrors an already-started Markji task.
 *
 * @param deps.jobs - the jobs service (ctx.get('jobs')).
 * @param deps.engine - the Markji engine with watchTask/watchTaskProgress.
 * @param deps.owner - owning Agent/session id.
 * @param deps.task - task view returned by engine.startSync.
 * @param deps.toolCall - optional {callId, rootCallId} of the creating call.
 * @param deps.log - plugin logger.
 * @returns the DSH job id, or null when jobs are unavailable.
 */
export function startSyncJob(deps) {
  const { jobs, engine, owner, task, toolCall, log } = deps;
  if (jobs === null || typeof jobs !== 'object' || typeof jobs.start !== 'function') return null;
  if (typeof owner !== 'string' || owner === '') return null;
  if (!isTask(task)) return null;
  if (engine === null || typeof engine !== 'object' || typeof engine.watchTask !== 'function') return null;
  try {
    return jobs.start({
      kind: SYNC_JOB_KIND,
      label: syncJobLabel(task),
      owner,
      ...(toolCall !== null && typeof toolCall === 'object' ? { toolCall } : {}),
      run: (handle) => {
        let settle = null;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        let finished = false;
        let lastProgress = '';
        const finish = (view) => {
          if (finished) return;
          finished = true;
          try {
            handle.append(syncJobSummary(view) + '\n');
          } catch {
            /* job output is best-effort */
          }
          settle(syncJobOutcome(view));
        };
        const progress = (view) => {
          if (finished) return;
          const line = syncJobProgress(view);
          try {
            handle.updateProgress(line);
          } catch {
            /* job progress is best-effort */
          }
          // job_output reads appended output, not the progress line, so append
          // each changed progress snapshot as it happens. A repeated snapshot
          // (the immediate watchTaskProgress seed) is skipped instead of making
          // the output scroll with identical lines.
          if (line !== lastProgress) {
            lastProgress = line;
            try {
              handle.append(line + '\n');
            } catch {
              /* job output is best-effort */
            }
          }
        };
        progress(task);
        if (typeof engine.watchTaskProgress === 'function') {
          engine.watchTaskProgress(task.task_id, progress);
        }
        if (engine.watchTask(task.task_id, finish) !== true) finish(task);
        return {
          cancel: (reason) => {
            if (typeof engine.cancelTask === 'function') {
              try {
                engine.cancelTask(task.task_id, reason);
              } catch (error) {
                warn(log, 'cancel sync task failed: ' + (error instanceof Error ? error.message : String(error)));
              }
              return;
            }
            // Older engines cannot stop a run; settle the job so teardown does
            // not hang, while the persisted task remains resumable.
            finish({
              ...task,
              status: 'interrupted',
              error: { code: 'cancelled', message: reason || 'cancelled' },
            });
          },
          done,
        };
      },
    });
  } catch (error) {
    warn(log, 'could not register DSH sync job: ' + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}
