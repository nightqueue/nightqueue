import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { runDir } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { originEntry, readOriginFiles } from "../integrations/enrich.mjs";
import { registeredProject } from "../memory/registry-access.mjs";
import { COMMIT_TYPES } from "../queue/branch-name.mjs";
import { qaModeOf } from "../queue/check-contract.mjs";
import { DEPENDENT_PROMPT_REFUSAL } from "../queue/dependent-prompt.mjs";
import { nextFixLoop, nextRound } from "../queue/phase-artifacts.mjs";
import { isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { modelFor, PIPELINE_CONSTANTS } from "../queue/routing.mjs";
import { isProvisionalSlug } from "../queue/run-slug.mjs";
import { renderSkillTemplate, skillReferencesDir } from "../queue/skill-template.mjs";
import { openStore } from "../store/open.mjs";
import { callerContext, indexLine, phaseContextBlock, runInjectedLessonIds } from "./phase-context.mjs";
import { runTimelineLines } from "./run-timeline.mjs";

// The subagent every target launches, the agent whose model it runs on, the pipeline phase it belongs to, the one artifact it writes and that artifact's gate.
const TARGETS = {
  triager: { agent: "nightqueue:triager", model: "triager", phase: "triage", artifact: "01-triage.md", check: "01" },
  explore: { agent: "nightqueue:explore", model: "explore", phase: "explore", artifact: "02-explore.md", check: "02" },
  architect: { agent: "nightqueue:architect", model: "architect", phase: "architecture", artifact: "03-plan.md", check: "03" },
  coder: { agent: "nightqueue:coder", model: "coder", phase: "implementation", artifact: "04-implementation.md", check: "04" },
  "coder-fix": { agent: "nightqueue:coder", model: "coder", phase: "implementation", artifact: "04-implementation.md", check: "04" },
  verifier: { agent: "nightqueue:verifier", model: "verifier", phase: "verification", artifact: "06-verification.md", check: "06" },
  runtime: { agent: "nightqueue:verifier", model: "verifier", phase: "runtime", artifact: "07-runtime.md", check: "07" },
  "qa-lite": { agent: "nightqueue:qa-guardian", model: "qa-analyst", phase: "qa", artifact: "05-qa.md", check: "05" },
  "qa-analyst": { agent: "nightqueue:qa-guardian", model: "qa-analyst", phase: "qa", artifact: "05-qa.md", check: "05 --stage analyst" },
  "qa-prover": { agent: "nightqueue:qa-guardian", model: "qa-prover", phase: "qa", artifact: "05-qa.md", check: null },
  reflector: { agent: "nightqueue:reflector", model: "reflector", phase: null, artifact: null, check: null },
};

export const PROMPT_TARGETS = Object.keys(TARGETS);

// The lesson target of each template that carries a context block; a template missing here gets none.
export const LESSON_TARGET_OF = {
  triager: "triager",
  explore: "explore",
  architect: "architect",
  coder: "coder",
  verifier: "verifier",
  "qa-lite": "qa",
  "qa-analyst": "qa",
};

const BUG = "bug/error";
const INDEX_LIMIT = 40;
const BRIEF_FILE = "00-brief.md";
const ROUND_TARGETS = ["verifier", "runtime", "qa-lite", "qa-analyst"];
const INJECTED_LIMIT = 40;
const NONE_RECORDED = "none recorded";

const NO_DEMO_REPO = "none configured";
const QA_TARGET_MODE = { "qa-lite": "lite", "qa-analyst": "full", "qa-prover": "full" };
const QUERY_WORDS = 12;
const BRIEF_WRITER = "run `nightqueue run check 01` first: it writes the Brief from the triage's `## Brief`";

// The directory the prompt templates ship in, inside the plugin of this runtime.
export function promptsDir() {
  return join(skillReferencesDir(), "prompts");
}

// Renders one prompt template with its values; an unresolved placeholder throws.
export function renderTemplate(name, values) {
  return renderSkillTemplate(promptsDir(), name, values);
}

// The `## Brief` section of the run's brief, refusing a run whose brief was never written.
function readBrief(dir) {
  const path = join(dir, BRIEF_FILE);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new UserError(`the run has no Brief at ${path}: ${BRIEF_WRITER}`);
  }
  const start = text.search(/^## Brief\s*$/m);
  if (start < 0) throw new UserError(`${path} has no \`## Brief\` section: ${BRIEF_WRITER}`);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end + 1)).trim();
}

// One `**Field:** value` of the Brief, or an empty text when the Brief does not carry it.
function briefField(brief, field) {
  const line = brief.split("\n").find((text) => text.trim().startsWith(`**${field}:**`));
  return line ? line.trim().slice(field.length + 5).trim() : "";
}

// The run's recorded type, required by every target but the triager, which records it.
function requireType(state, target) {
  const type = isStateObject(state) && state.type ? state.type : null;
  if (!type && target !== "triager") throw new UserError("the run has no type recorded yet: run `nightqueue run check 01` first");
  return type;
}

// Where the code of the run lives: the recorded worktree, else the registered checkout of its project, named in an open item.
function repositoryOf({ run, state, env, openItems }) {
  const worktree = isStateObject(state) && typeof state.worktree === "string" ? state.worktree.trim() : "";
  if (worktree) return worktree;
  const path = registeredProject(run.project, env)?.path;
  if (!path) throw new UserError(`the run of \`${run.project}\` has no worktree recorded and its project has no checkout registered`);
  openItems.push(`the run has no worktree recorded; Repository is the registered checkout of \`${run.project}\` (${path})`);
  return path;
}

// Runs one best-effort lookup, turning a failure into an open item instead of a missing prompt.
async function tolerant(openItems, what, fallback, lookup) {
  try {
    return await lookup();
  } catch (error) {
    openItems.push(`${what} failed: ${error?.message ?? String(error)}`);
    return fallback;
  }
}

// The context block of a template that carries one, with the same recall `context_for_phase` makes.
async function contextBlock({ template, query, run, repo, env, openItems }) {
  const target = LESSON_TARGET_OF[template];
  if (!target) return "";
  const answer = await tolerant(openItems, "the context block", { block: "" }, () =>
    phaseContextBlock({ target, query, project: run.project, repoRoot: repo, origin: template !== "triager" }, env),
  );
  return answer.block ?? "";
}

// The known index of the project for the explore's map.
async function indexValues({ template, query, run, repo, env, openItems }) {
  const empty = { INDEX_MAP: "", INDEX_LIBS: "" };
  if (template !== "explore" || !run.projectId) return empty;
  const { files, libs } = await tolerant(openItems, "the index recall", { files: [], libs: [] }, () =>
    openStore(env).index.recallProjectIndex({ projectId: run.projectId, repoRoot: repo, query, limit: INDEX_LIMIT }),
  );
  const libText = libs.map((lib) => `${lib.lib}@${lib.version}`).join(", ");
  return { INDEX_MAP: files.map(indexLine).join("\n"), INDEX_LIBS: libText || "none" };
}

// True when the plan of the run carries a `## Usage coverage` section.
function planHasUsageCoverage(dir) {
  try {
    return /^## Usage coverage\s*$/m.test(readFileSync(join(dir, "03-plan.md"), "utf8"));
  } catch {
    return false;
  }
}

// The text of one handoff of the run directory, or an empty text when it was never written.
function readHandoff(dir, file) {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return "";
  }
}

// The `## Round` number this launch appends to its append-only artifact, or an empty text for a target that writes none.
function roundOf(target, dir, artifact) {
  return ROUND_TARGETS.includes(target) ? String(nextRound(readHandoff(dir, artifact))) : "";
}

// The id the runtime stamps on a prover's round: the group's slug plus a hash of the group, so two groups never share it.
export function groupIdOf(group) {
  const slug = String(group ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const hash = createHash("sha256").update(String(group ?? "")).digest("hex").slice(0, 8);
  return slug === "" ? hash : `${slug}-${hash}`;
}

// The group id of a prover's launch, or an empty text for any other target.
function groupIdValue(target, group) {
  return target === "qa-prover" ? groupIdOf(group) : "";
}

// The draft a prover writes its round to before `run append 05`, named by its group id; an empty text for any other target.
function draftPathOf(target, dir, group) {
  return target === "qa-prover" ? join(dir, "poc", `qa-round-${groupIdOf(group)}.md`) : "";
}

// The `### Fix loop` number a fix-loop coder appends to the implementation artifact, or an empty text for any other target.
function fixLoopOf(target, dir) {
  return target === "coder-fix" ? String(nextFixLoop(readHandoff(dir, TARGETS["coder-fix"].artifact))) : "";
}

// The lessons this job's session was given, one `- [L<id>] <title>` line each; none outside a job.
async function injectedLessonLines(env) {
  const { sessionId } = await callerContext(env);
  const ids = runInjectedLessonIds(sessionId, env).slice(0, INJECTED_LIMIT);
  const store = openStore(env);
  const lessons = await Promise.all(ids.map((id) => store.lessons.getLesson(id)));
  const lines = lessons.filter(Boolean).map((lesson) => `- [L${lesson.id}] ${lesson.title}`);
  return lines.length ? lines.join("\n") : NONE_RECORDED;
}

// The reflector's run timeline and given lessons; every other template gets empty texts.
async function reflectorValues({ template, run, state, env, openItems }) {
  if (template !== "reflector") return { TIMELINE: "", INJECTED_LESSONS: "" };
  return {
    TIMELINE: await runTimelineLines({ run, state, env, openItems }),
    INJECTED_LESSONS: await tolerant(openItems, "the lessons given to this run", NONE_RECORDED, () => injectedLessonLines(env)),
  };
}

// A text argument of the call, trimmed, or an empty text.
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Refuses a call whose `group` does not match its target: required by the qa-prover, refused by every other target.
function requireGroupRule(args) {
  const hasGroup = text(args.group) !== "";
  if (args.target === "qa-prover" && !hasGroup) throw new UserError("`group` is required with `target: \"qa-prover\"`: the IDs/label of the same-root group");
  if (args.target !== "qa-prover" && hasGroup) throw new UserError(`\`group\` is only accepted with \`target: "qa-prover"\`, not with \`target: "${args.target}"\`: drop it to render this lane's own report`);
}

// Refuses a `request` on any target but the triager, the only one that reads the request instead of the Brief.
function requireRequestRule(args) {
  if (args.target !== "triager" && text(args.request) !== "") {
    throw new UserError(`\`request\` is only accepted with \`target: "triager"\`, not with \`target: "${args.target}"\`: every other target reads the Brief of 00-brief.md`);
  }
}

// The caller's own job row, or null outside a job or when the store cannot read it (named in an open item).
async function ownJobRow(env, openItems) {
  const id = callerJobId(env);
  if (id === null) return null;
  return tolerant(openItems, "reading this job's row", null, () => openStore(env).jobs.getJob(id));
}

// The operator's answer to the gate, appended to the request unless the prompt already carries it.
function operatorAnswer(note, prompt) {
  const answer = typeof note === "string" ? note.trim() : "";
  return answer && !prompt.includes(answer) ? `\n\nOperator answer to the gate: ${answer}` : "";
}

// The request the triager reads: the job's own prompt inside a job, else the `request` argument.
function rawRequest({ job, args, env, openItems }) {
  const asked = text(args.request);
  const prompt = typeof job?.prompt === "string" ? job.prompt.trim() : "";
  if (prompt) {
    if (asked) openItems.push("`request` was ignored: inside a job the triager reads the job's own prompt");
    return prompt + operatorAnswer(job.operator_note, prompt);
  }
  if (asked) return asked;
  if (callerJobId(env) !== null) throw new UserError("this job's prompt could not be read: pass the request as `request`");
  throw new UserError('`request` is required with `target: "triager"` outside a job: the user\'s request, verbatim');
}

// The values only the triager reads: the raw request, its origin data, whether it names the slug, and the fixed lists it chooses from.
async function triagerValues({ args, run, dir, env, openItems }) {
  const fixed = { COMMIT_TYPES: COMMIT_TYPES.join(", "), DEPENDENT_REFUSAL: DEPENDENT_PROMPT_REFUSAL };
  if (args.target !== "triager") return { ...fixed, RAW_REQUEST: "", ORIGIN: "", NEEDS_SLUG: false };
  const job = await ownJobRow(env, openItems);
  return {
    ...fixed,
    RAW_REQUEST: rawRequest({ job, args, env, openItems }),
    ORIGIN: readOriginFiles(join(dir, "origin")).map(originEntry).join("\n\n"),
    NEEDS_SLUG: isProvisionalSlug(job, run.slug),
  };
}

// The first words of a text, the recall query of a prompt that has no Brief yet.
function leadingWords(source) {
  return source.split(/\s+/).filter(Boolean).slice(0, QUERY_WORDS).join(" ");
}

// The values every template may read, resolved from the run and the call.
async function promptValues({ args, template, run, state, env, openItems }) {
  const type = requireType(state, args.target);
  requireRequestRule(args);
  const dir = runDir(run.projectId, run.slug, env);
  const brief = args.target === "triager" ? "" : readBrief(dir);
  const triage = await triagerValues({ args, run, dir, env, openItems });
  const repo = repositoryOf({ run, state, env, openItems });
  const query = text(args.query) || briefField(brief, "Affected area") || leadingWords(triage.RAW_REQUEST);
  const lookup = { template, query, run, repo, env, openItems };
  requireGroupRule(args);
  const ownArtifact = TARGETS[args.target]?.artifact;
  return {
    RUN_DIR: dir,
    REPOSITORY: repo,
    PROJECT: run.project,
    TYPE: type ?? "",
    BRIEF: brief,
    AFFECTED_AREA: briefField(brief, "Affected area"),
    OBJECTIVE: briefField(brief, "Objective"),
    EXPECTED_OUTCOME: briefField(brief, "Expected outcome"),
    BUG_ACCOUNT: briefField(brief, "Bug account") || "not identified",
    VERIFIER_SCOPE: PIPELINE_CONSTANTS.verifierScope,
    CLAUDE_MD: existsSync(join(repo, "CLAUDE.md")) ? join(repo, "CLAUDE.md") : "",
    CONTEXT_BLOCK: await contextBlock(lookup),
    ...(await indexValues(lookup)),
    IS_BUG: type === BUG,
    TRIAGED: existsSync(join(dir, "01-triage.md")),
    HAS_USAGE_COVERAGE: planHasUsageCoverage(dir),
    PLUGIN_ROOT: join(packageRoot(), "plugin"),
    ...triage,
    DELIVERY_CONSTRAINTS: text(args.delivery_constraints),
    STAGE: text(args.stage),
    GROUP: text(args.group),
    NOTE: text(args.note),
    ROUND: roundOf(args.target, dir, ownArtifact),
    FIX_LOOP: fixLoopOf(args.target, dir),
    DRAFT_PATH: draftPathOf(args.target, dir, text(args.group)),
    GROUP_ID: groupIdValue(args.target, text(args.group)),
    DEMO_REPO: await demoRepoValue({ run, env, openItems }),
    ...(await reflectorValues({ template, run, state, env, openItems })),
  };
}

// The demo repository of the run's project as the request shows it: its path, or `none configured`.
async function demoRepoValue({ run, env, openItems }) {
  if (!run.projectId) return NO_DEMO_REPO;
  const path = await tolerant(openItems, "the project's demo repository", null, () => openStore(env).projects.demoRepo(run.projectId));
  return path || NO_DEMO_REPO;
}

// The agent model overrides of the run's project, or null without a project or when the store cannot read them (named in an open item).
async function runProjectAgents({ run, env, openItems }) {
  if (!run.projectId) return null;
  return tolerant(openItems, "the project's agent models", null, () => openStore(env).projects.agents(run.projectId));
}

// Names in an open item a QA target the plan's QA mode does not ask (`qa-lite` under `full`, the analyst or a prover under `lite`); no plan, no item.
function noteQaModeMismatch({ target, dir, openItems }) {
  const wanted = QA_TARGET_MODE[target];
  const plan = wanted ? readHandoff(dir, "03-plan.md") : "";
  if (plan.trim() === "") return;
  const mode = qaModeOf(plan);
  if (mode !== wanted) openItems.push(`the plan's QA mode is ${mode} (\`run check 03\`); ${target} was rendered anyway`);
}

// The complete prompt of one subagent of THIS run, with the agent, its model (the default or the project's override), the artifact and the gate the orchestrator passes through unchanged.
export async function phasePrompt(args, { run, env = process.env }) {
  const spec = TARGETS[args?.target];
  if (!spec) throw new UserError(`unknown target \`${String(args?.target)}\`; accepted: ${PROMPT_TARGETS.join(", ")}`);
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env });
  requireType(state, args.target);
  const template = args.target;
  const openItems = [];
  const values = await promptValues({ args, template, run, state, env, openItems });
  noteQaModeMismatch({ target: args.target, dir: values.RUN_DIR, openItems });
  const model = modelFor(spec.model, await runProjectAgents({ run, env, openItems }));
  return {
    prompt: renderTemplate(template, values),
    subagent_type: spec.agent,
    model,
    artifact: spec.artifact === null ? null : join(values.RUN_DIR, spec.artifact),
    check: spec.check,
    open_items: openItems,
  };
}
