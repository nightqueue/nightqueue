#!/usr/bin/env node
// A studio over a throwaway home with fictional data, for screenshots: an org of invented projects, jobs run through the
// real runner with a scripted `claude`, then `nightqueue studio` on that home. Nothing here touches the real home, the
// real Claude configuration or the network.
//
//   node scripts/studio-demo.mjs              # seed, serve, print the URL, wait for Ctrl+C
//   node scripts/studio-demo.mjs --capture    # seed, serve, capture docs/assets/studio-*.png with Playwright, exit
//   node scripts/studio-demo.mjs --check      # seed, print what the night holds, exit: the smoke test of the seeding
//
// `--capture` needs `playwright` resolvable (npm i -D playwright, or PLAYWRIGHT_CHROMIUM=/path/to/chromium).
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDir } from "../src/config/paths.mjs";
import { addConnection } from "../src/config/connections.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { orgIdOf } from "../test-support/memory.mjs";
import { acquireClose, addJob, cancelJob, getJob, settleClose } from "../src/memory/jobs.mjs";
import { runCycle } from "../src/queue/runner.mjs";
import { recordPhaseDone, recordRunFields } from "../src/queue/run-state.mjs";
import { startStudioServer } from "../src/studio/server.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { isolatedHostVars } from "../test-support/host.mjs";
import { makeOrg, mergedChecklist, projectIdOf, registerCheckout } from "../test-support/memory.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "scripts", "studio-demo-claude.mjs");
const OUT_DIR = join(ROOT, "docs", "assets");
const TOKEN = "studio-demo";
const PORT = Number(process.env.STUDIO_DEMO_PORT ?? 4748);
const CAPTURE = process.argv.includes("--capture");
const KEEP = process.argv.includes("--keep");
const CHECK = process.argv.includes("--check");

// ---------- the fictional night ----------

const NIGHT = Date.parse("2026-10-19T22:04:00Z"); // when the runner started, as the rows will say
const CLOCK = Date.now(); // when the streams say they ran, so the narrator reads positive elapsed times

const ORG = "acme";
const PROJECTS = [
  { name: "api", repo: "acme/api", files: { "src/webhooks/worker.mjs": "export async function deliver() {}\n", "src/auth/signed-url.mjs": "export function signUrl() {}\n", "README.md": "# api\n" } },
  { name: "web", repo: "acme/web", files: { "app/checkout/form.tsx": "export function Form() {}\n", "docs/deploy.md": "# Deploy\n" } },
  { name: "mobile", repo: "acme/mobile", files: { "src/offline/queue.ts": "export const queue = [];\n", "app.json": "{}\n" } },
];

const AGENTS = [
  // phase, agent, default model
  [1, "triager", "sonnet"],
  [2, "explore", "sonnet"],
  [3, "architect", "opus"],
  [4, "coder", "opus"],
  [5, "qa-guardian", "sonnet"],
  [6, "verifier", "sonnet"],
  [7, "verifier", "sonnet"], // runtime: the verifier launched in RUNTIME mode
];

const PHASE_NAMES = ["triage", "explore", "architecture", "implementation", "qa", "verification", "runtime", "commit"];
const PHASE_ARTIFACTS = ["01-triage.md", "02-explore.md", "03-plan.md", "04-implementation.md", "05-qa.md", "06-verification.md", "06-runtime.md", "pr-body.md"];

// One job of the night. `minutes` per phase index 0..8 (0 = brief, 8 = commit); tokens in thousands per phase.
const JOBS = [
  {
    project: "api", status: "closed", pr: 212, tier: "complex", type: "bug", priority: 5,
    slug: "webhook-worker-retries-5xx-with-backoff",
    title: "the webhook worker retries a 5xx with backoff, never a 4xx",
    prompt: "Deliveries to a customer endpoint that answers 503 are retried immediately and forever; a 404 is retried too. Retry 5xx with exponential backoff (max 6 tries) and drop 4xx after one attempt, with the reason on the delivery row.",
    minutes: [4, 1, 2, 6, 14, 5, 3, 1, 2], tokensK: [900, 60, 240, 1400, 3900, 500, 90, 70, 760], cost: 8.24,
    files: ["src/webhooks/worker.mjs", "src/webhooks/backoff.mjs", "test/webhooks/worker.test.mjs"],
    notice: "✅ Delivered — a failing delivery backs off on 5xx and stops on 4xx\n\nWhat was missing: the worker retried every failure at once, 4xx included, so one dead endpoint kept a lane busy.\n\nWhat was done: a `backoff.mjs` with jittered exponential delays, a cap of 6 tries on 5xx, and 4xx dropped after the first try with `reason` on the delivery row.\n\nWhat the review found: • a 429 was treated as 4xx and dropped — it now backs off like a 5xx. • the jitter could go negative on the first try. Both fixed.\n\nHow it was validated: the worker suite (112 tests), a replay of 300 recorded deliveries against a fake endpoint, and a real run with a 503 stub.",
    startMin: 0,
  },
  {
    project: "web", status: "closed", pr: 98, tier: "simple", type: "bug", priority: 5,
    slug: "checkout-form-keeps-coupon-after-failed-card",
    title: "the checkout form keeps the coupon after a failed card",
    prompt: "When the card is declined the page re-renders and the coupon field is empty; the discount is gone on the second try.",
    minutes: [2, 1, 0, 0, 5, 0, 2, 0, 1], tokensK: [400, 50, 0, 0, 1200, 0, 80, 0, 300], cost: 2.1,
    files: ["app/checkout/form.tsx", "app/checkout/form.test.tsx"],
    notice: "✅ Delivered — the coupon survives a declined card\n\nWhat was done: the coupon lives in the form state, not in the response of the payment call.\n\nHow it was validated: the checkout suite and a run against the staging gateway with a test card that declines.",
    startMin: 38,
  },
  {
    project: "api", status: "closed", pr: 214, tier: "complex", type: "feature", priority: 4,
    slug: "rate-limits-answer-429-with-retry-after",
    title: "rate limits answer 429 with Retry-After on every route",
    prompt: "Add per-key rate limits (1000 req/min, burst 50) on the public API. Over the limit answer 429 with a Retry-After header. Keep the admin routes unlimited.",
    minutes: [3, 1, 3, 7, 22, 6, 4, 2, 2], tokensK: [700, 70, 300, 1600, 6200, 600, 120, 90, 800], cost: 12.6,
    files: ["src/http/rate-limit.mjs", "src/http/app.mjs", "test/http/rate-limit.test.mjs", "docs/api.md"],
    notice: "✅ Delivered — the public API is rate limited per key\n\nWhat was done: a token bucket per API key in memory, `429` with `Retry-After` in seconds, admin routes excluded, documented in docs/api.md.\n\nWhat the review found: a key with no bucket yet could burst twice in the same millisecond. Fixed with a single creation path.\n\nHow it was validated: 64 new tests, a load run at 3000 req/min against a local server.",
    startMin: 52,
  },
  {
    project: "mobile", status: "closed", pr: 57, tier: "complex", type: "bug", priority: 6,
    slug: "offline-queue-flushes-in-order-after-reconnect",
    title: "the offline queue flushes in order after reconnect",
    prompt: "Actions taken offline are sent out of order when the connection comes back, so an edit can arrive before the create it depends on.",
    minutes: [3, 1, 2, 5, 11, 4, 3, 1, 2], tokensK: [600, 60, 200, 900, 2800, 400, 80, 60, 500], cost: 6.4,
    files: ["src/offline/queue.ts", "src/offline/queue.test.ts"],
    notice: "✅ Delivered — the queue flushes oldest first, one action at a time\n\nWhat was done: a sequence number per queued action and a flush that awaits each send.\n\nHow it was validated: the offline suite and a simulator run toggling airplane mode.",
    startMin: 120,
  },
  {
    project: "web", status: "closed", pr: 99, tier: "trivial", type: "docs", priority: 7,
    slug: "deploy-runbook-names-the-rollback-step",
    title: "docs: the deploy runbook names the rollback step",
    prompt: "docs/deploy.md stops at 'verify the release'. Add the rollback step with the exact command.",
    minutes: [1, 0, 0, 0, 2, 0, 1, 0, 1], tokensK: [150, 0, 0, 0, 300, 0, 40, 0, 120], cost: 0.42,
    files: ["docs/deploy.md"],
    notice: "✅ Delivered — the runbook ends with the rollback command.",
    startMin: 170,
  },
  {
    project: "api", status: "done", pr: 218, tier: "complex", type: "bug", priority: 3,
    slug: "signed-url-expires-in-15-minutes-not-hours",
    title: "a signed URL expires in 15 minutes, not 15 hours",
    prompt: "Download links from /files/:id/url are valid for 15 hours. The product says 15 minutes. Find the cause, fix it, and make sure an expired link answers 410.",
    minutes: [6, 1, 1, 5, 12, 4, 3, 1, 1], tokensK: [1100, 60, 240, 1400, 3900, 500, 84, 68, 769], cost: 8.24,
    files: ["src/auth/signed-url.mjs", "src/files/url.mjs", "test/auth/signed-url.test.mjs"],
    notice: "✅ Delivered — a signed URL now expires after 15 minutes and an expired one answers 410\n\nWhat was missing: the TTL was read as hours by the signer and as minutes by the verifier, so a link stayed valid for 15 hours and the check never fired.\n\nWhat was done: one `ttlSeconds` on both sides, the signer reads `FILES_URL_TTL_MIN` (default 15), and `/files/:id` answers `410 Gone` with a short body once the signature has expired.\n\nWhat the review found: • a URL signed one second before midnight UTC was rejected at once — the expiry compared dates, not instants. Fixed. • the error body leaked the file name. Removed.\n\nHow it was validated: the auth suite (48 tests, 9 new), a clock-driven test around the expiry, and a real run against a local server with a 2-second TTL.\n\nStill open — a DIFFERENT problem, does not affect this fix: links issued before this change stay valid until their old expiry; a note is in the PR.",
    startMin: 182,
  },
  {
    project: "web", status: "done", pr: 101, tier: "simple", type: "feature", priority: 5,
    slug: "invoice-pdf-renders-the-tax-line-per-country",
    title: "the invoice PDF renders the tax line per country",
    prompt: "Invoices show one 'Tax' line. For EU customers it must read 'VAT 21%' (per country), for US customers 'Sales tax', others no line.",
    minutes: [2, 1, 0, 2, 6, 0, 2, 0, 1], tokensK: [400, 60, 0, 250, 1500, 0, 90, 0, 350], cost: 2.9,
    files: ["app/invoices/pdf.tsx", "app/invoices/tax.ts", "app/invoices/tax.test.ts"],
    notice: "✅ Delivered — the tax line reads per country\n\nWhat was done: a `taxLine(country)` with the EU table, 'Sales tax' for US, nothing elsewhere; the PDF renders it.\n\nHow it was validated: 14 new tests and three rendered PDFs checked by eye in the verification run.",
    startMin: 228,
  },
  {
    project: "mobile", status: "gate", tier: "complex", type: "feature", priority: 5,
    slug: "drop-the-legacy-push-token-column",
    title: "drop the legacy push token column",
    prompt: "The `devices.push_token_legacy` column is unused since the FCM migration. Drop it and the code paths that still read it.",
    minutes: [3, 1, 2, 4, 0, 0, 0, 0, 0], tokensK: [500, 60, 200, 700, 0, 0, 0, 0, 0], cost: 1.8,
    files: [],
    gate: "The column still has 1,284 non-null values written in the last 30 days by the v3.2 app, which is below the minimum version only since Monday. Dropping it now breaks those installs until they update. Drop anyway, or wait for the forced update on Nov 3?",
    startMin: 252,
  },
  { project: "api", status: "pending", priority: 5, title: "add the audit log to the admin API", prompt: "Every write on /admin/* is recorded with actor, route, payload diff and request id; GET /admin/audit lists it, newest first, filterable by actor." },
  { project: "web", status: "pending", priority: 6, title: "the pricing page reads plans from the API", prompt: "The three plans on /pricing are hardcoded. Read them from GET /plans and keep the page static when the API is down (last good copy)." },
  { project: "mobile", status: "cancelled", priority: 7, title: "upgrade to Expo SDK 54", prompt: "Upgrade the app to Expo SDK 54 and fix what breaks.", reason: "waits for the push token job" },
];

// ---------- the stream of one job ----------

const ms = { m: 60_000, s: 1000 };
let toolCounter = 0;
const toolId = () => `toolu_demo_${(++toolCounter).toString(36).padStart(6, "0")}`;
const msgId = () => `msg_demo_${(++toolCounter).toString(36).padStart(6, "0")}`;
const iso = (t) => new Date(t).toISOString();

function usage(tokens) {
  const cacheRead = Math.round(tokens * 0.93);
  const cacheCreation = Math.round(tokens * 0.05);
  const output = Math.round(tokens * 0.015);
  return { input_tokens: Math.max(1, tokens - cacheRead - cacheCreation - output), output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation };
}

function assistant(t, content, { parent = null, tokens = 0, model = "claude-sonnet-5" } = {}) {
  const event = { type: "assistant", session_id: SESSION, timestamp: iso(t), message: { id: msgId(), model, role: "assistant", content, usage: usage(tokens) } };
  if (parent) event.parent_tool_use_id = parent;
  return event;
}

function toolResult(t, id, content, parent = null) {
  const event = { type: "user", session_id: SESSION, timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } };
  if (parent) event.parent_tool_use_id = parent;
  return event;
}

const SESSION = "0d2f7c1e-demo-4b7a-9c3e-studio000001";

const LANE_WORK = {
  triager: ["Reading the brief and the delivery rows of the last 24h.", "Reproducing on main: the behaviour is as described.", "Verdict: real bug, root cause located, complex tier."],
  explore: ["Mapping the modules the fix touches.", "Reading the callers and the tests around them.", "File map written: 11 files, 3 to change."],
  architect: ["Plan: 3 steps, one new module, no schema change.", "Pre-mortem: the risky part is the boundary condition.", "03-plan.md written."],
  coder: ["Implementing step 1 of 3.", "Running the suite after each step.", "All green locally; changes staged on the branch."],
  "qa-guardian": ["Break hypotheses: 5. Attacking the boundary first.", "One hypothesis confirmed; writing the proof-of-concept test.", "Verdict: 2 findings, both fixed in the fix loop."],
  verifier: ["Running the project's own checks.", "Checks 3/3 green; evidence collected.", "VERIFIED."],
};

const LANE_TOOLS = {
  triager: ["Read", "Grep", "Bash"],
  explore: ["Glob", "Read", "Read"],
  architect: ["Read", "Write"],
  coder: ["Edit", "Edit", "Bash", "Write", "Bash"],
  "qa-guardian": ["Bash", "Write", "Bash"],
  verifier: ["Bash", "Bash"],
};

function bash(t, command, description, tokens = 2000) {
  const id = toolId();
  return [assistant(t, [{ type: "tool_use", id, name: "Bash", input: { command, description } }], { tokens }), toolResult(t + 2 * ms.s, id, "ok")];
}

// One subagent lane: the Task call, its work, the notification that closes it and the tool_result the orchestrator reads.
function lane(t, [phase, agent, model], wholeMinutes, tokensK, job) {
  const minutes = wholeMinutes + ((phase * 17 + job.slug.length * 3) % 50) / 60;
  const id = toolId();
  const runtime = phase === 7;
  const description = runtime ? "Runtime check" : `${agent[0].toUpperCase()}${agent.slice(1)} ${job.slug}`;
  const prompt = runtime ? "Mode: RUNTIME\n\nRun the change for real and report." : `Job ${job.slug}: ${job.title}`;
  const events = [assistant(t, [{ type: "tool_use", id, name: "Task", input: { subagent_type: `nightqueue:${agent}`, description, model, prompt } }], { tokens: 3000 })];
  const lines = runtime ? ["Starting the real run on the change.", "No gate raised; the behaviour matches the notice.", "ok"] : LANE_WORK[agent];
  const tools = LANE_TOOLS[agent];
  const total = tokensK * 1000;
  const steps = lines.length + tools.length;
  const step = (minutes * ms.m) / (steps + 1);
  let at = t + step;
  let i = 0;
  for (const line of lines) {
    events.push(assistant(at, [{ type: "text", text: line }], { parent: id, tokens: Math.round(total / steps), model: model === "opus" ? "claude-opus-5-5" : "claude-sonnet-5" }));
    at += step;
    const tool = tools[i++];
    if (tool) {
      const tid = toolId();
      const input = tool === "Bash" ? { command: "npm test", description: "Run the suite" } : tool === "Grep" ? { pattern: "retry" } : tool === "Glob" ? { pattern: "src/**/*.mjs" } : { file_path: job.files[i % Math.max(1, job.files.length)] ?? "README.md" };
      events.push(assistant(at, [{ type: "tool_use", id: tid, name: tool, input }], { parent: id, tokens: Math.round(total / steps) }));
      events.push(toolResult(at + ms.s, tid, "done", id));
      at += step;
    }
  }
  const end = t + minutes * ms.m;
  events.push({ type: "system", subtype: "task_notification", session_id: SESSION, timestamp: iso(end), tool_use_id: id, status: "completed", summary: `${lines[lines.length - 1]}`, usage: { total_tokens: total, tool_uses: tools.length, duration_ms: minutes * ms.m } });
  events.push(toolResult(end + ms.s, id, `The report follows:\n${lines.join("\n")}`));
  return { events, end: end + ms.s };
}

// The whole stream-json of a job that ends done (with a pull request) or at a gate.
function jobStream(job, repo) {
  let t = CLOCK + 2 * ms.s;
  const events = [{ type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5", tools: ["Task", "Bash", "Read"], timestamp: iso(t) }];
  t += 5 * ms.s;
  events.push(assistant(t, [{ type: "text", text: `Registered the run.\nQUEUE_SLUG: ${job.slug}\nSLUG: ${job.slug} TYPE: ${job.type}` }], { tokens: 20_000 }));
  t += 10 * ms.s;
  events.push(...bash(t, "nightqueue run start", "Open the run"));
  t += 20 * ms.s;
  events.push(assistant(t, [{ type: "text", text: "Reading the brief and recalling what the memory holds about this area." }], { tokens: job.tokensK[0] * 1000 }));
  t += job.minutes[0] * ms.m;
  events.push(...bash(t, "nightqueue run check 00", "Gate the brief"));
  t += 5 * ms.s;
  const skip = new Set(job.tier === "trivial" ? [1, 2, 3, 5, 7] : job.tier === "simple" ? (job.type === "bug" ? [2, 3, 7] : [2, 3, 5, 7]) : []);
  const last = job.status === "gate" ? 4 : 7;
  const checks = { 1: "01", 2: "02", 3: "03", 4: "04", 5: "05", 6: "06", 7: "06.5" };
  for (const agent of AGENTS) {
    const [phase] = agent;
    if (phase > last) break;
    if (skip.has(phase)) continue;
    const ran = lane(t, agent, job.minutes[phase], job.tokensK[phase], job);
    events.push(...ran.events);
    t = ran.end + 3 * ms.s;
    events.push(...bash(t, `nightqueue run check ${checks[phase]}`, "Gate the phase"));
    t += 5 * ms.s;
  }
  if (job.status === "gate") {
    events.push(assistant(t, [{ type: "text", text: `## Notice\n\n## Requires user confirmation\n\n${job.gate}` }], { tokens: 4000 }));
    events.push({ type: "result", subtype: "success", session_id: SESSION, timestamp: iso(t + ms.s), result: "Stopped at the gate.", total_cost_usd: job.cost, usage: usage(job.tokensK.reduce((a, b) => a + b, 0) * 1000) });
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
  const prUrl = `https://github.com/${repo}/pull/${job.pr}`;
  events.push(...bash(t, "git push -u origin HEAD", "Push the branch"));
  t += 20 * ms.s;
  events.push(...bash(t, `gh pr create --title "${job.title}" --body-file pr-body.md`, "Open the pull request", 4000));
  t += 15 * ms.s;
  events.push(...bash(t, "nightqueue run publish", "Record the pull request"));
  t += 20 * ms.s;
  events.push(...bash(t, "nightqueue run report", "Write the report", job.tokensK[8] * 1000));
  t += job.minutes[8] * ms.m;
  events.push(assistant(t, [{ type: "text", text: `Pull request: ${prUrl}\n\n## Notice\n\n${job.notice}` }], { tokens: 6000 }));
  const total = job.tokensK.reduce((a, b) => a + b, 0) * 1000;
  events.push({ type: "result", subtype: "success", session_id: SESSION, timestamp: iso(t + ms.s), result: `Done. Pull request: ${prUrl}\n\n## Notice\n\n${job.notice}`, total_cost_usd: job.cost, usage: usage(total), modelUsage: { "claude-opus-5-5": { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: Math.round(total * 0.6), cacheCreationInputTokens: 2000 }, "claude-sonnet-5": { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: Math.round(total * 0.4), cacheCreationInputTokens: 1000 } } });
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

// ---------- artifacts a done run leaves ----------

function artifactText(name, job) {
  const head = (title) => `# ${title}\n\n`;
  switch (name) {
    case "00-brief.md": return `${head("Brief")}## Brief\n\n${job.prompt}\n`;
    case "01-triage.md": return `${head("Triage")}## Evidence\n\nReproduced on main.\n\n## Verdict\n\nReal ${job.type}, ${job.tier} tier. Root cause located.\n`;
    case "02-explore.md": return `${head("Explore")}## File map\n\n${job.files.map((file) => `- ${file}`).join("\n")}\n`;
    case "03-plan.md": return `${head("Plan")}## Implementation plan\n\n1. The fix.\n2. The tests.\n3. The docs.\n\n## Assumptions\n\nNone beyond the brief.\n\n## Pre-mortem\n\nThe boundary condition.\n\n## Identified risks\n\n- Low.\n`;
    case "04-implementation.md": return `${head("Implementation")}## Files changed\n\n${job.files.map((file) => `- ${file}`).join("\n")}\n`;
    case "05-qa.md": return `${head("Adversarial QA")}## Round 1\n\n## Validated risks\n\n- 2 findings, both fixed.\n`;
    case "06-verification.md": return `${head("Verification")}## Round 1\n\n## Verification\n\n- \`npm test\` — PASSED ✅\n`;
    case "06-runtime.md": return `${head("Runtime check")}## Round 1\n\n## Runtime verdict\n\nok\n`;
    case "pr-body.md": return `## Report\n\n${job.notice.split("\n")[0]}\n\n## Cause\n\nSee triage.\n\n## Changes\n\n${job.files.map((file) => `- \`${file}\``).join("\n")}\n\n## QA\n\n- \`npm test\` — PASSED ✅\n`;
    default: return "";
  }
}

// ---------- seeding ----------

function sqliteStamp(t) {
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

async function seed(base) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("NIGHTQUEUE_")) delete env[key];
  Object.assign(env, isolatedHostVars(base));
  env.NIGHTQUEUE_HOME = join(base, "home");
  env.NIGHTQUEUE_EMBED_DISABLED = "1";
  env.NIGHTQUEUE_CLAUDE_BIN = FAKE_CLAUDE;
  // The runner falls back to the `claude` on PATH when the one it was given is not runnable: never let a demo reach the real one.
  accessSync(FAKE_CLAUDE, constants.X_OK);
  env.PATH = String(env.PATH ?? "").split(delimiter).filter((dir) => dir && !existsSync(join(dir, "claude"))).join(delimiter);
  const planPath = join(base, "demo-plan.json");
  env.NIGHTQUEUE_DEMO_PLAN = planPath;
  mkdirSync(env.NIGHTQUEUE_HOME, { recursive: true });

  const org = makeOrg(env, ORG);
  const checkouts = new Map();
  for (const project of PROJECTS) {
    const path = initGitRepo(join(base, ORG, project.name));
    for (const [file, content] of Object.entries(project.files)) {
      mkdirSync(join(path, file, ".."), { recursive: true });
      writeFileSync(join(path, file), content);
    }
    execFileSync("git", ["-C", path, "-c", "user.name=nightqueue", "-c", "user.email=nightqueue@example.invalid", "-c", "commit.gpgsign=false", "add", "-A"]);
    execFileSync("git", ["-C", path, "-c", "user.name=nightqueue", "-c", "user.email=nightqueue@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore: the project"]);
    registerCheckout(env, { path, name: project.name, org });
    checkouts.set(project.name, { path, id: projectIdOf(env, project.name), repo: project.repo });
  }

  // acme is the home's default org, and its connections exist (with secrets that are placeholders: nothing here ever calls them).
  const acmeId = orgIdOf(env, ORG);
  const config = loadConfig(env, { warn: () => {} });
  const secrets = loadSecrets(env, { warn: () => {} });
  config.defaultOrg = acmeId;
  addConnection({ config, secrets, name: "linear", type: "linear", orgId: null, secret: "lin_api_demo_placeholder" });
  addConnection({ config, secrets, name: "discord-eng", type: "discord", orgId: acmeId, secret: "https://discord.com/api/webhooks/0/demo-placeholder" });
  addConnection({ config, secrets, name: "sentry-acme", type: "sentry", orgId: acmeId, secret: "sntrys_demo_placeholder", extra: { org: "acme" } });
  saveConfig(config, env);
  saveSecrets(secrets, env);

  const plan = { jobs: {} };
  writeFileSync(planPath, JSON.stringify(plan));
  const rows = [];
  for (const job of JOBS) {
    const project = checkouts.get(job.project);
    const { id } = addJob({ projectId: project.id, prompt: job.prompt, priority: job.priority, title: job.title, slug: job.slug }, env);
    rows.push({ id, job, project });
    if (job.status === "pending") continue;
    if (job.status === "cancelled") {
      cancelJob(id, { reason: job.reason }, env);
      continue;
    }
    plan.jobs[id] = {
      files: job.files.map((path) => ({ path, content: `// ${job.title}\nexport const changed = true;\n` })),
      commitMessage: `fix: ${job.title}`,
      stream: jobStream(job, project.repo),
    };
    writeFileSync(planPath, JSON.stringify(plan));
    const cycle = await runCycle({ jobId: id, env });
    const outcome = cycle.processed[0];
    if (!outcome || !["done", "gate"].includes(outcome.status)) throw new Error(`job ${id} (${job.slug}) ended ${JSON.stringify(cycle)}`);
    const run = getJob(id, env);
    if (run.slug) {
      const fields = recordRunFields({ projectId: project.id, slug: run.slug, fields: { tier: job.tier, type: job.type === "bug" ? "bug/error" : "feature/refactor" }, env });
      if (fields.status !== "written") throw new Error(`job ${id}: ${fields.reason}`);
      const dir = runDir(project.id, run.slug, env);
      mkdirSync(dir, { recursive: true });
      const skip = new Set(job.tier === "trivial" ? [1, 2, 3, 5, 7] : job.tier === "simple" ? (job.type === "bug" ? [2, 3, 7] : [2, 3, 5, 7]) : []);
      writeFileSync(join(dir, "00-brief.md"), artifactText("00-brief.md", job));
      const last = job.status === "gate" ? 4 : 8;
      for (let phase = 1; phase <= last; phase++) {
        if (skip.has(phase)) continue;
        const name = PHASE_NAMES[phase - 1];
        const artifact = PHASE_ARTIFACTS[phase - 1];
        writeFileSync(join(dir, artifact), artifactText(artifact, job));
        recordPhaseDone({ projectId: project.id, slug: run.slug, phase: name, artifact, verdict: "ok", env });
      }
    }
    if (job.status === "closed") {
      if (!acquireClose(id, { worker: "demo:close", leaseS: 600 }, env)) throw new Error(`job ${id} refused the close lease`);
      const checklist = mergedChecklist(job.pr);
      if (!settleClose(id, { worker: "demo:close", close: checklist, noticeLine: checklist.data.noticeLine }, env)) throw new Error(`job ${id} refused the settle`);
    }
  }

  // The origin each checkout would push to, named only now so no run tried to reach it.
  for (const [name, checkout] of checkouts) execFileSync("git", ["-C", checkout.path, "remote", "add", "origin", `https://github.com/${checkout.repo}.git`]);

  // The clock of the night: every job started and ended when its stream says, not when this script ran.
  const db = openDb(env);
  for (const { id, job } of rows) {
    const created = NIGHT - (12 + rows.length - id) * 37 * ms.m; // queued during the day, oldest first
    db.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(sqliteStamp(created), id);
    if (!("startMin" in job)) continue;
    const started = NIGHT + job.startMin * ms.m;
    const finished = started + job.minutes.reduce((a, b) => a + b, 0) * ms.m + ((id * 37) % 53 + 7) * ms.s;
    db.prepare("UPDATE jobs SET started_at = ?, finished_at = ?, tier = ? WHERE id = ?").run(sqliteStamp(started), sqliteStamp(finished), job.tier, id);
    db.prepare("UPDATE job_attempts SET started_at = ?, finished_at = ? WHERE job_id = ?").run(sqliteStamp(started), sqliteStamp(finished), id);
  }
  closeDb(env);
  return { env, rows, checkouts };
}

// ---------- capture ----------

async function capture(url, origin, rows) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark" });
  mkdirSync(OUT_DIR, { recursive: true });
  const shot = (name) => page.screenshot({ path: join(OUT_DIR, `studio-${name}.png`) });
  await page.goto(url);
  await page.waitForSelector("text=Start runner");
  await page.waitForTimeout(1200);
  await shot("queue");

  const jobPage = rows.find(({ job }) => job.status === "done");
  await page.goto(`${origin}/jobs/J-${jobPage.id}`);
  await page.waitForSelector("text=PIPELINE");
  await page.waitForTimeout(1500);
  await shot("job");

  await page.goto(`${origin}/`);
  await page.waitForSelector("text=Start runner");
  await page.click("text=+ Add job");
  await page.waitForSelector("textarea");
  await page.fill("textarea", "Export the audit log as CSV from GET /admin/audit?format=csv, same filters as the JSON answer, streamed, at most 100k rows per file.");
  await page.waitForTimeout(600);
  await shot("add-job");

  await page.goto(`${origin}/settings`);
  await page.waitForSelector("text=Integrations");
  await page.waitForTimeout(1000);
  await shot("settings");
  await browser.close();
  console.log(`captured docs/assets/studio-{queue,job,add-job,settings}.png`);
}

// ---------- main ----------

const base = mkdtempSync(join(tmpdir(), "nightqueue-demo-"));
try {
  const { env, rows } = await seed(base);
  if (CHECK) {
    for (const { id, job } of rows) console.log(`J-${id} ${getJob(id, env).status.padEnd(9)} ${job.project.padEnd(6)} ${job.title}`);
  } else {
    const studio = await startStudioServer({ env, port: CAPTURE ? 0 : PORT, token: TOKEN, distDir: resolve(ROOT, "studio", "dist") });
    console.log(`studio demo: ${studio.url}`);
    console.log(`home: ${env.NIGHTQUEUE_HOME}`);
    if (CAPTURE) await capture(studio.url, studio.origin, rows);
    else await new Promise((done) => process.once("SIGINT", done));
    await studio.close();
  }
  closeDb(env);
} finally {
  if (!KEEP) rmSync(base, { recursive: true, force: true });
}
