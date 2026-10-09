import { UserError } from "../config/errors.mjs";
import { requestJson } from "./http.mjs";

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)$/;
const MESSAGE_LINK = /https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;
const BARE_REF = /^(\d+)\/(\d+)\/(\d+)$/;
const SNOWFLAKE = /^\d+$/;
const LOG_EVENTS = Object.freeze(["closed"]);
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const EMBED_FIELD_MAX = 1024;
const EMBED_FOOTER_MAX = 2048;
const MERGED_COLOR = 0x2ECC71;
const DONE_LABEL = "What was done:";
const WEBHOOK_NAME_MAX = 80;
const NO_CHANNEL_DETAIL = "the webhook answered no channel";
const CONNECTED_DESCRIPTION = "This channel gets the “job closed” notice of the projects linked to this connection.";

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

// The display name a webhook GET answers, at most 80 characters, or null.
function webhookNameOf(body) {
  const name = String(body?.name ?? "").trim().slice(0, WEBHOOK_NAME_MAX);
  return name || null;
}

// The ids a webhook GET answers, and its name when it has one, or null when the answer does not carry the ids.
function webhookIds(body) {
  const channelId = String(body?.channel_id ?? "");
  const guildId = String(body?.guild_id ?? "");
  if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(guildId)) return null;
  const webhookName = webhookNameOf(body);
  return webhookName ? { channelId, guildId, webhookName } : { channelId, guildId };
}

// Tells whether a text is a Discord webhook URL, without echoing it.
export function isWebhookUrl(text) {
  return WEBHOOK_URL.test(String(text ?? ""));
}

// Reads the channel, guild and name of a webhook, answering { ok, status, channelId, guildId, webhookName?, detail } without the URL.
async function testDiscord(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const none = { channelId: null, guildId: null };
  if (!isWebhookUrl(record?.url)) return { ok: false, status: null, ...none, detail: "not a Discord webhook URL" };
  const answer = await requestJson(fetchImpl, record.url, { timeoutMs });
  const ids = answer.ok ? webhookIds(answer.body) : null;
  if (!ids) return { ok: false, status: answer.status, ...none, detail: answer.ok ? NO_CHANNEL_DETAIL : answer.detail };
  return { ok: true, status: answer.status, ...ids, detail: "ok" };
}

// Posts the one "nightqueue connected" embed a studio add sends, answering { ok, status, detail } without the URL.
export async function announceWebhook(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!isWebhookUrl(record?.url)) return { ok: false, status: null, detail: "not a Discord webhook URL" };
  const embed = { title: "nightqueue connected", description: CONNECTED_DESCRIPTION, color: MERGED_COLOR };
  const answer = await requestJson(fetchImpl, `${record.url}?wait=true`, { method: "POST", body: messageBody({ embeds: [embed] }), timeoutMs });
  return { ok: answer.ok, status: answer.status, detail: answer.detail };
}

// The fixed sentence that explains a Discord answer to a person; it never carries the URL.
export function discordReason(result) {
  const status = result?.status;
  if (status === null || status === undefined) return `No answer from Discord (${result?.detail ?? "network failure"}).`;
  if (status === 404) return "Discord answered 404: the webhook was deleted on the server.";
  if (status === 401 || status === 403) return `Discord answered ${status}: the webhook token is no longer valid.`;
  if (status === 429) return "Discord answered 429: rate limited, test again in a minute.";
  if (status >= 200 && status < 300) return "Discord answered without a channel.";
  return `Discord answered ${status}.`;
}

// Describes a successful Discord connection test in one line.
function summarizeDiscord(result) {
  return `channel=${result.channelId ?? "(none)"} guild=${result.guildId ?? "(none)"}`;
}

// Derives the channel and guild of a webhook at `connection add`; the URL is never echoed back.
async function completeDiscord(record, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!isWebhookUrl(record?.url)) {
    throw new UserError("the secret is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>); nothing was stored");
  }
  const result = await testDiscord(record, { fetchImpl, timeoutMs });
  if (!result.ok) throw new UserError(`the Discord webhook could not be read (${result.detail}); nothing was stored`);
  const named = result.webhookName ? { webhookName: result.webhookName } : {};
  return { ...record, channelId: result.channelId, guildId: result.guildId, ...named, mode: "webhook" };
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

// A message body of embeds only, so no bare URL gets a link preview, that pings nobody.
function messageBody({ embeds }) {
  return { content: "", embeds, allowed_mentions: { parse: [] } };
}

// Posts a message through a webhook, into a thread of its channel when one is named.
function postMessage(http, connection, { embeds, threadId }) {
  const thread = threadId ? `&thread_id=${encodeURIComponent(threadId)}` : "";
  return http(`${connection.url}?wait=true${thread}`, { method: "POST", body: messageBody({ embeds }) });
}

// A text truncated to a Discord embed limit, ending in `…` when it was cut.
function cut(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// The text with its first character upper-cased.
function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The headline and first "What was done:" sentence of a job notice, or null for a blank notice; a sentence ends at `.`, `!` or `?` followed by whitespace or the end, so an abbreviation like `e.g.` cuts it there.
export function noticeSummary(noticeMd) {
  const text = String(noticeMd ?? "");
  const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (!first) return null;
  const headline = first.replace(/^[\p{Extended_Pictographic}️\s]+/u, "").replace(/^(?:Delivered|(?:Partially )?fixed)\s+—\s*/i, "").trim();
  const labelAt = text.indexOf(DONE_LABEL);
  const paragraph = labelAt === -1 ? "" : text.slice(labelAt + DONE_LABEL.length).split(/\n\s*\n/)[0].trim();
  const sentence = /^[\s\S]*?(?:[.!?](?=\s|$)|$)/.exec(paragraph)[0].trim();
  return { headline, firstDone: sentence || null };
}

// The two-line description of a closed job: the pull request title as GitHub holds it (prefix and all), then the first "What was done:" sentence of the notice; the notice headline stands in for a job whose title is unknown.
function closedDescription(job) {
  const summary = noticeSummary(job?.notice_md);
  const title = String(job?.title ?? "").trim() || capitalise(summary?.headline ?? "");
  if (!summary?.firstDone) return cut(title, EMBED_DESCRIPTION_MAX);
  return cut(`${title}\n${capitalise(summary.firstDone)}`, EMBED_DESCRIPTION_MAX);
}

// The embed parts both messages share: pull request link, merge footer, merge time and color.
function mergeEmbed(result) {
  const embed = { footer: { text: cut(`merged as ${shortSha(result?.mergeSha)}`, EMBED_FOOTER_MAX) }, color: MERGED_COLOR };
  if (result?.prUrl) embed.url = result.prUrl;
  if (result?.mergedAt) embed.timestamp = result.mergedAt;
  return embed;
}

// The pull request as a masked link, or plain text when its url or number is missing.
function pullRequestLink(result) {
  if (!result?.prUrl || !result?.prNumber) return "the merged pull request";
  return `[#${result.prNumber}](${result.prUrl})`;
}

// Tells whether a refused post is worth trying through another webhook: a client refusal other than rate limiting.
function isProbeRefusal(answer) {
  return typeof answer.status === "number" && answer.status >= 400 && answer.status < 500 && answer.status !== 429;
}

// The reply posted under the message the job came from.
function replyContent(ref, result, job) {
  const { guild, channel, message } = refParts(ref);
  const jump = `[message](https://discord.com/channels/${guild}/${channel}/${message})`;
  return {
    ...mergeEmbed(result),
    title: cut(`Fixed · ${job?.ref ?? "job"}`, EMBED_TITLE_MAX),
    description: closedDescription(job),
    fields: [{ name: "Reported", value: cut(jump, EMBED_FIELD_MAX) }],
  };
}

// Tries the org's other webhooks of the guild as posters into the channel as a thread, stopping on the first that posts.
async function probeThread({ ref, embeds, connections, post }) {
  const { guild, channel } = refParts(ref);
  for (const connection of connections.filter((candidate) => candidate.guildId === guild && candidate.channelId !== channel)) {
    const answer = await post(connection, { embeds, threadId: channel });
    if (answer.ok) return { status: "done", note: `replied in thread ${channel} through ${connection.name}` };
    if (!isProbeRefusal(answer)) return { status: "warning", note: `reply in thread ${channel} not posted through ${connection.name} (${answer.detail})` };
  }
  return { status: "skipped", note: `no webhook of the org can post in channel ${channel}`, notice: true };
}

// Replies to the message the job came from: in its channel when an org webhook posts there, otherwise as a thread probe.
async function replyToOrigin({ ref, job, result, settings, connections, http }) {
  if (settings?.replyToOrigin === false) return { status: "skipped", note: "replyToOrigin is false" };
  const embeds = [replyContent(ref, result, job)];
  const post = (connection, message) => postMessage(http, connection, message);
  const { channel } = refParts(ref);
  const match = connections.find((connection) => connection.channelId === channel);
  if (!match) return probeThread({ ref, embeds, connections, post });
  const answer = await post(match, { embeds });
  if (answer.ok) return { status: "done", note: `replied in channel ${channel} through ${match.name}` };
  return { status: "warning", note: `reply in channel ${channel} not posted through ${match.name} (${answer.detail})` };
}

// The log embed of a closed job: titled by its ref and slug, described by its notice.
function closedLogContent(job, result) {
  const ref = job?.ref ?? "job";
  return {
    ...mergeEmbed(result),
    title: cut(job?.slug ? `${ref} closed · ${job.slug}` : `${ref} closed`, EMBED_TITLE_MAX),
    description: closedDescription(job),
    fields: [
      { name: "PR", value: cut(pullRequestLink(result), EMBED_FIELD_MAX), inline: true },
      { name: "Project", value: cut(job?.project ?? "unknown", EMBED_FIELD_MAX), inline: true },
    ],
  };
}

// Posts a job event to the project's log webhook.
async function logToDiscord({ event, job, result, connection, http }) {
  if (event !== "closed") return { status: "skipped", note: `no log for the event ${event}` };
  const answer = await postMessage(http, connection, { embeds: [closedLogContent(job, result)] });
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
    reason: discordReason,
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
