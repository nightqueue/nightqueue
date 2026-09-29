import { UserError } from "../config/errors.mjs";
import { jobRef } from "../memory/refs.mjs";
import { prStateKey } from "./pr-state.mjs";

// The id of the one job that opened a pull request URL, refusing a URL that is not a pull request, no job, and more than one.
export async function jobIdOfPrUrl(store, url) {
  const key = prStateKey(url);
  if (key === null) throw new UserError(`not a GitHub pull request URL: \`${url}\``);
  const number = Number(key.slice(key.lastIndexOf("#") + 1));
  const rows = await store.jobs.jobsWithPrNumber(number);
  const ids = (Array.isArray(rows) ? rows : []).filter((row) => prStateKey(row.pr_url) === key).map((row) => Number(row.id));
  if (ids.length === 0) throw new UserError(`no job opened \`${url}\``);
  if (ids.length > 1) throw new UserError(`\`${url}\` was opened by more than one job: ${ids.map(jobRef).join(", ")}; pass one of them`);
  return ids[0];
}
