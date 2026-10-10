import { discord } from "./discord.mjs";
import { github } from "./github.mjs";
import { linear } from "./linear.mjs";
import { sentry } from "./sentry.mjs";

const BUILT_IN = Object.freeze([github, sentry, linear, discord]);

let active = BUILT_IN;

// Lists the providers of this build, in registry order.
export function providers() {
  return active;
}

// Returns the provider of a kind, or null when this build has none.
export function providerOf(kind) {
  return active.find((provider) => provider.kind === kind) ?? null;
}

// Lists the providers whose credential is stored as a connection, in registry order.
export function connectionProviders() {
  return active.filter((provider) => Boolean(provider.connection));
}

// Lists the providers the machine is already logged into instead of storing a connection, in registry order.
export function ambientProviders() {
  return active.filter((provider) => Boolean(provider.ambient) && !provider.connection);
}

// Lists the kinds that used to be stored connections and are now read from the machine.
export function retiredConnectionKinds() {
  return ambientProviders().map((provider) => provider.kind);
}

// Maps each provider kind to its connection descriptor.
export function connectionTypes() {
  return new Map(connectionProviders().map((provider) => [provider.kind, provider.connection]));
}

// Where a provider's credential lives: the machine, the whole home or each org.
function placeOf(provider) {
  if (!provider.connection) return "machine";
  return provider.connection.scope === "home" ? "home" : "org";
}

// The add form a connection provider declares, as plain data; null for a provider without a connection.
function addFormOf(provider, place) {
  const connection = provider.connection;
  if (!connection) return null;
  const fields = (connection.extraFields ?? []).map((field) => ({
    name: field.name,
    format: field.format ?? null,
    required: field.required === true,
    default: field.default ?? null,
  }));
  return {
    secretField: connection.secretFields?.[0] ?? null,
    secretLabel: connection.secretLabel ?? "secret",
    nameRequired: connection.cardinality === "many",
    orgRequired: place === "org",
    fields,
  };
}

// The Settings card of one provider as plain data: no function and no secret.
function moduleCard(provider) {
  const place = placeOf(provider);
  return {
    kind: provider.kind,
    label: provider.label ?? provider.kind,
    description: provider.description ?? "",
    icon: typeof provider.card?.icon === "string" ? provider.card.icon : null,
    destinations: provider.card?.destinations === true,
    place,
    cardinality: provider.connection?.cardinality ?? null,
    add: addFormOf(provider, place),
    ambient: provider.ambient ? { statusPath: `/api/integrations/${provider.kind}/status`, command: provider.ambient.command ?? null } : null,
  };
}

// The Settings cards of every provider with a connection or an ambient login, by card order then registry order.
export function moduleCards() {
  const orderOf = (provider) => (Number.isFinite(provider.card?.order) ? provider.card.order : Number.MAX_SAFE_INTEGER);
  return active
    .map((provider, index) => ({ provider, index }))
    .filter(({ provider }) => provider.connection || provider.ambient)
    .sort((a, b) => orderOf(a.provider) - orderOf(b.provider) || a.index - b.index)
    .map(({ provider }) => moduleCard(provider));
}

// Tells whether a kind's connection serves the whole home instead of an org.
export function isHomeScoped(kind) {
  return providerOf(kind)?.connection?.scope === "home";
}

// Tells whether a kind acts on a job's origin: always for a home-scoped kind, otherwise when the project enabled it.
export function actsOnOrigin(kind, integrations) {
  return isHomeScoped(kind) || Boolean(integrations?.[kind]);
}

// Lists the kinds whose org binding is a single slot; a home-scoped kind has no org slot.
export function slotTypes() {
  return connectionProviders()
    .filter((provider) => provider.connection.cardinality === "one" && provider.connection.scope !== "home")
    .map((provider) => provider.kind);
}

// Lists the kinds whose org binding is a list of connections.
export function manyTypes() {
  return connectionProviders().filter((provider) => provider.connection.cardinality === "many").map((provider) => provider.kind);
}

// Lists the providers able to recognize where a job came from.
export function originProviders() {
  return active.filter((provider) => typeof provider.origin?.parse === "function");
}

// Lists the providers able to list the issues of their service.
export function trackerProviders() {
  return active.filter((provider) => typeof provider.tracker?.issues === "function");
}

// Runs fn with a replaced provider list and restores the built-in list afterwards; test-only.
export async function withProviders(list, fn) {
  if (!Array.isArray(list)) throw new TypeError("withProviders needs an array of providers");
  const previous = active;
  active = Object.freeze([...list]);
  try {
    return await fn();
  } finally {
    active = previous;
  }
}
