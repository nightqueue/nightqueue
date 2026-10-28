import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { isId } from "../config/ids.mjs";
import { operatorConsentPath, operatorLogPath, worktreesDir } from "../config/paths.mjs";
import { registeredCheckouts } from "../memory/registry-access.mjs";
import { WRAPPED_GUARDED, hasGlob, isHomeMaintenance, isWrappedGuarded, neverBashReason, neverWriteReason, scopeWords } from "./operator-bands.mjs";
import { homeMaintenanceForm, homeTargets, worktreeCall } from "./operator-home.mjs";
import { GIT_READ_SUBCOMMANDS, isDoctorFix } from "./operator-scope.mjs";
import { canonicalPath, insideRoots } from "./orchestrator-scope.mjs";

export const OPERATOR_SESSION_ENV = "NIGHTQUEUE_OPERATOR_SESSION";
const HOME_MAINTENANCE = "home-maintenance";
export const CONSENT_KINDS = Object.freeze(["edit", "create", "run", "git-write", "connection-write", HOME_MAINTENANCE]);
const HOME_MAINTENANCE_FORMS =
  "a home-maintenance consent is one exact command: `rm`/`rmdir`/`find … -delete` of one run dir or worktree, `git -C <checkout> worktree remove <absolute worktree path>` or `git -C <checkout> worktree prune`";

const CONNECTION_WRITE_METHODS = ["POST", "PATCH", "PUT"];
const BOUNDS = Object.freeze({ answer: 2000, reason: 500, scope: 2000 });
const NO_PATH = "-";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LINE_BREAKERS = /[\s\u0000-\u001f\u007f]+/g;

// The id of the `nightqueue open` session this process serves, or null outside one and always inside a queued job.
export function operatorSession(env = process.env) {
  if (typeof env?.NIGHTQUEUE_JOB_ID === "string" && env.NIGHTQUEUE_JOB_ID.trim() !== "") return null;
  const id = typeof env?.[OPERATOR_SESSION_ENV] === "string" ? env[OPERATOR_SESSION_ENV].trim() : "";
  return isId(id) ? id : null;
}

// The scope of a connection write as a consent names it: `<connection> <METHOD> <path>`, `-` for no path.
export function connectionScope({ connection, method, path }) {
  const relative = String(path ?? "").trim().replace(/^\//, "");
  return `${String(connection ?? "").trim()} ${String(method ?? "").trim().toUpperCase()} ${relative || NO_PATH}`;
}

// One line of the record as an event, or null when it is not a JSON object.
function parseEvent(line) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

// Every event of a session's record, oldest first; a missing record is empty and any other read failure throws.
function readEvents(session, env) {
  const path = operatorConsentPath(session, env);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`cannot read the consent record ${path}: ${err?.message ?? String(err)}`);
  }
  return text.split("\n").map(parseEvent).filter(Boolean);
}

// Tells whether two events name the same consent: the same project, kind and scope.
function sameConsent(a, b) {
  return (a.project_id ?? null) === (b.project_id ?? null) && a.kind === b.kind && a.scope === b.scope;
}

// The live consents of a session: every grant no later revoke of the same project, kind and scope withdrew.
export function liveConsents(session, env = process.env) {
  if (!isId(session)) return [];
  let live = [];
  for (const event of readEvents(session, env)) {
    if (event.revoke === true) live = live.filter((grant) => !sameConsent(grant, event));
    else if (CONSENT_KINDS.includes(event.kind) && typeof event.scope === "string") live.push(event);
  }
  return live;
}

// The text of a required field, trimmed and bounded, or a refusal naming it.
function requiredText(value, { field, max }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`\`${field}\` is required: ${field === "answer" ? "the person's own answer, quoted verbatim" : "why the consent is asked"}`);
  if (text.length > max) throw new UserError(`\`${field}\` is longer than ${max} characters`);
  return text;
}

// The canonical path scope of an edit or create consent, refused in the never band or outside the project where it must lie.
function pathScope({ kind, scope, project, env }) {
  if (!isAbsolute(scope)) throw new UserError(`the scope of a ${kind} consent is an absolute path, and \`${scope}\` is not`);
  const canonical = canonicalPath(scope);
  const never = neverWriteReason(canonical, env);
  if (never) throw new UserError(`${canonical} is in the never band (${never}); no consent covers it`);
  const inside = typeof project.path === "string" && project.path !== "" && insideRoots(canonical, [canonicalPath(project.path)]);
  if (inside) return { scope: canonical, exact: false };
  if (kind === "edit") throw new UserError(`an edit consent stays in the checkout of ${project.name} (${project.path}), and ${canonical} is outside it`);
  if (existsSync(canonical) && statSync(canonical).isDirectory()) throw new UserError(`a create consent outside a checkout names one file, and ${canonical} is a directory`);
  return { scope: canonical, exact: true };
}

// The words of a command consent's scope: one bare command naming its files literally, its leading `cd <dir> &&` and `timeout <n>` dropped.
function commandWords(kind, scope) {
  const words = scopeWords(scope);
  if (words === null) throw new UserError(`the scope of a ${kind} consent is one bare command, with no shell operator or backslash`);
  if (hasGlob(scope)) throw new UserError(`the scope of a ${kind} consent names its files literally, with no glob or brace character (\`* ? [ ] { }\`)`);
  return words;
}

// Refuses a consent scope the never band holds, with its reason (a job that still holds a run dir or worktree included).
function refuseNever(shown, env) {
  const never = neverBashReason(shown, { env });
  if (never) throw new UserError(`\`${shown}\` is in the never band (${never}); no consent covers it`);
}

// Refuses a consent scope that runs git, `doctor --fix` or home maintenance behind a wrapper or git by its path, which no request is ever matched against.
function refuseWrapped(words) {
  if (isWrappedGuarded(words)) throw new UserError(`\`${words.join(" ")}\` has no consentable form: ${WRAPPED_GUARDED}`);
}

// The scope of a run or git-write consent: one bare command, its leading `cd <dir> &&` and `timeout <n>` dropped (and `git` for git-write).
function commandScope({ kind, scope, env }) {
  const words = commandWords(kind, scope);
  if (kind === "run" && words[0] === "git") throw new UserError("a git command is consented as kind git-write, never as run");
  const argv = kind === "git-write" && words[0] === "git" ? words.slice(1) : words;
  const shown = kind === "git-write" ? `git ${argv.join(" ")}` : argv.join(" ");
  refuseNever(shown, env);
  refuseWrapped(words);
  if (isHomeMaintenance(kind === "git-write" ? ["git", ...argv] : argv)) throw new UserError(`\`${shown}\` deletes or removes a worktree: it is consented as kind ${HOME_MAINTENANCE}`);
  if (kind === "git-write" && (!argv[0] || argv[0].startsWith("-") || (GIT_READ_SUBCOMMANDS.has(argv[0]) && argv[0] !== "branch"))) {
    throw new UserError(`the scope of a git-write consent starts with a git subcommand that writes, and \`${shown}\` does not`);
  }
  return { scope: argv.join(" "), argv };
}

// A project's registered checkout as a one-root list, canonical; empty when it has none.
function checkoutRootOf(projectId, env) {
  const checkout = registeredCheckouts(env).find((project) => project.id === projectId)?.path;
  return typeof checkout === "string" && checkout !== "" ? [canonicalPath(checkout)] : [];
}

// The directories a project's home maintenance or salvage may run git in: its checkout and its worktrees under the home, canonical.
function maintenanceRoots(projectId, env) {
  return [...checkoutRootOf(projectId, env), canonicalPath(join(worktreesDir(env), projectId))];
}

// Refuses a home-maintenance scope that touches another project: an entry of another project, or a `git -C` dir outside its checkout.
function refuseForeignTargets(words, { project, env }) {
  const foreign = homeTargets(words, env).find((entry) => entry.projectId !== project.id);
  if (foreign) throw new UserError(`${foreign.canonical} is not a run dir or worktree of ${project.name}; a home-maintenance consent stays in its own project`);
  const gitDir = worktreeCall(words)?.gitDir;
  if (gitDir && !insideRoots(gitDir, checkoutRootOf(project.id, env))) {
    throw new UserError(`\`git -C ${gitDir}\` is outside the checkout of ${project.name}; git maintenance runs with the checkout as its git dir`);
  }
}

// The scope of a home-maintenance consent: the exact command, one delete of a run dir or worktree, `git worktree remove <worktree>` or `git worktree prune`.
function homeScope({ scope, project, env }) {
  const words = commandWords(HOME_MAINTENANCE, scope);
  if (!homeMaintenanceForm(words)) throw new UserError(HOME_MAINTENANCE_FORMS);
  const shown = words.join(" ");
  refuseNever(shown, env);
  refuseWrapped(words);
  refuseForeignTargets(words, { project, env });
  return { scope: shown, argv: words };
}

// The scope of a connection-write consent: `<connection> <POST|PATCH|PUT> <path>`.
function connectionWriteScope(scope) {
  const [connection, method, path = NO_PATH, ...extra] = scope.split(/\s+/);
  if (!connection || !CONNECTION_WRITE_METHODS.includes(String(method ?? "").toUpperCase()) || extra.length > 0) {
    throw new UserError("the scope of a connection-write consent is `<connection> <POST|PATCH|PUT> <path>` (`-` for no path)");
  }
  return { scope: connectionScope({ connection, method, path: path === NO_PATH ? "" : path }) };
}

// The normalized scope of a consent of one kind, or a refusal of a scope that kind never takes.
function normalizedScope({ kind, scope, project, env }) {
  const text = typeof scope === "string" ? scope.trim() : "";
  if (!text) throw new UserError("`scope` is required: exactly what the person consented to");
  if (text.length > BOUNDS.scope) throw new UserError(`\`scope\` is longer than ${BOUNDS.scope} characters`);
  if (CONTROL_CHARS.test(text)) throw new UserError("`scope` is one line: it carries no newline, tab or other control character");
  if (kind === "connection-write") return connectionWriteScope(text);
  if (!project?.id) throw new UserError(`a ${kind} consent requires \`project\`: the registered project it applies to`);
  if (kind === "edit" || kind === "create") return pathScope({ kind, scope: text, project, env });
  if (kind === HOME_MAINTENANCE) return homeScope({ scope: text, project, env });
  return commandScope({ kind, scope: text, env });
}

// Appends one line to a file, its directory made first.
function appendLine(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

// A text on one line: every run of whitespace or control characters collapsed to one space.
function oneLine(text) {
  return String(text).replace(LINE_BREAKERS, " ");
}

// The session log line of one grant or revoke.
function logLine({ at, revoke, kind, scope, project, answer }) {
  const head = `${at} ${revoke ? "revoke" : "consent"} ${kind} ${oneLine(scope)} · ${oneLine(project ?? "-")}`;
  return answer ? `${head} · "${oneLine(answer)}"` : head;
}

// Writes one event to the session's record and its line to the session log, and answers the line.
function writeEvent(session, event, env) {
  appendLine(operatorConsentPath(session, env), JSON.stringify(event));
  const line = logLine(event);
  appendLine(operatorLogPath(session, env), line);
  return line;
}

// Withdraws the live consents of the same project, kind and scope, refusing a revoke that matches none.
function revokeConsent({ session, base, answer, env }) {
  const live = liveConsents(session, env);
  const matches = live.filter((grant) => sameConsent(grant, base));
  if (matches.length === 0) {
    const shown = live.map((grant) => `${grant.kind} ${grant.scope}`).join("; ") || "none";
    throw new UserError(`no live consent is ${base.kind} ${base.scope} for this project; the live ones: ${shown}`);
  }
  const event = { ...base, revoke: true, ...(answer ? { answer } : {}) };
  return { revoked: matches.length, line: writeEvent(session, event, env) };
}

// Records what the person consented to (or withdrew) in one operator session, and answers the consent and its log line.
export function recordConsent({ session, project = null, kind, scope, reason, answer, revoke = false, env = process.env }) {
  if (!isId(session)) throw new UserError("only a `nightqueue open` session records a consent");
  if (!CONSENT_KINDS.includes(kind)) throw new UserError(`\`kind\` is one of ${CONSENT_KINDS.join(", ")}`);
  const normalized = normalizedScope({ kind, scope, project, env });
  const base = { at: new Date().toISOString(), project_id: project?.id ?? null, project: project?.name ?? null, kind, scope: normalized.scope };
  if (revoke === true) return revokeConsent({ session, base, answer: typeof answer === "string" ? answer.trim() : "", env });
  const consent = {
    ...base,
    session,
    pid: env?.NIGHTQUEUE_OPERATOR_PID ?? null,
    ...(normalized.argv ? { argv: normalized.argv } : {}),
    ...(normalized.exact ? { exact: true } : {}),
    reason: requiredText(reason, { field: "reason", max: BOUNDS.reason }),
    answer: requiredText(answer, { field: "answer", max: BOUNDS.answer }),
  };
  return { consent, line: writeEvent(session, consent, env) };
}

// Tells whether a path consent covers a canonical target: the scope itself, or below it unless the scope names one file.
function coversPath(consent, target) {
  if (consent.exact === true) return target === consent.scope;
  return insideRoots(target, [consent.scope]);
}

// Tells whether a command opens with a consent's words.
function opensWith(consent, argv) {
  const words = Array.isArray(consent.argv) ? consent.argv : [];
  return Array.isArray(argv) && words.length > 0 && words.every((word, index) => argv[index] === word);
}

// Tells whether a command consent covers a command: run in its project's checkout (a git-write also in its worktrees), and opening with the consented words.
function coversCommand(consent, { dir, argv }, env) {
  const roots = consent.kind === "git-write" ? maintenanceRoots(consent.project_id, env) : checkoutRootOf(consent.project_id, env);
  return insideRoots(dir, roots) && opensWith(consent, argv);
}

// Tells whether a run consent covers `doctor --fix` from any directory: only a consent that itself names `doctor --fix`.
function coversDoctorFix(consent, { argv }) {
  return isDoctorFix(consent.argv) && opensWith(consent, argv);
}

// Tells whether a home-maintenance consent covers a request: the exact same command, its git run in the consent's project checkout.
function coversHomeMaintenance(consent, { argv, gitDir }, env) {
  const words = Array.isArray(consent.argv) ? consent.argv : [];
  if (!Array.isArray(argv) || words.length === 0 || words.length !== argv.length || !words.every((word, index) => argv[index] === word)) return false;
  return !gitDir || insideRoots(gitDir, checkoutRootOf(consent.project_id, env));
}

// Tells whether one live consent covers a request of the same kind; nothing wider is ever inferred.
function covers(consent, request, env) {
  if (consent.kind !== request.kind) return false;
  if (request.kind === "edit" || request.kind === "create") return coversPath(consent, canonicalPath(request.target));
  if (request.kind === "connection-write") return consent.scope === request.scope;
  if (request.kind === HOME_MAINTENANCE) return coversHomeMaintenance(consent, request, env);
  if (request.home === true) return coversDoctorFix(consent, request);
  return coversCommand(consent, request, env);
}

// Tells whether a live consent of the session covers a request (`{kind, target}`, `{kind, dir, argv}` or `{kind, scope}`).
export function consentCovers(session, request, env = process.env) {
  if (!isId(session)) return false;
  return liveConsents(session, env).some((consent) => covers(consent, request, env));
}
