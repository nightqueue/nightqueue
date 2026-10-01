import { UserError } from "../config/errors.mjs";
import { requestJson } from "./http.mjs";

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)$/;
const MESSAGE_LINK = /https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;
const BARE_REF = /^(\d+)\/(\d+)\/(\d+)$/;
const SNOWFLAKE = /^\d+$/;
const LOG_EVENTS = Object.freeze(["closed"]);
const MAX_CONTENT = 2000;

// Reads a Discord reference `<guild>/<channel>/<message>`: a message link, or (explicitly given) the bare triple.
function parseDiscord(text, { explicit = false } = {}) {
  const linked = MESSAGE_LINK.exec(text);
  if (linked) return `${linked[1]}/${linked[2]}/${linked[3]}`;
  if (!explicit) return null;
  const bare = BARE_REF.exec(text.trim());
  return bare ? `${bare[1]}/${bare[2]}/${bare[3]}` : null;
}

// The guild, channel and message ids of a reference.
function refParts(ref) {
  const [guild, channel, message] = String(ref ?? "").split("/");
  return { guild, channel, message };
}

// The ids a webhook GET answers, or null when the answer does not carry them.
function webhookIds(body) {
  const channelId = String(body?.channel_id ?? "");
  const guildId = String(body?.guild_id ?? "");
  return SNOWFLAKE.test(channelId) && SNOWFLAKE.test(guildId) ? { channelId, guildId } : null;
}

// Reads the channel and guild of a webhook, answering { ok, status, channelId, guildId, detail } without the URL.
async function testDiscord(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!WEBHOOK_URL.test(String(record?.url ?? ""))) return { ok: false, status: null, channelId: null, guildId: null, detail: "not a Discord webhook URL" };
  const answer = await requestJson(fetchImpl, record.url, { timeoutMs });
  const ids = answer.ok ? webhookIds(answer.body) : null;
  if (!ids) return { ok: false, status: answer.status, channelId: null, guildId: null, detail: answer.ok ? "the webhook answered no channel" : answer.detail };
  return { ok: true, status: answer.status, ...ids, detail: "ok" };
}

// Describes a successful Discord connection test in one line.
function summarizeDiscord(result) {
  return `channel=${result.channelId ?? "(none)"} guild=${result.guildId ?? "(none)"}`;
}

// Derives the channel and guild of a webhook at `connection add`; the URL is never echoed back.
async function completeDiscord(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!WEBHOOK_URL.test(String(record?.url ?? ""))) {
    throw new UserError("the secret is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>); nothing was stored");
  }
  const result = await testDiscord(record, { fetchImpl, timeoutMs });
  if (!result.ok) throw new UserError(`the Discord webhook could not be read (${result.detail}); nothing was stored`);
  return { ...record, channelId: result.channelId, guildId: result.guildId, mode: "webhook" };
}

// Which org webhook covers a message: the one posting in its channel, otherwise none with the probe that runs at close.
function coversDiscord(ref, { connections }) {
  const { guild, channel } = refParts(ref);
  const match = connections.find((connection) => connection.channelId === channel);
  if (match) return { connection: match.name, detail: null };
  const candidates = connections.filter((connection) => connection.guildId === guild).length;
  return { connection: null, detail: `thread or other channel: probes the org's webhooks of guild ${guild} at close (${candidates})` };
}

// The first seven characters of a merge sha.
function shortSha(sha) {
  return typeof sha === "string" && sha ? sha.slice(0, 7) : "unknown";
}

// A message body that pings nobody, cut to Discord's content limit.
function messageBody(content) {
  return { content: content.slice(0, MAX_CONTENT), allowed_mentions: { parse: [] } };
}

// Posts a message through a webhook, into a thread of its channel when one is named.
function postMessage(http, connection, { content, threadId }) {
  const thread = threadId ? `&thread_id=${encodeURIComponent(threadId)}` : "";
  return http(`${connection.url}?wait=true${thread}`, { method: "POST", body: messageBody(content) });
}

// Tells whether a refused post is worth trying through another webhook: a client refusal other than rate limiting.
function isProbeRefusal(answer) {
  return typeof answer.status === "number" && answer.status >= 400 && answer.status < 500 && answer.status !== 429;
}

// The reply posted under the message the job came from.
function replyContent(ref, result) {
  const { guild, channel, message } = refParts(ref);
  const jump = `https://discord.com/channels/${guild}/${channel}/${message}`;
  return `Fixed in ${result?.prUrl ?? "the merged pull request"} (merged as ${shortSha(result?.mergeSha)}) - ${jump}`;
}

// Tries the org's other webhooks of the guild as posters into the channel as a thread, stopping on the first that posts.
async function probeThread({ ref, content, connections, post }) {
  const { guild, channel } = refParts(ref);
  for (const connection of connections.filter((candidate) => candidate.guildId === guild && candidate.channelId !== channel)) {
    const answer = await post(connection, { content, threadId: channel });
    if (answer.ok) return { status: "done", note: `replied in thread ${channel} through ${connection.name}` };
    if (!isProbeRefusal(answer)) return { status: "warning", note: `reply in thread ${channel} not posted through ${connection.name} (${answer.detail})` };
  }
  return { status: "skipped", note: `no webhook of the org can post in channel ${channel}`, notice: true };
}

// Replies to the message the job came from: in its channel when an org webhook posts there, otherwise as a thread probe.
async function replyToOrigin({ ref, result, settings, connections, http }) {
  if (settings?.replyToOrigin === false) return { status: "skipped", note: "replyToOrigin is false" };
  const content = replyContent(ref, result);
  const post = (connection, message) => postMessage(http, connection, message);
  const { channel } = refParts(ref);
  const match = connections.find((connection) => connection.channelId === channel);
  if (!match) return probeThread({ ref, content, connections, post });
  const answer = await post(match, { content });
  if (answer.ok) return { status: "done", note: `replied in channel ${channel} through ${match.name}` };
  return { status: "warning", note: `reply in channel ${channel} not posted through ${match.name} (${answer.detail})` };
}

// The log line of a closed job.
function closedLogContent(job, result) {
  const pr = result?.prNumber ? `PR #${result.prNumber}` : "PR";
  const title = job?.title ? `: ${job.title}` : "";
  const link = result?.prUrl ? `\n${result.prUrl}` : "";
  return `${job?.ref ?? "job"} closed - ${pr} merged as ${shortSha(result?.mergeSha)}${title}${link}`;
}

// Posts a job event to the project's log webhook.
async function logToDiscord({ event, job, result, connection, http }) {
  if (event !== "closed") return { status: "skipped", note: `no log for the event ${event}` };
  const answer = await postMessage(http, connection, { content: closedLogContent(job, result) });
  if (answer.ok) return { status: "done", note: `logged through ${connection.name}` };
  return { status: "warning", note: `log not posted through ${connection.name} (${answer.detail})` };
}

export const discord = {
  kind: "discord",
  connection: {
    cardinality: "many",
    secretFields: ["url"],
    extraFields: [],
    secretLabel: "webhook URL",
    test: testDiscord,
    summary: summarizeDiscord,
    complete: completeDiscord,
  },
  capabilities: { post: true, read: false, resolve: false },
  origin: { parse: parseDiscord },
  settings: {
    replyToOrigin: { type: "boolean", default: true },
    "log.connection": { type: "connection" },
    "log.events": { type: "list", values: LOG_EVENTS, default: [...LOG_EVENTS] },
  },
  covers: coversDiscord,
  onClosed: replyToOrigin,
  log: logToDiscord,
};
