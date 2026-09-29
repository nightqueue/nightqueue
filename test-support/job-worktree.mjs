// A job worktree preparer that runs the job in its checkout and records nothing, for runner tests whose checkouts are not real repositories.
export function fakeJobWorktree() {
  const calls = [];
  const impl = async ({ job, checkout }) => {
    calls.push({ jobId: job?.id, checkout });
    return { ok: true, path: checkout, branch: null, reused: true, legacy: false };
  };
  impl.calls = calls;
  return impl;
}
