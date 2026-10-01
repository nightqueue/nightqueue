import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A project and an org are rows of the registry (`orgs`, `projects`) with an id and a renamable name. Every other table owns
 * rows by `project_id` / `org_id`, so no SQL outside the registry module and the one-shot migration may filter, group, join,
 * write or declare an owner by NAME. Each pattern carries the shapes it must catch and the id-keyed shapes it must let pass,
 * every optional delimiter in each position it can take.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXEMPT = [join("memory", "registry.mjs"), `${join("memory", "migration")}${sep}`];

const PATTERNS = [
  {
    name: "filter by an owner name",
    regex: /\b(?:\w+\.)?(?:project|org)\s*(?:=|IS|IN)\s*\?/,
    positive: ["project = ?", "org = ?", "project=?", "project= ?", "project =?", "j.project = ?", "r.org IS ?", "project IS ?", "org IN ?"],
    negative: ["project_id = ?", "org_id = ?", "j.project_id = ?", "r.org_id IS ?", "project_id IS ?", "project_id IN (?)", "scope = 'project'"],
  },
  {
    name: "join or compare two owner-name columns",
    regex: /(?<!\b(?:const|let|var)\s+)\b(?:\w+\.)?(?:project|org)\s*=\s*\w+\.(?:project|org)\b(?!_)/,
    positive: ["other.project = jobs.project", "r.org = o.org", "project=jobs.project", "p.project =j.project", "t.org= p.org", "AND project = j.project"],
    negative: [
      "other.project_id = jobs.project_id",
      "r.org_id = o.org_id",
      "p.project_id = j.project_id",
      "r.org_id = o.id",
      "const project = values.project",
      "let org=values.org",
    ],
  },
  {
    name: "group by an owner name",
    regex: /\bGROUP\s+BY\s+(?:\w+\.)?(?:project|org)\b(?!_)/i,
    positive: ["GROUP BY project", "group by org", "GROUP BY j.project", "GROUP  BY\nproject, slug", "GROUP BY project,slug"],
    negative: ["GROUP BY project_id", "GROUP BY j.project_id, slug", "GROUP BY org_id", "GROUP BY slot.project_id"],
  },
  {
    name: "write an owner name",
    regex: /\bSET\s+(?:project|org)\s*=/i,
    positive: ["SET project = ?", "set org=?", "SET org =?", "SET\n  project= 'x'"],
    negative: ["SET project_id = ?", "SET org_id = ?", "SET name = ?"],
  },
  {
    name: "insert an owner name",
    regex: /INSERT\s+INTO\s+\w+\s*\([^)]*\b(?:project|org)\b(?!_)/i,
    positive: [
      "INSERT INTO jobs (project, prompt)",
      "insert into decisions(scope, project, org)",
      "INSERT INTO issue_comments (item_id, kind, project)",
      "INSERT INTO t (org)",
    ],
    negative: ["INSERT INTO jobs (project_id, prompt)", "INSERT INTO decisions (scope, project_id, org_id)", "INSERT INTO projects (id, name)"],
  },
  {
    name: "declare an owner-name column",
    regex: /\b(?:project|org)\s+TEXT\b/,
    positive: ["project TEXT", "org TEXT", "  project TEXT NOT NULL", "project\tTEXT"],
    negative: ["project_id TEXT", "org_id TEXT REFERENCES orgs(id)", "project TEXTS"],
  },
];

// Every `.mjs` file under a directory, at any depth.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

// The source files the boundary applies to: all of `src/`, except the registry module and the one-shot migration.
function guardedFiles() {
  return sourceFiles(SRC)
    .map((path) => relative(SRC, path))
    .filter((path) => !EXEMPT.some((exempt) => (exempt.endsWith(sep) ? path.startsWith(exempt) : path === exempt)));
}

for (const pattern of PATTERNS) {
  test(`the "${pattern.name}" pattern catches every name-keyed shape and lets every id-keyed shape pass`, () => {
    for (const sample of pattern.positive) assert.match(sample, pattern.regex, `must catch: ${JSON.stringify(sample)}`);
    for (const sample of pattern.negative) assert.doesNotMatch(sample, pattern.regex, `must let pass: ${JSON.stringify(sample)}`);
  });
}

test("no SQL outside the registry and the migration filters, groups, joins, writes or declares a project or an org by name", () => {
  const found = [];
  for (const path of guardedFiles()) {
    const source = readFileSync(join(SRC, path), "utf8");
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(source);
      if (match) found.push(`${path} (${pattern.name}: \`${match[0].replace(/\s+/g, " ")}\`)`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `bind \`project_id\` / \`org_id\` instead: a name lives only in the registry (\`src/memory/registry.mjs\`), resolved at the edge; found in ${found.join("; ")}`,
  );
});
