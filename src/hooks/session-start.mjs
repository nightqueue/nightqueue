import { updateNoticeLine } from "../host/update-notice.mjs";
import { PROPOSED_HEADING, STANDING_HEADING, decisionTitleLine } from "../memory/decisions.mjs";
import { projectFromCwd } from "../memory/project-name.mjs";
import { ownerLabel } from "../memory/scope.mjs";
import { openStore } from "../store/open.mjs";
import { clip, section } from "./block.mjs";
import { recordInjected } from "./state.mjs";

const LESSON_LIMIT = 12;
const MEMORY_LIMIT = 10;
const DECISION_LIMIT = 8;
const DECISION_MAX = 200;
const MAX_OUTPUT = 9000;
const LESSONS_FLOOR = 3500;
const PROPOSED_BUDGET = 1000;
const OMISSION_RESERVE = 80;
const HEADER = "# Nightqueue context";
const FOOTER = "Call `lesson_save` as soon as an error costs a second attempt, and `lesson_recall` before acting.";
const DECISIONS_ROOM = MAX_OUTPUT - HEADER.length - FOOTER.length - 4 - LESSONS_FLOOR;

// Joins a heading and its lines into a section, or nothing when there is no line.
function sectionOf(heading, lines) {
  return lines.length ? `## ${heading}\n${lines.join("\n")}` : "";
}

// The leading lines whose section stays within the budget.
function leadingLines(heading, lines, budget) {
  const kept = [];
  let used = heading.length + 3;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return kept;
}

// The line closing a title section that could not list every title.
function omissionLine(count) {
  return `- ${count} more title(s) left out; \`decision_list\` has them all.`;
}

// Lists every title when they fit the budget, else the ones that fit and how many were left out.
function titlesSection(heading, rows, budget) {
  const lines = rows.map(decisionTitleLine);
  const whole = sectionOf(heading, lines);
  if (whole.length <= budget) return whole;
  const kept = leadingLines(heading, lines, budget - OMISSION_RESERVE);
  return sectionOf(heading, [...kept, omissionLine(lines.length - kept.length)]);
}

// Characters the given sections take in the block, separators included.
function spent(sections) {
  return sections.reduce((total, text) => total + (text ? text.length + 2 : 0), 0);
}

// The decision sections, each within its own budget so the lessons always keep their floor and the detail gives way first.
function decisionSections({ titles, decisions, proposed }) {
  const pending = titlesSection(PROPOSED_HEADING, proposed, PROPOSED_BUDGET);
  const standing = titlesSection(STANDING_HEADING, titles, DECISIONS_ROOM - spent([pending]));
  const detailHeading = `${STANDING_HEADING} in detail`;
  const detailLines = leadingLines(detailHeading, decisions.map(decisionLine), DECISIONS_ROOM - spent([pending, standing]));
  return [standing, sectionOf(detailHeading, detailLines), pending];
}

// One lesson line of the session block.
function lessonLine(lesson) {
  const scope = lesson.project ? "" : " (global)";
  return `- [L${lesson.id}] ${lesson.title}${scope}: ${lesson.prevention}`;
}

// One memory line of the session block.
function memoryLine(memory) {
  return `- ${memory.key}: ${memory.value}`;
}

// One standing decision of the session block, short on purpose: the full text comes from `decision_recall`.
function decisionLine(decision) {
  return `- ${ownerLabel(decision)} ${clip(`${decision.title}: ${decision.decision}`, DECISION_MAX)}`;
}

// Marks the lessons as injected in the corpus, tolerating a write failure that must not cost the block.
async function markInjectedQuietly(store, ids) {
  try {
    return (await store.lessons.markInjected(ids)).injected;
  } catch {
    return 0;
  }
}

// Registers what was injected, both in the session state and in the corpus.
async function stampInjection(store, sessionId, lessons, env) {
  const ids = lessons.map((lesson) => lesson.id).filter((id) => Number.isInteger(id));
  recordInjected(
    sessionId,
    ids.map((id) => `l${id}`),
    env,
  );
  return markInjectedQuietly(store, ids);
}

// Builds the context block injected at the start of a session: top lessons plus the project memories.
export async function runSessionStart({ input, env = process.env, fetchImpl = null }) {
  if (env?.NIGHTQUEUE_REFLECT === "1") return "";
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "unknown";
  const project = projectFromCwd(cwd, env);
  if (!project) return "";
  const store = openStore(env);
  const lessons = await store.lessons.recallLessons({ project: project?.name, limit: LESSON_LIMIT });
  const memories = await store.memory.recentMemories({ project: project?.name, limit: MEMORY_LIMIT });
  const titles = await store.decisions.decisionTitles({ project: project?.name, status: "accepted" });
  const decisions = await store.decisions.recallDecisions({ project: project?.name, limit: DECISION_LIMIT });
  const proposed = await store.decisions.decisionTitles({ project: project?.name, status: "proposed" });
  const sections = [
    ...decisionSections({ titles, decisions, proposed }),
    section("Lessons learned (do not repeat these mistakes)", lessons, lessonLine),
    section(`Project memory (${project?.name ?? "global"})`, memories, memoryLine),
  ].filter(Boolean);
  if (!sections.length) return "";
  await stampInjection(store, sessionId, lessons, env);
  const notice = await updateNoticeLine({ env, fetchImpl });
  const block = `${HEADER}\n\n${sections.join("\n\n")}\n\n${FOOTER}`;
  return (notice ? `${block}\n\n${notice}` : block).slice(0, MAX_OUTPUT);
}
