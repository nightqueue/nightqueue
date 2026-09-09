// Whether nobody is working the queue right now - no job under a live lease and no registered watcher.
export function isQueueIdle({ activeJobs, runner }) {
  return activeJobs === 0 && runner.running !== true;
}

// The number of pending jobs, written the way the reader of the hint sees it.
export function pendingJobs(pending) {
  return `${pending} pending job${pending === 1 ? "" : "s"}`;
}
