// Whether nobody is working the queue right now - no job under a live lease and no registered runner.
export function isQueueIdle({ activeJobs, runners }) {
  return activeJobs === 0 && (runners?.length ?? 0) === 0;
}

// The number of pending jobs, written the way the reader of the hint sees it.
export function pendingJobs(pending) {
  return `${pending} pending job${pending === 1 ? "" : "s"}`;
}
