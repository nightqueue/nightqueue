import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { runDir } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { decisionTitleLine } from "../memory/decisions.mjs";
import { decisionRef } from "../memory/refs.mjs";
import { registeredProject } from "../memory/registry-access.mjs";
import { isStateObject, readRunState } from "../queue/resume.mjs";
import { phasesFor, routingRow } from "../queue/routing.mjs";
import { renderSkillTemplate, skillReferencesDir } from "../queue/skill-template.mjs";
import { openStore } from "../store/open.mjs";
import { indexLine, phaseContextBlock } from "./phase-context.mjs";

// The subagent every target launches, the routing row that names its model, the pipeline phase it belongs to, and its artifact gate.
const TARGETS = {
  triager: { agent: "nightqueue:triager", model: "triager", phase: "triage", artifact: "01-triage.md", check: "01" },
  explore: { agent: "nightqueue:explore", model: "explore", phase: "explore", artifact: "02-explore.md", check: "02" },
  architect: { agent: "nightqueue:architect", model: "architect", phase: "architecture", artifact: "03-plan.md", check: "03" },
  coder: { agent: "nightqueue:coder", model: "coder", phase: "implementation", artifact: "04-implementation.md", check: "04" },
  "coder-fix": { agent: "nightqueue:coder", model: "coder", phase: "implementation", artifact: "04-implementation.md", check: "04" },
  verifier: { agent: "nightqueue:verifier", model: "verifier", phase: "verification", artifact: "06-verification.md", check: "06" },
  runtime: { agent: "nightqueue:verifier", model: "verifier", phase: "runtime", artifact: "06-runtime.md", check: "06.5" },
  "qa-lite": { agent: "nightqueue:qa-guardian", model: "qaGuardian", phase: "qa", artifact: "05-qa.md", check: "05" },
  "qa-analyst": { agent: "nightqueue:qa-guardian", model: "qaGuardian", phase: "qa", artifact: "05a-qa-analyst.md", check: "05a" },
  "qa-prover": { agent: "nightqueue:qa-guardian", model: "qaGuardian", phase: "qa", artifact: null, check: null },
};

export const PROMPT_TARGETS = Object.keys(TARGETS);

// The lesson target of each template that carries a context block; a template missing here gets none.
export const LESSON_TARGET_OF = {
  "coder-fast": "coder",
  triager: "triager",
  explore: "explore",
  architect: "architect",
  coder: "coder",
  verifier: "verifier",
  "qa-lite": "qa",
  "qa-analyst": "qa",
};

const BUG = "bug/error";
const FAST_TIERS = ["trivial", "simple"];
const INDEX_LIMIT = 40;
const DECISION_LIMIT = 8;
const BRIEF_FILE = "00-brief.md";
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

// The directory the prompt templates ship in, inside the plugin of this runtime.
export function promptsDir() {
  return join(skillReferencesDir(), "prompts");
}

// Renders one prompt template with its values; an unresolved placeholder throws.
export function renderTemplate(name, values) {
  return renderSkillTemplate(promptsDir(), name, values);
}

// The template a target renders for a tier: the fast tracks have their own coder and verifier prompts.
export function templateOf(target, tier) {
  if ((target === "coder" || target === "verifier") && FAST_TIERS.includes(tier)) return `${target}-fast`;
  return target;
}

// The `## Brief` section of the run's brief, refusing a run whose brief was never written.
function readBrief(dir) {
  const path = join(dir, BRIEF_FILE);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new UserError(`write the Brief to ${path} first (then \`nightqueue run check 00\`)`);
  }
  const start = text.search(/^## Brief\s*$/m);
  if (start < 0) throw new UserError(`${path} has no \`## Brief\` section: write the Brief there first (then \`nightqueue run check 00\`)`);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end + 1)).trim();
}

// One `**Field:** value` of the Brief, or an empty text when the Brief does not carry it.
function briefField(brief, field) {
  const line = brief.split("\n").find((text) => text.trim().startsWith(`**${field}:**`));
  return line ? line.trim().slice(field.length + 5).trim() : "";
}

// The run's recorded tier and type, refusing a run that `run start` never recorded.
function requireTierAndType(state) {
  const tier = isStateObject(state) ? state.tier : null;
  const type = isStateObject(state) ? state.type : null;
  if (!tier || !type) throw new UserError("the run has no tier and type recorded yet: run `nightqueue run start` first");
  return { tier, type };
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
async function contextBlock({ template, row, query, run, repo, env, openItems }) {
  const target = LESSON_TARGET_OF[template];
  if (!target || (template === "coder-fast" && !row.contextForCoder)) return "";
  const answer = await tolerant(openItems, "the context block", { block: "" }, () =>
    phaseContextBlock({ target, query, project: run.project, repoRoot: repo }, env),
  );
  return answer.block ?? "";
}

// The known index of the project for the fast coder's paths and the explore's map.
async function indexValues({ template, row, query, run, repo, env, openItems }) {
  const empty = { INDEX_PATHS: "", INDEX_MAP: "", INDEX_LIBS: "" };
  const wanted = template === "explore" || (template === "coder-fast" && row.indexRecall);
  if (!wanted || !run.projectId) return empty;
  const { files, libs } = await tolerant(openItems, "the index recall", { files: [], libs: [] }, () =>
    openStore(env).index.recallProjectIndex({ projectId: run.projectId, repoRoot: repo, query, limit: INDEX_LIMIT }),
  );
  if (template === "coder-fast") return { ...empty, INDEX_PATHS: files.map((file) => `- ${file.path}`).join("\n") };
  const libText = libs.map((lib) => `${lib.lib}@${lib.version}`).join(", ");
  return { ...empty, INDEX_MAP: files.map(indexLine).join("\n"), INDEX_LIBS: libText || "none" };
}

// One detail line of a standing decision, the whole `decision` on one line.
function decisionDetailLine(row) {
  const title = String(row?.title ?? "").replace(/\s+/g, " ").trim();
  const decision = String(row?.decision ?? "").replace(/\s+/g, " ").trim();
  return `- ${decisionRef(row)} ${title} — ${decision}`;
}

// The architect's standing and proposed decisions, built by the session block's own title line and one recall of the 8 closest.
async function decisionValues({ template, brief, run, env, openItems }) {
  const empty = { STANDING_TITLES: "", STANDING_DETAIL: "", PROPOSED_TITLES: "" };
  if (template !== "architect" || !run.projectId) return empty;
  const decisions = openStore(env).decisions;
  const query = `${briefField(brief, "Affected area")} ${briefField(brief, "Objective")}`.trim();
  return await tolerant(openItems, "the decision tools (the architect got no `## Standing decisions`)", empty, async () => {
    const titles = await decisions.decisionTitles({ projectId: run.projectId, status: "accepted" });
    const closest = await decisions.recallDecisions({ projectId: run.projectId, query, limit: DECISION_LIMIT });
    const proposed = await decisions.decisionTitles({ projectId: run.projectId, status: "proposed" });
    return {
      STANDING_TITLES: titles.map(decisionTitleLine).join("\n"),
      STANDING_DETAIL: closest.filter((row) => row?.via !== "fallback").map(decisionDetailLine).join("\n"),
      PROPOSED_TITLES: proposed.map(decisionTitleLine).join("\n"),
    };
  });
}

// True when the plan of the run carries a `## Usage coverage` section.
function planHasUsageCoverage(dir) {
  try {
    return /^## Usage coverage\s*$/m.test(readFileSync(join(dir, "03-plan.md"), "utf8"));
  } catch {
    return false;
  }
}

// The artifact the runtime lane writes: its own by default, or the one the call names (the post-merge measure of step 0.6).
function runtimeArtifact(target, artifact) {
  const name = typeof artifact === "string" ? artifact.trim() : "";
  if (!name) return TARGETS.runtime.artifact;
  if (target !== "runtime") throw new UserError("`artifact` is only accepted with `target: \"runtime\"`");
  if (!ARTIFACT_NAME.test(name)) throw new UserError(`invalid \`artifact\` \`${name}\`: one \`.md\` file name inside the run directory`);
  return name;
}

// A text argument of the call, trimmed, or an empty text.
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// The values every template may read, resolved from the run and the call.
async function promptValues({ args, template, run, state, env, openItems }) {
  const { tier, type } = requireTierAndType(state);
  const dir = runDir(run.projectId, run.slug, env);
  const brief = readBrief(dir);
  const row = routingRow(tier);
  const repo = repositoryOf({ run, state, env, openItems });
  const query = text(args.query) || briefField(brief, "Affected area");
  const lookup = { template, row, query, run, repo, env, openItems, brief };
  if (args.target === "qa-prover" && !text(args.group)) throw new UserError("`group` is required with `target: \"qa-prover\"`: the IDs/label of the same-root group");
  return {
    RUN_DIR: dir,
    REPOSITORY: repo,
    PROJECT: run.project,
    TIER: tier,
    TYPE: type,
    BRIEF: brief,
    AFFECTED_AREA: briefField(brief, "Affected area"),
    OBJECTIVE: briefField(brief, "Objective"),
    EXPECTED_OUTCOME: briefField(brief, "Expected outcome"),
    BUG_ACCOUNT: briefField(brief, "Bug account") || "not identified",
    VERIFIER_SCOPE: row.verifierScope,
    CLAUDE_MD: row.claudeMd && existsSync(join(repo, "CLAUDE.md")) ? join(repo, "CLAUDE.md") : "",
    CONTEXT_BLOCK: await contextBlock(lookup),
    ...(await indexValues(lookup)),
    ...(await decisionValues(lookup)),
    IS_BUG: type === BUG,
    SIMPLE: tier === "simple",
    TRIAGED: existsSync(join(dir, "01-triage.md")),
    HAS_USAGE_COVERAGE: planHasUsageCoverage(dir),
    PLUGIN_ROOT: join(packageRoot(), "plugin"),
    RAW_EVIDENCE: type === BUG ? text(args.raw_evidence) : "",
    DELIVERY_CONSTRAINTS: text(args.delivery_constraints),
    STAGE: text(args.stage),
    GROUP: text(args.group),
    NOTE: text(args.note),
    ARTIFACT: runtimeArtifact(args.target, args.artifact),
  };
}

// The model of the target's agent in the run's tier; an agent the tier does not route takes the complex model, with an open item.
function modelFor(spec, { tier, type }, openItems) {
  const planned = phasesFor(tier, type).includes(spec.phase);
  const model = routingRow(tier).models[spec.model];
  if (planned && model) return model;
  openItems.push(`the ${spec.phase} phase does not run in the ${tier} tier (${type}); rendered anyway, with the complex-tier model (a tier raise may be under way)`);
  return routingRow("complex").models[spec.model];
}

// The complete prompt of one subagent of THIS run, with the agent, the model, the artifact and the gate the orchestrator passes through unchanged.
export async function phasePrompt(args, { run, env = process.env }) {
  const spec = TARGETS[args?.target];
  if (!spec) throw new UserError(`unknown target \`${String(args?.target)}\`; accepted: ${PROMPT_TARGETS.join(", ")}`);
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env });
  const { tier, type } = requireTierAndType(state);
  const template = templateOf(args.target, tier);
  const openItems = [];
  const values = await promptValues({ args, template, run, state, env, openItems });
  const model = modelFor(spec, { tier, type }, openItems);
  const artifact = args.target === "runtime" ? values.ARTIFACT : spec.artifact;
  return {
    prompt: renderTemplate(template, values),
    subagent_type: spec.agent,
    model,
    artifact: artifact === null ? null : join(values.RUN_DIR, artifact),
    check: artifact === spec.artifact ? spec.check : null,
    open_items: openItems,
  };
}
