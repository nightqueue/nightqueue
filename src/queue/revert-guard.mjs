const LINES_SHOWN = 10;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

// The short form of a commit sha.
function sha7(sha) {
  return String(sha ?? "").slice(0, 7);
}

// The first non-empty line of a text, or a placeholder naming its absence.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0]?.trim() || "no output";
}

// The failure of one git call of the guard.
function gitFailure(args, answer) {
  return { ok: false, error: `git ${args[0]} failed: ${firstLine(answer?.stderr)}` };
}

// Tells whether a blob id is the all-zero id git uses for an absent path, whatever the repository's hash length.
function isZeroBlob(blob) {
  return /^0+$/.test(String(blob ?? ""));
}

// The NUL-separated tokens of a `-z` output, each without the newline git puts before a raw record.
function zTokens(text) {
  return String(text ?? "").split("\0").map((token) => token.replace(/^\n+/, ""));
}

// One raw record from its `:mode mode old new status` token and the path token after it.
function rawRecord(meta, path) {
  const [, , oldBlob, newBlob] = meta.split(" ");
  return { path: path ?? "", oldBlob, newBlob };
}

// The raw records of a `-z --raw` output: each path with the blob before and after, the zero blob meaning absent.
export function parseRawRecords(text) {
  const tokens = zTokens(text);
  const records = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith(":")) continue;
    records.push(rawRecord(tokens[index], tokens[index + 1]));
    index += 1;
  }
  return records;
}

// One commit header token `RS sha FS parents FS subject`; only the subject may hold any separator.
function commitHeader(token) {
  const body = token.slice(RECORD_SEPARATOR.length);
  const shaEnd = body.indexOf(FIELD_SEPARATOR);
  const parentsEnd = body.indexOf(FIELD_SEPARATOR, shaEnd + 1);
  if (shaEnd < 0 || parentsEnd < 0) return null;
  const parents = body.slice(shaEnd + 1, parentsEnd);
  return { sha: body.slice(0, shaEnd), parent: parents.split(" ")[0] || null, subject: body.slice(parentsEnd + 1), records: [] };
}

// The commits of a `log -z --raw` output in order, each with its raw records, walking tokens so no subject or path can break the framing.
function logCommits(text) {
  const tokens = zTokens(text);
  const commits = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith(":")) {
      commits.at(-1)?.records.push(rawRecord(token, tokens[index + 1]));
      index += 1;
    } else if (token.startsWith(RECORD_SEPARATOR)) {
      const header = commitHeader(token);
      if (header) commits.push(header);
    }
  }
  return commits;
}

// The first-parent history of one path, newest first: each commit that changed it with its first parent, subject and the path's blob before it.
export function parsePathLog(text, path) {
  const entries = [];
  for (const { sha, parent, subject, records } of logCommits(text)) {
    const record = records.find((item) => item.path === path);
    if (record) entries.push({ sha, parent, subject, oldBlob: record.oldBlob });
  }
  return entries;
}

// The paths that differ between the base tip and the head, with the tip's blob and the head's blob.
async function differingPaths(git, base, head) {
  const args = ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head];
  const answer = await git(args);
  if (!answer?.ok) return gitFailure(args, answer);
  const paths = parseRawRecords(answer.stdout).filter((record) => record.oldBlob !== record.newBlob);
  return { ok: true, paths: paths.map((record) => ({ path: record.path, headBlob: record.newBlob })) };
}

// The paths the head changed since it forked from the base.
async function headChangedPaths(git, base, head) {
  const mergeBaseArgs = ["merge-base", base, head];
  const mergeBase = await git(mergeBaseArgs);
  const forkPoint = String(mergeBase?.stdout ?? "").trim();
  if (!mergeBase?.ok || !forkPoint) return gitFailure(mergeBaseArgs, mergeBase);
  const args = ["diff", "--name-only", "--no-renames", "-z", forkPoint, head];
  const answer = await git(args);
  if (!answer?.ok) return gitFailure(args, answer);
  return { ok: true, paths: new Set(String(answer.stdout ?? "").split("\0").filter(Boolean)) };
}

// The base commit whose change the head's blob of one path undoes, or null when that blob is no earlier state of the base.
async function revertOfPath(git, { base, head }, { path, headBlob }) {
  const args = ["log", "-z", "--raw", "--no-abbrev", "--no-renames", "--first-parent", "-m", "--format=%x1e%H%x1f%P%x1f%s", base, "--", `:(literal)${path}`];
  const answer = await git(args);
  if (!answer?.ok) return gitFailure(args, answer);
  const entries = parsePathLog(answer.stdout, path);
  const index = entries.findIndex((entry) => entry.oldBlob === headBlob);
  if (index < 0) return { ok: true, reverted: null };
  const undone = entries[index];
  if (isZeroBlob(headBlob)) {
    const own = await onHeadLine(git, head, undone.sha);
    if (!own.ok) return own;
    if (own.onLine) return { ok: true, reverted: null };
  }
  return { ok: true, reverted: { path, backTo: entries[index + 1]?.sha ?? undone.parent, undone: { sha: undone.sha, subject: undone.subject } } };
}

// Tells whether a commit is on the head's own line before it (its first parent's history): a path that line added, the head may delete.
async function onHeadLine(git, head, commit) {
  const args = ["rev-list", "--count", `${head}^1..${commit}`];
  const answer = await git(args);
  const count = Number.parseInt(String(answer?.stdout ?? "").trim(), 10);
  if (!answer?.ok || !Number.isFinite(count)) return gitFailure(args, answer);
  return { ok: true, onLine: count === 0 };
}

// The paths whose squash of the head into the base would put back an older version from the base's history; `git(args)` answers `{ ok, stdout, stderr }`.
export async function findRevertedPaths({ git, base, head }) {
  const differing = await differingPaths(git, base, head);
  if (!differing.ok) return differing;
  if (!differing.paths.length) return { ok: true, reverted: [] };
  const changed = await headChangedPaths(git, base, head);
  if (!changed.ok) return changed;
  const reverted = [];
  for (const candidate of differing.paths.filter((item) => changed.paths.has(item.path))) {
    const found = await revertOfPath(git, { base, head }, candidate);
    if (!found.ok) return found;
    if (found.reverted) reverted.push(found.reverted);
  }
  return { ok: true, reverted };
}

// Up to ten note lines naming each reverted path, the state it goes back to and the base commit it undoes.
export function revertNoteLines(reverted) {
  const lines = reverted.slice(0, LINES_SHOWN).map(({ path, backTo, undone }) => `${path} back to ${backTo ? sha7(backTo) : "its absence"} (undoes ${sha7(undone.sha)} ${undone.subject})`);
  return reverted.length > LINES_SHOWN ? [...lines, `(+${reverted.length - LINES_SHOWN} more)`] : lines;
}
