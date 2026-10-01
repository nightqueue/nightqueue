import { github } from "./github.mjs";

const BUILT_IN = Object.freeze([github]);

let active = BUILT_IN;

// Lists the providers of this build, in registry order.
export function providers() {
  return active;
}

// Returns the provider of a kind, or null when this build has none.
export function providerOf(kind) {
  return active.find((provider) => provider.kind === kind) ?? null;
}

// Maps each provider kind to its connection descriptor.
export function connectionTypes() {
  return new Map(active.map((provider) => [provider.kind, provider.connection]));
}

// Lists the kinds whose org binding is a single slot.
export function slotTypes() {
  return active.filter((provider) => provider.connection.cardinality === "one").map((provider) => provider.kind);
}

// Lists the kinds whose org binding is a list of connections.
export function manyTypes() {
  return active.filter((provider) => provider.connection.cardinality === "many").map((provider) => provider.kind);
}

// Lists the providers able to recognize where a job came from.
export function originProviders() {
  return active.filter((provider) => typeof provider.origin?.parse === "function");
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
