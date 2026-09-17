import { openStore } from "../store/open.mjs";
import { advisoryLines } from "./hints.mjs";
import { liveFiveHourUtilization } from "./rate-limit.mjs";
import { liveRunnersReport } from "./registry.mjs";

// The advisory lines of this home read through the store it is given; a read that fails answers no advice, because a warning never blocks anything.
export async function advisoryLinesFor({ store, runners, env = process.env, killImpl } = {}) {
  try {
    const activeByProject = await store.jobs.countActiveJobsByProject();
    return advisoryLines({ runners, fiveHourUtilization: liveFiveHourUtilization(env, killImpl), activeByProject });
  } catch {
    return [];
  }
}

// The advisory lines a start echoes once, counting every live runner at that instant, the one it just registered included.
export async function startAdvisoryLines({ env = process.env, killImpl, store } = {}) {
  try {
    const { runners, error } = liveRunnersReport(env, killImpl);
    return await advisoryLinesFor({ store: store ?? openStore(env), runners: error === null ? runners : [], env, killImpl });
  } catch {
    return [];
  }
}
