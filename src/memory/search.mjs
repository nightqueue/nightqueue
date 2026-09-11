import { blobToVector, dotProduct, openDb, resolveProjectName, toQueryVector } from "./db.mjs";
import { recentMemories, searchMemories } from "./memory.mjs";

const MAX_TOKENS = 16;
const RECALL_MIN_TOKEN_MATCHES = 3;
const RECALL_TOKEN_DF_MAX = 0.25;
const MAX_EXCLUDE_IDS = 200;
const DEFAULT_DEADLINE_MS = 1500;

export const RECALL_COS_CUT = 0.55;

// Free text into FTS query tokens: >=3 chars, unicode, deduped, capped at 16.
export function queryTokens(text) {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [],
    ),
  ]
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .map((token) => Array.from(token).slice(0, 64).join(""))
    .slice(0, MAX_TOKENS);
}

// Quotes a token so no user character can act as an FTS5 operator.
function quoteToken(token) {
  return `"${token.replaceAll('"', "")}"`;
}

// Free text into a safe FTS5 MATCH expression (quoted tokens in OR), or null when there is nothing to match.
export function ftsMatch(text) {
  const tokens = queryTokens(text);
  return tokens.length ? tokens.map(quoteToken).join(" OR ") : null;
}

// Normalizes the ids to exclude: integers only, deduped, capped at 200.
export function normalizeExcludeIds(excludeIds) {
  return [...new Set(Array.isArray(excludeIds) ? excludeIds : [])].filter(Number.isInteger).slice(0, MAX_EXCLUDE_IDS);
}

// Caps a limit to a positive integer.
export function safeLimit(limit, fallback) {
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

// Stamps the recall path each row came from, without copying the row and its embedding BLOB.
export function markVia(rows, via) {
  for (const row of rows) row.via = via;
  return rows;
}

// SQL fragment plus binds of an optional target filter.
function targetFilter(column, target) {
  const apply = typeof target === "string" && target;
  return { clause: apply ? ` AND ${column} = ?` : "", binds: apply ? [target] : [] };
}

// SQL fragment plus binds of an optional id exclusion list.
function excludeFilter(column, ids) {
  return ids.length ? { clause: ` AND ${column} NOT IN (${ids.map(() => "?").join(",")})`, binds: ids } : { clause: "", binds: [] };
}

// Runs a search with the target filter and, when it comes back empty, once more without it.
function softTarget(run, target) {
  const first = run(target);
  if (!target || first.length) return first;
  return run(null);
}

// Keeps the first row of each id, recording the ids already taken.
function dedupeById(rows, seen) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

// Interleaves two result lists one by one, deduping by id; the lexical list is never truncated.
export function interleave(lexical, semantic, limit) {
  const seen = new Set();
  const primary = dedupeById(lexical, seen);
  const budget = Math.max(0, safeLimit(limit, primary.length) - primary.length);
  const secondary = dedupeById(semantic, seen).slice(0, budget);
  const out = [];
  for (let i = 0; i < primary.length || i < secondary.length; i++) {
    if (i < primary.length) out.push(primary[i]);
    if (i < secondary.length) out.push(secondary[i]);
  }
  return out;
}

// Recent lessons of a project plus the globals: current project first, violated first, newest first.
export function recentLessons({ project, target, excludeIds, limit = 12 } = {}, env = process.env) {
  const db = openDb(env);
  const projectName = resolveProjectName(project, env);
  const size = safeLimit(limit, 12);
  const targetPart = targetFilter("target", target);
  const excludePart = excludeFilter("id", normalizeExcludeIds(excludeIds));
  if (!projectName) {
    return db
      .prepare(
        `SELECT * FROM lessons WHERE archived = 0${targetPart.clause}${excludePart.clause}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...targetPart.binds, ...excludePart.binds, Math.min(size, 10));
  }
  return db
    .prepare(
      `SELECT * FROM lessons
       WHERE archived = 0 AND (project = ? OR project IS NULL)${targetPart.clause}${excludePart.clause}
       ORDER BY CASE WHEN project = ? THEN 0 ELSE 1 END, (violated > 0) DESC, created_at DESC
       LIMIT ?`,
    )
    .all(projectName, ...targetPart.binds, ...excludePart.binds, projectName, size);
}

// Tokens that carry information: they exist in the corpus (df>0) and are not corpus stopwords (df<=cap).
function informativeTokens(db, tokens) {
  const columns = tokens
    .map(
      (_, i) =>
        `(SELECT COUNT(*) FROM lessons_fts JOIN lessons lf ON lf.id = lessons_fts.rowid
           WHERE lessons_fts MATCH ? AND lf.archived = 0) AS df${i}`,
    )
    .join(", ");
  const row = db.prepare(`SELECT (SELECT COUNT(*) FROM lessons WHERE archived = 0) AS total, ${columns}`).get(...tokens);
  const cap = Math.max(8, Math.floor(row.total * RECALL_TOKEN_DF_MAX));
  const existing = tokens.filter((_, i) => row[`df${i}`] > 0);
  const useful = tokens.filter((_, i) => row[`df${i}`] > 0 && row[`df${i}`] <= cap);
  return useful.length ? useful : existing;
}

// Relevance floor: how many informative tokens a row has to match before it counts as a hit.
function coverageClause(db, tokens) {
  const quoted = tokens.map(quoteToken);
  if (!quoted.length) return { clause: "", binds: [] };
  const useful = informativeTokens(db, quoted);
  const base = useful.length <= 2 ? useful.length : Math.min(RECALL_MIN_TOKEN_MATCHES, useful.length - 1);
  const floor = Math.max(base, quoted.length >= 3 ? 2 : 1);
  if (floor > useful.length) return { empty: true, clause: "", binds: [] };
  if (floor <= 1) return { clause: "", binds: [] };
  const terms = useful.map(() => "(l.id IN (SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH ?))").join(" + ");
  return { clause: ` AND (${terms}) >= ?`, binds: [...useful, floor] };
}

// Lessons matching a query through BM25, with an informative-token coverage floor and a boost for the current project.
export function searchLessonsLexical({ query, project, target, excludeIds, limit = 8 } = {}, env = process.env) {
  const match = ftsMatch(query);
  if (!match) return [];
  const db = openDb(env);
  const projectName = resolveProjectName(project, env);
  const targetPart = targetFilter("l.target", target);
  const excludePart = excludeFilter("l.id", normalizeExcludeIds(excludeIds));
  const coverage = coverageClause(db, queryTokens(query));
  if (coverage.empty) return [];
  return db
    .prepare(
      `SELECT l.*, bm25(lessons_fts) AS rank
       FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.rowid
       WHERE lessons_fts MATCH ? AND l.archived = 0
         AND (? = 0 OR l.project = ? OR l.project IS NULL)${targetPart.clause}${excludePart.clause}${coverage.clause}
       ORDER BY bm25(lessons_fts)
         + CASE WHEN l.project = ? THEN -1.5 WHEN l.project IS NULL THEN -0.5 ELSE 0 END
       LIMIT ?`,
    )
    .all(
      match,
      projectName ? 1 : 0,
      projectName,
      ...targetPart.binds,
      ...excludePart.binds,
      ...coverage.binds,
      projectName,
      safeLimit(limit, 8),
    );
}

// First pass of the brute force: keeps the ids above the cut, ordered by cosine.
export function rankByCosine(rows, vector, cut, limit) {
  const scored = [];
  for (const row of rows) {
    let candidate;
    try {
      candidate = blobToVector(row.embedding);
    } catch {
      continue;
    }
    if (candidate.length !== vector.length) continue;
    const cosine = dotProduct(vector, candidate);
    if (cosine >= cut) scored.push({ id: row.id, cosine });
  }
  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, limit);
}

// Second pass of the brute force: hydrates the winning rows preserving the cosine order.
function hydrateByCosine(db, scored) {
  if (!scored.length) return [];
  const rows = db
    .prepare(`SELECT * FROM lessons WHERE id IN (${scored.map(() => "?").join(",")})`)
    .all(...scored.map((s) => s.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return scored
    .filter((s) => byId.has(s.id))
    .map((s) => {
      const row = byId.get(s.id);
      row.cosine = s.cosine;
      return row;
    });
}

// Semantic side of the recall: brute-force cosine in JS over the eligible rows of the project plus the globals.
export function searchLessonsSemantic(
  { vector, model, project, target, excludeIds, limit = 8, cut = RECALL_COS_CUT } = {},
  env = process.env,
) {
  const query = toQueryVector(vector);
  if (!query || typeof model !== "string" || !model) return [];
  const db = openDb(env);
  const projectName = resolveProjectName(project, env);
  const targetPart = targetFilter("target", target);
  const excludePart = excludeFilter("id", normalizeExcludeIds(excludeIds));
  const rows = db
    .prepare(
      `SELECT id, embedding FROM lessons
       WHERE embedding IS NOT NULL AND embedding_model = ? AND length(embedding) = ?
         AND archived = 0
         AND (? = 0 OR project = ? OR project IS NULL)${targetPart.clause}${excludePart.clause}`,
    )
    .all(model, query.length * 4, projectName ? 1 : 0, projectName, ...targetPart.binds, ...excludePart.binds);
  const scored = rankByCosine(rows, query, Number.isFinite(cut) ? cut : RECALL_COS_CUT, safeLimit(limit, 8));
  return hydrateByCosine(db, scored);
}

// Resolves the pair (embedder, model tag): injected in tests, loaded on demand in production.
export async function resolveEmbedder(embedder, env = process.env) {
  if (env?.NIGHTSHIFT_EMBED_DISABLED === "1") return null;
  if (typeof embedder?.embedText === "function") {
    const model = typeof embedder.model === "string" ? embedder.model : "";
    return model ? { embedText: embedder.embedText, model } : null;
  }
  try {
    const mod = await import("./embedding.mjs");
    return { embedText: (text) => mod.embedText(text, env), model: mod.EMBEDDING_MODEL_TAG };
  } catch {
    return null;
  }
}

// Races a promise against a deadline, always clearing the timer.
function withDeadline(promise, ms) {
  const deadline = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`embedding exceeded ${deadline}ms`)), deadline);
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

// Vector of a text within the deadline; empty text or any failure returns null and the caller keeps the lexical path.
export async function embedWithDeadline(embedder, text, deadlineMs) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  try {
    return (await withDeadline(embedder.embedText(source), deadlineMs)) ?? null;
  } catch {
    return null;
  }
}

// Single entry of the lesson recall: BM25 always answers, the semantic path only adds and never blocks.
export async function recallLessons(
  { query, project, target, excludeIds, limit = 8, embedder, deadlineMs } = {},
  env = process.env,
) {
  const projectName = resolveProjectName(project, env);
  const ids = normalizeExcludeIds(excludeIds);
  const size = safeLimit(limit, 8);
  if (!ftsMatch(query)) {
    return markVia(
      softTarget((t) => recentLessons({ project: projectName, target: t, excludeIds: ids, limit: size }, env), target),
      "lexical",
    );
  }
  const lexical = markVia(
    softTarget(
      (t) => searchLessonsLexical({ query, project: projectName, target: t, excludeIds: ids, limit: size }, env),
      target,
    ),
    "lexical",
  );
  const resolved = await resolveEmbedder(embedder, env);
  const vector = resolved ? await embedWithDeadline(resolved, query, deadlineMs) : null;
  let results = lexical;
  if (vector) {
    try {
      const semantic = markVia(
        softTarget(
          (t) =>
            searchLessonsSemantic(
              { vector, model: resolved.model, project: projectName, target: t, excludeIds: ids, limit: size },
              env,
            ),
          target,
        ),
        "semantic",
      );
      results = interleave(lexical, semantic, size);
    } catch {
      results = lexical;
    }
  }
  if (results.length || !projectName) return results;
  try {
    return markVia(recentLessons({ project: projectName, excludeIds: ids, limit: size }, env), "fallback");
  } catch {
    return results;
  }
}

// Single entry of the memory recall: FTS when the query has tokens, recent ones otherwise.
export async function recallMemories({ query, project, limit = 8 } = {}, env = process.env) {
  return ftsMatch(query) ? searchMemories({ query, project, limit }, env) : recentMemories({ project, limit }, env);
}
