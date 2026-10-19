// Keeps the home's stored secrets out of any text a tool answers: the records never leave src/integrations, only the redacted text does.
import { quietFiles } from "./coverage.mjs";
import { providerOf } from "./registry.mjs";

const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

// The secret values one stored connection declares through its provider: its secret fields and the parts of them an answer may echo alone.
function recordSecrets(record) {
  const provider = providerOf(record?.type);
  const fields = Array.isArray(provider?.connection?.secretFields) ? provider.connection.secretFields.map((field) => record[field]) : [];
  const parts = typeof provider?.call?.secretParts === "function" ? provider.call.secretParts(record) : [];
  return [...fields, ...(Array.isArray(parts) ? parts : [])];
}

// The secret values the home's connections declare through their provider, plus the extra ones given, longest first.
function declaredSecrets(env, also = []) {
  const connections = Object.values(quietFiles(env).secrets?.connections ?? {});
  const values = connections.flatMap(recordSecrets);
  const extra = Array.isArray(also) ? also : [];
  const secrets = [...values, ...extra].filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH);
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

// A text with each of the given secrets replaced by a fixed marker.
function replaceSecrets(text, secrets) {
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
}

// A text with every secret value of the home, and each extra one in `also`, replaced by a fixed marker; anything but a text is answered as is.
export function redactSecrets(text, env, { also = [] } = {}) {
  if (typeof text !== "string" || !text) return text;
  return replaceSecrets(text, declaredSecrets(env, also));
}

// A JSON-like value with every text and object key inside it, at any depth, passed through the given secrets.
function redactNested(value, secrets) {
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactNested(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceSecrets(key, secrets), redactNested(item, secrets)]));
}

// A JSON-like value with every secret value of the home, and each extra one in `also`, redacted from each of its texts; answered as is when there is none.
export function redactValue(value, env, { also = [] } = {}) {
  const secrets = declaredSecrets(env, also);
  return secrets.length ? redactNested(value, secrets) : value;
}
