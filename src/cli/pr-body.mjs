import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { NIGHTQUEUE_SECTIONS } from "./pr-template.mjs";

// What a placeholder left over from the template looks like: the double curly braces and the `<...>` examples.
const PLACEHOLDERS = [/\{\{[^}\n]*\}\}/, /<[A-Za-z][A-Za-z0-9 _./'-]*>/];

// A bare `#<number>`, which GitHub turns into a cross-reference to an unrelated thread of the repository; a code span hides it.
const BARE_REFERENCE = /(^|[^`\w&])#\d+\b/;

// The one line where a `#<number>` is a real reference to an issue of the repository.
const REFERENCE_LINE = /^(Fixes|Closes)\b/;

// The opener or closer of a fenced code block, matched on the trimmed line.
const FENCE = /^(`{3,}|~{3,})/;

// An inline code span, whose text is quoted, never the body's own prose.
const CODE_SPAN = /(`+)[^`]*?\1/g;

// The markers of an HTML comment, erased so a line hidden in one is read like any other.
const COMMENT_MARKER = /<!--|-->/g;

// The footer `run pr` appends, matched on the trimmed prose of a line.
const FOOTER_LINE = /^Opened by nightqueue\b/i;

// A whole line of `Refs` followed by refs only, never prose that starts with the word.
const REFS_LINE = /^Refs:?\s+[\w#/.-]+(\s*,\s*[\w#/.-]+)*$/i;

// A job ref, which `run pr` writes from the job row.
const JOB_REF = /\bJ-\d+\b/;

// A heading line of the body, matched on the trimmed line.
const HEADING = /^#{1,6}\s+\S/;

// The `###` subsections a `## QA` section may carry, each with the token its evidence files start with.
const QA_SUBSECTIONS = { automated: "automated", api: "api", browser: "browser", device: "emulator" };

// The subsections as the template names them, said when a heading names none of them.
const KNOWN_SUBSECTIONS = "### Automated, ### API, ### Browser, ### Device";

// The `###` heading that opens a QA subsection, matched on the trimmed line.
const QA_SUBHEADING = /^###\s+(\S.*)$/;

// A QA bullet: what ran, an em dash, and a result ending in PASSED, FAILED or SKIPPED (<reason>) with an optional ✅/❌.
const QA_BULLET = /^-\s+\S.*\s—\s+.*\b(PASSED|FAILED|SKIPPED\s+\(\s*\S[^)]*\))\s*(✅|❌)?$/;

// The line that closes the `## QA` section, with text of its own.
const NOT_TESTED_LINE = /^Not tested:\s*\S/;

// A violation the command prints as `MISSING: <what>`.
function missing(text) {
  return { missing: text };
}

// A violation the command prints as `REJECTED: <reason>`.
function rejected(text) {
  return { rejected: text };
}

// A bare `#<number>` outside a Fixes/Closes line, which every body is refused for whatever its template.
function bareReferenceProblems(lines) {
  const bare = lines.find((line) => !REFERENCE_LINE.test(line.trim()) && !line.trim().startsWith("```") && BARE_REFERENCE.test(line));
  if (!bare) return [];
  const reference = BARE_REFERENCE.exec(bare)[0].trim().replace(/^[^#]/, "");
  return [rejected(`the body carries a bare \`${reference}\` outside a Fixes/Closes line: name a decision by its ref (\`D-24\`), or write the number inside a code span`)];
}

// A placeholder left over from a template, which every body is refused for whatever its template.
function placeholderProblems(body) {
  const placeholder = PLACEHOLDERS.map((pattern) => pattern.exec(body)).find(Boolean);
  return placeholder ? [rejected(`the body still carries the placeholder \`${placeholder[0]}\`: fill every section with this run's own facts`)] : [];
}

// The heading lines of the body, trimmed, each with the index of its line.
function bodyHeadings(lines) {
  return lines.map((line, index) => ({ line: line.trim(), index })).filter((heading) => HEADING.test(heading.line));
}

// The headings of a repository template the body misses or carries out of the template's order.
function repoOrderProblems(found, { headings, label }) {
  const problems = [];
  let cursor = -1;
  let previous = null;
  for (const heading of headings) {
    const next = found.find((entry) => entry.line === heading && entry.index > cursor);
    if (next) {
      cursor = next.index;
      previous = heading;
    } else if (found.some((entry) => entry.line === heading)) {
      problems.push(rejected(`\`${heading}\` comes before \`${previous}\`; the repository template (${label}) orders them ${headings.join(", ")}`));
    } else {
      problems.push(rejected(`the body is missing \`${heading}\` of the repository template (${label})`));
    }
  }
  return problems;
}

// The nightqueue headings the body carries that the repository template does not have.
function foreignHeadingProblems(found, { headings, label }) {
  return NIGHTQUEUE_SECTIONS.filter((heading) => !headings.includes(heading) && found.some((entry) => entry.line === heading)).map((heading) =>
    rejected(`the body carries the nightqueue heading \`${heading}\`, which the repository template (${label}) does not have`),
  );
}

// Why a body cannot be published against a repository template: its headings, in its order, and no nightqueue heading of its own.
function repoTemplateProblems(lines, template) {
  const found = bodyHeadings(lines);
  return [...repoOrderProblems(found, template), ...foreignHeadingProblems(found, template)];
}

// The line of each nightqueue section in the body, -1 for a section it does not carry.
function sectionLines(found) {
  return NIGHTQUEUE_SECTIONS.map((heading) => ({ heading, at: found.find((entry) => entry.line === heading)?.index ?? -1 }));
}

// The nightqueue sections the body misses, carries out of order, or outnumbers with a fifth `## ` section.
function sectionProblems(found, sections) {
  const absent = sections.filter((section) => section.at < 0).map((section) => missing(section.heading));
  const misplaced = sections
    .filter((section, index) => section.at >= 0 && sections.slice(index + 1).some((later) => later.at >= 0 && later.at < section.at))
    .map((section) => missing(`${section.heading} in its place: the order is ${NIGHTQUEUE_SECTIONS.join(", ")}`));
  const extra = found
    .filter((entry) => entry.line.startsWith("## ") && !NIGHTQUEUE_SECTIONS.includes(entry.line))
    .map((entry) => rejected(`the body carries a fifth section \`${entry.line}\`; the four sections are the whole body`));
  return [...absent, ...misplaced, ...extra];
}

// The trimmed lines of the `## QA` section, up to the next `## ` section or the end of the body.
function qaBlock(lines, qaAt) {
  const after = lines.slice(qaAt + 1).map((line) => line.trim());
  const end = after.findIndex((line) => line.startsWith("## "));
  return end < 0 ? after : after.slice(0, end);
}

// The QA subsections of a block: each heading with its name, evidence token, bullets and line index.
function qaSubsections(block) {
  const sections = [];
  block.forEach((line, index) => {
    const name = QA_SUBHEADING.exec(line)?.[1].trim();
    if (name !== undefined) sections.push({ name, token: Object.hasOwn(QA_SUBSECTIONS, name.toLowerCase()) ? QA_SUBSECTIONS[name.toLowerCase()] : null, bullets: [], at: index });
    else if (line.startsWith("-") && sections.length > 0) sections.at(-1).bullets.push({ line, index });
  });
  return sections;
}

// What one QA bullet violates: a `N/A` result, or a shape other than `- <what ran> — <result>` ending in PASSED, FAILED or SKIPPED (<reason>).
function bulletProblems(section, { line }) {
  if (/\bN\/A\b/i.test(line)) return [rejected(`QA subsection ${section.name} has a N/A bullet: a method that did not run has no subsection: ${line}`)];
  if (QA_BULLET.test(line)) return [];
  return [missing(`QA bullet \`- <what ran> — <result>\` in subsection ${section.name}, the result ending in PASSED, FAILED or SKIPPED (<reason>): ${line}`)];
}

// What one QA subsection violates: a method the template does not know, no bullet, or a malformed bullet.
function subsectionProblems(section) {
  const problems = [];
  if (section.token === null) problems.push(missing(`a known QA subsection instead of ### ${section.name} (${KNOWN_SUBSECTIONS})`));
  if (section.bullets.length === 0) problems.push(missing(`a bullet under QA subsection ${section.name}`));
  return [...problems, ...section.bullets.flatMap((bullet) => bulletProblems(section, bullet))];
}

// What the `## QA` section violates: a table, no subsection, a bad subsection, and a `Not tested:` line missing or before the last subsection.
function qaProblems(block, sections) {
  const table = block.some((line) => line.startsWith("|")) ? [missing("QA subsections (### Automated, ### API, ### Browser, ### Device, one bullet per test) instead of a table")] : [];
  const none = sections.length === 0 ? [missing(`a QA subsection for a method that ran (${KNOWN_SUBSECTIONS})`)] : [];
  return [...table, ...none, ...sections.flatMap(subsectionProblems), ...notTestedProblems(block, sections)];
}

// The `Not tested:` line the template requires after the last QA subsection, with text of its own.
function notTestedProblems(block, sections) {
  const lastAt = Math.max(-1, ...sections.flatMap((section) => [section.at, ...section.bullets.map((bullet) => bullet.index)]));
  const present = block.slice(lastAt + 1).some((line) => NOT_TESTED_LINE.test(line));
  return present ? [] : [missing("Not tested: line after the last QA subsection")];
}

// Whether a path is a regular file with something in it.
function isNonEmptyFile(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// The names of the non-empty evidence files of the run; a run that recorded none has an empty list.
function evidenceFiles(evidenceDir) {
  if (typeof evidenceDir !== "string" || evidenceDir === "") return [];
  try {
    return readdirSync(evidenceDir).filter((name) => isNonEmptyFile(join(evidenceDir, name)));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new UserError(`the evidence of the run cannot be read at ${evidenceDir}: ${error?.message ?? String(error)}`);
  }
}

// The QA subsections whose method has no `<method>-*` evidence file under the run's evidence directory.
function evidenceProblems(sections, evidenceDir) {
  const known = sections.filter((section) => section.token !== null);
  const files = known.length > 0 ? evidenceFiles(evidenceDir) : [];
  return known
    .filter((section) => !files.some((name) => name.startsWith(`${section.token}-`)))
    .map((section) => missing(`evidence for QA section ${section.name}`));
}

// Why a body cannot be published against the nightqueue template: its four sections in order, its QA subsections, its `Not tested:` line and the evidence of every subsection.
function nightqueueTemplateProblems(lines, evidenceDir) {
  const found = bodyHeadings(lines);
  const sections = sectionLines(found);
  const qaAt = sections.at(-1).at;
  if (qaAt < 0) return sectionProblems(found, sections);
  const block = qaBlock(lines, qaAt);
  const subsections = qaSubsections(block);
  return [...sectionProblems(found, sections), ...qaProblems(block, subsections), ...evidenceProblems(subsections, evidenceDir)];
}

// The body lines outside fenced blocks, each with its 1-based number, and the fence left open at the end of the body (null when none).
function fenceScan(lines) {
  const outside = [];
  let fence = null;
  lines.forEach((line, index) => {
    const opener = FENCE.exec(line.trim())?.[1] ?? null;
    if (fence !== null) {
      if (opener !== null && opener[0] === fence.marker[0] && opener.length >= fence.marker.length) fence = null;
      return;
    }
    if (opener !== null) {
      fence = { marker: opener, number: index + 1 };
      return;
    }
    outside.push({ number: index + 1, line });
  });
  return { outside, openFence: fence };
}

// Groups numbered lines into paragraphs: runs of consecutive non-blank lines.
function paragraphs(entries) {
  const groups = [];
  let current = [];
  for (const entry of entries) {
    const blank = entry.line.trim() === "";
    if (current.length > 0 && (blank || current.at(-1).number !== entry.number - 1)) {
      groups.push(current);
      current = [];
    }
    if (!blank) current.push(entry);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// The lines of one paragraph with their code spans blanked out, a span wrapped over several lines included.
function withoutCodeSpans(paragraph) {
  const joined = paragraph.map((entry) => entry.line).join("\n");
  return joined.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, " ")).split("\n");
}

// The non-blank body lines outside fences, each with its number, its trimmed raw text and its text with code spans blanked out.
function spanFreeLines(outside) {
  return paragraphs(outside).flatMap((paragraph) => {
    const texts = withoutCodeSpans(paragraph);
    return paragraph.map((entry, index) => ({ number: entry.number, raw: entry.line.trim(), text: texts[index] }));
  });
}

// The body lines as a reader sees their prose, each with its 1-based number: fenced blocks dropped, code spans and HTML comment markers erased.
function proseLines(lines) {
  return spanFreeLines(fenceScan(lines).outside).map((line) => ({ ...line, text: line.text.replace(COMMENT_MARKER, " ").trim() }));
}

// The number of the line whose HTML comment is still open at the end of the body, or null when every comment is closed.
function openCommentLine(prose) {
  let openedAt = null;
  for (const line of prose) {
    for (const [marker] of line.text.matchAll(COMMENT_MARKER)) {
      if (marker === "<!--" && openedAt === null) openedAt = line.number;
      if (marker === "-->") openedAt = null;
    }
  }
  return openedAt;
}

// A fenced block or an HTML comment the body leaves open at its end, which would swallow the footer `run pr` appends after it.
function unclosedBlockProblems(lines) {
  const { outside, openFence } = fenceScan(lines);
  const problems = [];
  if (openFence !== null) {
    problems.push(rejected(`line ${openFence.number} opens a fenced block (${openFence.marker}) that is never closed: close it, or the footer \`run pr\` appends renders as code`));
  }
  const commentAt = openCommentLine(spanFreeLines(outside));
  if (commentAt !== null) {
    problems.push(rejected(`line ${commentAt} opens an HTML comment (\`<!--\`) that is never closed: close it with \`-->\`, or the footer \`run pr\` appends is hidden`));
  }
  return problems;
}

// The pattern of the run slug as a token of its own, or null when the slug is absent or a single word prose would carry anyway.
function slugPattern(slug) {
  if (typeof slug !== "string" || !slug.includes("-")) return null;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, "i");
}

// The pattern of the caller's own job written as prose (`job 7`, `Job #7`), or null outside a job.
function ownJobPattern(jobId) {
  return Number.isSafeInteger(jobId) && jobId > 0 ? new RegExp(`\\bjob\\s*#?\\s*${jobId}\\b`, "i") : null;
}

// What traceability shape a prose line carries, or null when it carries none.
function traceabilityShape(text, { slug, jobId }) {
  if (FOOTER_LINE.test(text)) return "the `Opened by nightqueue` footer";
  if (REFS_LINE.test(text)) return "a `Refs` line";
  if (JOB_REF.test(text) || ownJobPattern(jobId)?.test(text)) return "a job id";
  if (slugPattern(slug)?.test(text)) return "the run slug";
  return null;
}

// Every body line carrying traceability `run pr` appends itself from the job row: the footer, a `Refs` line, a job id or the run slug.
function traceabilityProblems(lines, { slug, jobId }) {
  return proseLines(lines)
    .map((line) => ({ line, what: traceabilityShape(line.text, { slug, jobId }) }))
    .filter(({ what }) => what !== null)
    .map(({ line, what }) => rejected(`line ${line.number} carries ${what}, which \`run pr\` appends from the job row: ${line.raw}`));
}

// Every reason the body cannot be published against the template in effect, as `{ missing }` or `{ rejected }` entries; none means publishable.
export function bodyProblems({ body, template, evidenceDir, slug = null, jobId = null }) {
  const lines = body.split("\n");
  const structure = template.source === "repo" ? repoTemplateProblems(lines, template) : nightqueueTemplateProblems(lines, evidenceDir);
  return [...structure, ...bareReferenceProblems(lines), ...placeholderProblems(body), ...traceabilityProblems(lines, { slug, jobId }), ...unclosedBlockProblems(lines)];
}
