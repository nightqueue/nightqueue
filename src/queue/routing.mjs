/*
 * The track routing of the /resolve pipeline: the single source of every value that changes with the tier.
 * `nightqueue run start` answers the row of the run's tier and `phase_prompt` reads it, so no prompt restates it.
 *
 * Routing rationale (moved verbatim from Appendix A of the resolve skill):
 *
 * The routing table (Phase 0) is the source of truth. When changing it, decide the
 * Claude model by these 3 questions — the **dominant** capability of the phase wins:
 *
 * | Question (YES →) | Model |
 * | ---------------- | ------ |
 * | Does it write/edit code or require deep design judgment? | `opus` (complex) / `sonnet` (simple) |
 * | Does it require reasoning or a broad search without generating code in bulk? | `sonnet` (exploration, QA, complex triage) |
 * | Is it a deterministic and cheap gate (it only runs commands and gives a verdict)? | `haiku` |
 *
 * Exceptions: **QA** does not edit source (it only writes PoCs) and its core is adversarial
 * reasoning + regression analysis → `sonnet`, not `opus`. **Triager** does not edit,
 * but reproduces the bug by running/instrumenting the
 * code → `haiku` (simple) / `sonnet` (complex). Phases 0/7/8 run in the orchestrator
 * (the skill's model, without routing).
 *
 * The `simple` tier has no architect and no qa-guardian: its safety net is the verifier's full
 * test suite, not a second reviewer — a tier is raised to `complex` on evidence found, never on
 * the shape of the change.
 */

import { UserError } from "../config/errors.mjs";
import { PIPELINE_TASK_TYPES, PIPELINE_TIERS } from "../memory/runs.mjs";
import { RESUME_PHASE_ORDER } from "./resume.mjs";

const NOT_RUN = "—";
const BUG = "bug/error";
const QA_METHODS =
  "automated; + api for an API change; + emulator for a UI change in an Expo repo; + browser for a UI change in a web repo";
const IMPLEMENTATION_GATE = "written by the coder, gate `nightqueue run check 04`";

// The routing table, one row per line of the old skill table, each cell with its text for trivial, simple and complex.
export const TRACK_ROUTING = [
  ["Track", ["Fast Lite", "Fast", "Standard"]],
  ["Phases that run", ["0 · 4 · 6 · 7 · 8", "0 · 1 (bug only) · 4 · 6 · 7 · 8", "every phase, 0 to 8"]],
  ["🔍 triager", [NOT_RUN, "haiku (bug only)", "sonnet"]],
  ["🧭 Explore", [NOT_RUN, NOT_RUN, "sonnet"]],
  ["📐 architect", [NOT_RUN, NOT_RUN, "opus"]],
  ["⚙️ coder", ["sonnet", "sonnet", "opus"]],
  ["🛡️ qa-guardian", [NOT_RUN, NOT_RUN, "sonnet"]],
  ["✅ verifier", ["haiku", "haiku", "sonnet"]],
  [
    "Verifier scope",
    [
      "tsc + lint + the tests of the files that were touched (no build, no full suite)",
      "tsc + lint + the project's FULL test suite (no QA PoCs in this tier)",
      "the project's real checks (typecheck, lint, build, tests) + the QA's PoCs",
    ],
  ],
  ["QA methods of the PR", [QA_METHODS, QA_METHODS, QA_METHODS]],
  ["Max fix iterations", ["1", "2", "2"]],
  ["Request critique (step 2.5)", ["skipped", "mandatory", "mandatory"]],
  ["`<CWD>/CLAUDE.md`", ["not named to the coder", "named to the coder when it exists", "named to the coder (Phase 4)"]],
  ["`index_recall`", ["no", "yes, to locate the affected files", "yes, in Phase 2 before the Explore"]],
  ["`context_for_phase` for the coder", ["no", "yes", "yes"]],
  ["`04-implementation.md`", [IMPLEMENTATION_GATE, IMPLEMENTATION_GATE, IMPLEMENTATION_GATE]],
  ["Time target", ["under 5 minutes", "under 15 minutes", "none — the depth is the target"]],
];

// The agent each model row routes, by the label of its row.
const AGENT_ROWS = {
  triager: "🔍 triager",
  explore: "🧭 Explore",
  architect: "📐 architect",
  coder: "⚙️ coder",
  qaGuardian: "🛡️ qa-guardian",
  verifier: "✅ verifier",
};

// The pipeline phases each tier runs, in the canonical order; the simple tier adds the triage on a bug only.
const TIER_PHASES = {
  trivial: ["implementation", "verification", "commit"],
  simple: ["implementation", "verification", "commit"],
  complex: [...RESUME_PHASE_ORDER],
};

// Refuses a tier outside the pipeline's own, naming the accepted ones.
function requireTier(tier) {
  if (PIPELINE_TIERS.includes(tier)) return tier;
  throw new UserError(`unknown tier \`${String(tier)}\`; accepted: ${PIPELINE_TIERS.join(", ")}`);
}

// Refuses a task type outside the pipeline's own, naming the accepted ones.
function requireType(type) {
  if (PIPELINE_TASK_TYPES.includes(type)) return type;
  throw new UserError(`unknown type \`${String(type)}\`; accepted: ${PIPELINE_TASK_TYPES.join(", ")}`);
}

// The text of one cell of the table for a tier.
function cellOf(label, tier) {
  const row = TRACK_ROUTING.find(([name]) => name === label);
  if (!row) throw new Error(`the routing table has no row \`${label}\``);
  return row[1][PIPELINE_TIERS.indexOf(tier)];
}

// The model a model cell names, or null when the agent does not run in the tier.
function modelOf(cell) {
  return cell === NOT_RUN ? null : cell.split(" ")[0];
}

// The whole row of one tier: every cell as it reads, plus the values the runtime acts on.
export function routingRow(tier) {
  requireTier(tier);
  const cells = Object.fromEntries(TRACK_ROUTING.map(([label]) => [label, cellOf(label, tier)]));
  const models = Object.fromEntries(Object.entries(AGENT_ROWS).map(([agent, label]) => [agent, modelOf(cells[label])]));
  return {
    tier,
    track: cells.Track,
    models,
    triagerBugOnly: cells[AGENT_ROWS.triager].includes("(bug only)"),
    verifierScope: cells["Verifier scope"],
    qaMethods: cells["QA methods of the PR"],
    maxFixIterations: Number(cells["Max fix iterations"]),
    requestCritique: cells["Request critique (step 2.5)"],
    claudeMd: cells["`<CWD>/CLAUDE.md`"] !== "not named to the coder",
    indexRecall: cells["`index_recall`"] !== "no",
    contextForCoder: cells["`context_for_phase` for the coder"] === "yes",
    timeTarget: cells["Time target"],
    cells,
  };
}

// The whole routing table as markdown, one line per row, which `nightqueue run start --routing` prints.
export function routingTable() {
  const rows = TRACK_ROUTING.map(([label, cells]) => `| ${label} | ${cells.join(" | ")} |`);
  return ["| Routing | trivial | simple | complex |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

// The canonical phases a run of this tier and type goes through, in order.
export function phasesFor(tier, type) {
  requireType(type);
  const phases = TIER_PHASES[requireTier(tier)];
  if (tier === "simple" && type === BUG) return ["triage", ...phases];
  return [...phases];
}

// The nine slots of the studio track, in order: the number, the label, the routing agent key and the canonical phase of each.
export const TRACK_SLOTS = [
  { number: 0, name: "brief", agent: null, phase: null },
  { number: 1, name: "triager", agent: "triager", phase: "triage" },
  { number: 2, name: "explore", agent: "explore", phase: "explore" },
  { number: 3, name: "architect", agent: "architect", phase: "architecture" },
  { number: 4, name: "coder", agent: "coder", phase: "implementation" },
  { number: 5, name: "qa-guardian", agent: "qaGuardian", phase: "qa" },
  { number: 6, name: "verifier", agent: "verifier", phase: "verification" },
  { number: 7, name: "runtime", agent: null, phase: "runtime" },
  { number: 8, name: "commit · PR", agent: null, phase: "commit" },
];

const LANE_SLOTS = TRACK_SLOTS.filter((slot) => slot.number >= 1 && slot.number <= 6);

// The phases of the agent slots (1 to 6) the run does not go through: from its tier and type, from the tier alone while the type is unknown, none for an unknown tier.
export function offTierPhases(tier, type) {
  if (!PIPELINE_TIERS.includes(tier)) return [];
  if (PIPELINE_TASK_TYPES.includes(type)) {
    const phases = phasesFor(tier, type);
    return LANE_SLOTS.filter((slot) => !phases.includes(slot.phase)).map((slot) => slot.phase);
  }
  const numbers = trackPhaseNumbers(tier);
  return LANE_SLOTS.filter((slot) => !numbers.includes(slot.number)).map((slot) => slot.phase);
}

// The numbers of the pipeline phases the tier's track runs, read from its "Phases that run" cell; null for a tier outside the pipeline.
export function trackPhaseNumbers(tier) {
  if (!PIPELINE_TIERS.includes(tier)) return null;
  const cell = cellOf("Phases that run", tier);
  if (cell.startsWith("every phase")) return Array.from({ length: 9 }, (_, number) => number);
  return cell.split("·").map((part) => Number.parseInt(part, 10));
}

// The emoji of an agent's row in the routing table, or null for a name with no row (the orchestrator).
export function agentGlyph(agent) {
  const name = String(agent ?? "").toLowerCase();
  if (!name) return null;
  const row = TRACK_ROUTING.find(([label]) => label.split(" ").slice(1).join(" ").toLowerCase() === name);
  return row ? row[0].split(" ")[0] : null;
}

// The TaskCreate subjects' phase prefixes of a run: one task per phase that runs.
export function tasksFor(tier, type) {
  return phasesFor(tier, type);
}
