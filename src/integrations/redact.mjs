// Keeps the home's stored secrets out of any text a tool answers: the records never leave src/integrations, only the redacted text does.
import { quietFiles } from "./coverage.mjs";
import { providerOf } from "./registry.mjs";

const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

// The secret values the home's connections declare through their provider, longest first.
function declaredSecrets(env) {
  const connections = Object.values(quietFiles(env).secrets?.connections ?? {});
  const values = connections.flatMap((record) => {
    const fields = providerOf(record?.type)?.connection?.secretFields;
    return Array.isArray(fields) ? fields.map((field) => record[field]) : [];
  });
  const secrets = values.filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH);
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

// A text with each of the given secrets replaced by a fixed marker.
function replaceSecrets(text, secrets) {
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
}

// A text with every secret value of the home replaced by a fixed marker; anything but a text is answered as is.
export function redactSecrets(text, env) {
  if (typeof text !== "string" || !text) return text;
  return replaceSecrets(text, declaredSecrets(env));
}

// A JSON-like value with every text inside it, at any depth, passed through the given secrets.
function redactNested(value, secrets) {
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactNested(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNested(item, secrets)]));
}

// A JSON-like value with every secret value of the home redacted from each of its texts; answered as is when the home declares none.
export function redactValue(value, env) {
  const secrets = declaredSecrets(env);
  return secrets.length ? redactNested(value, secrets) : value;
}
