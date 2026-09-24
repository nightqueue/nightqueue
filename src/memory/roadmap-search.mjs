import { UserError } from "../config/errors.mjs";
import { openDb } from "./db.mjs";
import { truncateByCodePoint } from "./jobs.mjs";
import { roadmapRef } from "./roadmap.mjs";
import { requireOwnerTarget, visibility } from "./scope.mjs";
import { ftsMatch } from "./search.mjs";

export const ROADMAP_SEARCH_LIMIT = 5;

const FTS_CANDIDATES = 50;

// The number of hits a search returns: the asked one clamped to 1..5, or 5.
function searchLimit(limit) {
  if (!Number.isInteger(limit)) return ROADMAP_SEARCH_LIMIT;
  return Math.min(Math.max(limit, 1), ROADMAP_SEARCH_LIMIT);
}

// The trimmed text of an optional search field, or null.
function optionalTerm(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

// The comments a target reads: a project reads the item-level comments and its own project's, never a sibling's; an org reads every comment of its items.
function commentRule(target) {
  if (target.scope === "org") return { clause: "1 = 1", values: [] };
  return { clause: "(c.project IS NULL OR c.project = ?)", values: [target.project] };
}

// The prefix a path must start with to sit under the searched directory: the query itself when it ends with `/`.
function directoryPrefix(file) {
  return file.endsWith("/") ? file : `${file}/`;
}

// Items with a comment whose recorded files name the path exactly or sit under it as a directory; no character acts as a wildcard.
function fileHits(db, { target, file, limit }) {
  const visible = visibility(target, "r");
  const comments = commentRule(target);
  const under = directoryPrefix(file);
  return db
    .prepare(
      `SELECT r.* FROM roadmap_items r
        WHERE ${visible.clause}
          AND EXISTS (SELECT 1 FROM roadmap_comments c, json_each(c.refs, '$.files') f
                       WHERE c.item_id = r.id AND ${comments.clause}
                         AND (json_extract(f.value, '$.path') = ?
                              OR substr(json_extract(f.value, '$.path'), 1, length(?)) = ?))
        ORDER BY r.priority ASC, r.position ASC, r.id ASC LIMIT ?`,
    )
    .all(...visible.values, ...comments.values, file, under, under, limit);
}

// Items whose title or detail match the query, best first.
function itemTextHits(db, { target, match }) {
  const visible = visibility(target, "r");
  return db
    .prepare(
      `SELECT r.*, bm25(roadmap_items_fts) AS rank FROM roadmap_items_fts
         JOIN roadmap_items r ON r.id = roadmap_items_fts.rowid
        WHERE roadmap_items_fts MATCH ? AND ${visible.clause}
        ORDER BY rank LIMIT ${FTS_CANDIDATES}`,
    )
    .all(match, ...visible.values);
}

// Items with a comment the target reads that matches the query, best comment first.
function commentTextHits(db, { target, match }) {
  const visible = visibility(target, "r");
  const comments = commentRule(target);
  return db
    .prepare(
      `SELECT r.*, bm25(roadmap_comments_fts) AS rank FROM roadmap_comments_fts
         JOIN roadmap_comments c ON c.id = roadmap_comments_fts.rowid
         JOIN roadmap_items r ON r.id = c.item_id
        WHERE roadmap_comments_fts MATCH ? AND ${visible.clause} AND ${comments.clause}
        ORDER BY rank LIMIT ${FTS_CANDIDATES}`,
    )
    .all(match, ...visible.values, ...comments.values);
}

// Public shape of one search hit.
function hitView(row, via) {
  return {
    id: row.id,
    ref: roadmapRef(row),
    title: truncateByCodePoint(row.title),
    status: row.status,
    priority: row.priority,
    type: row.type,
    via,
  };
}

// The text hits of both sources merged by rank, each item once.
function rankedTextHits(db, spec) {
  const tagged = [
    ...itemTextHits(db, spec).map((row) => ({ row, via: "text" })),
    ...commentTextHits(db, spec).map((row) => ({ row, via: "comment" })),
  ];
  return tagged.sort((a, b) => a.row.rank - b.row.rank);
}

// Up to five items an owner sees that match a query (title, detail, comment) or a file path its jobs touched; file matches come first, then by relevance.
export function searchRoadmap({ query, file, project, org, limit } = {}, env = process.env, db = null) {
  const text = optionalTerm(query);
  const path = optionalTerm(file);
  if (text === null && path === null) throw new UserError("roadmap search needs `query`, `file` or both");
  const connection = db ?? openDb(env);
  const target = requireOwnerTarget({ project, org }, env);
  const size = searchLimit(limit);
  const match = text === null ? null : ftsMatch(text);
  const candidates = [
    ...(path === null ? [] : fileHits(connection, { target, file: path, limit: size }).map((row) => ({ row, via: "file" }))),
    ...(match === null ? [] : rankedTextHits(connection, { target, match })),
  ];
  const seen = new Set();
  const hits = [];
  for (const { row, via } of candidates) {
    if (hits.length >= size) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    hits.push(hitView(row, via));
  }
  return hits;
}
