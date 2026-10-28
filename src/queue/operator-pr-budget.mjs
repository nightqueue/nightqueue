import { GUARD_PR_VIEW_TIMEOUT_MS, ghPrStatesSync } from "../host/gh.mjs";

let active = null;

// A fresh gh budget: one deadline every pull request read under it shares, and the states already read.
function newBudget() {
  return { deadline: Date.now() + GUARD_PR_VIEW_TIMEOUT_MS, states: new Map() };
}

// Runs one guard decision under one gh budget (the one already running, if any), so each pull request is read once and all of them within 3 s.
export function withPrBudget(decide) {
  if (active) return decide();
  active = newBudget();
  try {
    return decide();
  } finally {
    active = null;
  }
}

// The pull request states read under the running budget (a fresh one outside a decision), the URLs not read yet read at once in the time left.
export function prStates(urls, env = process.env) {
  const budget = active ?? newBudget();
  const unread = [...new Set(Array.isArray(urls) ? urls : [])].filter((url) => !budget.states.has(url));
  if (unread.length === 0) return budget.states;
  const read = ghPrStatesSync(unread, { env, timeoutMs: budget.deadline - Date.now() });
  for (const url of unread) budget.states.set(url, read.get(url));
  return budget.states;
}
