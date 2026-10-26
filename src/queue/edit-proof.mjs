import { ghPrDetail } from "../host/gh.mjs";
import { sameBranch } from "./branch-name.mjs";
import { editedPublicationUrls } from "./stream.mjs";

// Tells whether one pull request heads the run's own branch, by asking gh; a lookup that fails or answers another branch proves nothing.
async function headsRunBranch(url, { branch, hints, detailImpl }) {
  try {
    const detail = await detailImpl(url);
    return detail?.ok === true && sameBranch(detail.headRefName, branch, hints);
  } catch {
    return false;
  }
}

// The pull requests the host announced as EDITED in the stream that gh itself proves to head the run's branch; fail closed to an empty list.
export async function provenEditedPrUrls(log, { state, detailImpl = ghPrDetail } = {}) {
  const branch = typeof state?.branch === "string" ? state.branch.trim() : "";
  if (!branch || typeof detailImpl !== "function") return [];
  const hints = { type: state?.type, slug: state?.slug };
  const proofs = await Promise.all(
    editedPublicationUrls(log).map(async (url) => ((await headsRunBranch(url, { branch, hints, detailImpl })) ? url : null)),
  );
  return proofs.filter(Boolean);
}
