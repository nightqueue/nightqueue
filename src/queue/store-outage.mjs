import { STORE_UNAVAILABLE_HINT, StoreUnavailableError } from "../config/errors.mjs";

// First wait of an outage and the ceiling the doubling stops at.
export const OUTAGE_BASE_MS = 30_000;
export const OUTAGE_MAX_MS = 300_000;

// What a store step answers when the runner was told to stop while it waited for the database.
export const OUTAGE_STOPPED = Symbol("stopped while the database was unavailable");

export const OUTAGE_RECOVERED_LINE = "nightqueue: the database is reachable again";

// Waits until the next pass over the queue, or until a shutdown signal wakes the runner up first.
export function waitNextPass(ms, state, sleepImpl) {
  const waiting = sleepImpl(ms);
  return new Promise((done) => {
    const finish = () => {
      state.wake = null;
      done();
    };
    state.wake = () => {
      waiting?.cancel?.();
      finish();
    };
    Promise.resolve(waiting).then(finish);
  });
}

// The one line that opens an outage: the store error, the backoff, and the fix.
export function outageLine(err) {
  const code = err?.code ?? "unknown";
  const home = err?.home ?? "unknown home";
  return `nightqueue: the database is unavailable (${code} at ${home}): claims and sweeps retry every ${OUTAGE_BASE_MS / 1000} s, doubling to ${OUTAGE_MAX_MS / 60_000} min; the running job keeps going - run \`${STORE_UNAVAILABLE_HINT}\``;
}

// Writes one line on the runner's stderr.
function stderrLine(line) {
  process.stderr.write(`${line}\n`);
}

// Runs a store step, answering its value or the StoreUnavailableError it threw; any other failure is the caller's.
async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof StoreUnavailableError) return { ok: false, error: err };
    throw err;
  }
}

// The outage state of one runner: one line when it starts, a doubling backoff, and the held job's lease renewed the moment the store answers again.
export function createStoreOutage({ write = stderrLine, sleepImpl, probeMs = null } = {}) {
  if (typeof sleepImpl !== "function") throw new TypeError("createStoreOutage: `sleepImpl` must be a function");
  const outage = { active: false, delayMs: OUTAGE_BASE_MS, renewHeld: null };

  // Says once that the database is unavailable; a store failure during an outage already noted says nothing more.
  function note(err) {
    if (outage.active) return;
    outage.active = true;
    write(outageLine(err));
  }

  // Renews the lease of the job this runner holds; a store that fails again reopens the outage.
  async function renewHeldLease() {
    if (!outage.renewHeld) return;
    const renewed = await settle(outage.renewHeld);
    if (!renewed.ok) note(renewed.error);
  }

  // Closes a noted outage: resets the backoff, says so once, renews the held job's lease, then ends any pending backoff wait.
  async function recovered(state) {
    if (!outage.active) return;
    outage.active = false;
    outage.delayMs = OUTAGE_BASE_MS;
    write(OUTAGE_RECOVERED_LINE);
    await renewHeldLease();
    state?.wake?.();
  }

  // Probes the held job's lease at the heartbeat cadence while a backoff wait runs, so the store coming back is seen at once; answers the stop.
  function probeHeldLease(state) {
    if (!outage.renewHeld || !(probeMs > 0)) return () => {};
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || !outage.active) return;
      busy = true;
      try {
        const renewed = await settle(outage.renewHeld);
        if (renewed.ok) await recovered(state);
      } catch (err) {
        write(`nightqueue: the lease of the held job could not be renewed: ${err?.message ?? String(err)}`);
      } finally {
        busy = false;
      }
    }, probeMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Waits the current backoff (a stop or a recovery ends it early), then doubles it up to the ceiling.
  async function wait(state) {
    const ms = outage.delayMs;
    outage.delayMs = Math.min(ms * 2, OUTAGE_MAX_MS);
    const stopProbe = probeHeldLease(state);
    try {
      await waitNextPass(ms, state, sleepImpl);
    } finally {
      stopProbe();
    }
  }

  // Runs a store step until the store answers it, backing off between tries; OUTAGE_STOPPED when the runner is told to stop meanwhile.
  async function retryWhileUnavailable(fn, state) {
    while (true) {
      const tried = await settle(fn);
      if (tried.ok) {
        await recovered(state);
        return tried.value;
      }
      note(tried.error);
      if (state.stopping) return OUTAGE_STOPPED;
      await wait(state);
      if (state.stopping) return OUTAGE_STOPPED;
    }
  }

  // Registers the lease renewal of the job this runner now holds, answering the function that lets it go.
  function hold(renewHeld) {
    outage.renewHeld = renewHeld;
    return () => {
      if (outage.renewHeld === renewHeld) outage.renewHeld = null;
    };
  }

  return { note, recovered, wait, retryWhileUnavailable, hold, isActive: () => outage.active };
}
