import type { JobOrigin } from "./types";

export const TIERS = ["auto", "trivial", "simple", "complex"] as const;

export type Tier = (typeof TIERS)[number];

export const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const DEFAULT_PRIORITY = 5;

export interface AddJobForm {
  project: string;
  text: string;
  tier: Tier;
  priority: number;
  origin: JobOrigin | false | null;
  originUrl: string | null;
}

export const EMPTY_ADD_FORM: AddJobForm = { project: "", text: "", tier: "auto", priority: DEFAULT_PRIORITY, origin: null, originUrl: null };

// The `origin` argument of the form: the chip's origin, `false` once the chip was cleared, nothing when it never had one.
function originArg(origin: AddJobForm["origin"]): Record<string, unknown> {
  if (origin === false) return { origin: false };
  return origin ? { origin: { kind: origin.kind, ref: origin.ref } } : {};
}

// The exact arguments `queue_add` gets from the form: the text as the brief; `auto` sends no tier; the origin only when set or cleared.
export function buildAddArgs(form: AddJobForm): Record<string, unknown> {
  const text = form.text.trim();
  const tier = form.tier === "auto" ? {} : { tier: form.tier };
  return { project: form.project, prompt: text, ...tier, priority: form.priority, ...originArg(form.origin) };
}

// What still keeps the form from being queued, or null when it is complete.
export function addFormProblem(form: AddJobForm): string | null {
  if (!form.project) return "choose a project";
  if (form.text.trim() === "") return "write the brief";
  if (!Number.isInteger(form.priority) || !PRIORITIES.includes(form.priority)) return "choose a priority from 1 to 9";
  return null;
}

// The project the form queues for: the chosen one, else the first project only when the form never had an origin.
export function effectiveProject(draft: Pick<AddJobForm, "project" | "origin">, firstProject: string): string {
  if (draft.project) return draft.project;
  return draft.origin === null ? firstProject : "";
}

// The text without every line that is exactly the given one, runs of blank lines left behind collapsed into one.
function withoutLine(text: string, line: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((candidate) => candidate.trim() !== line);
  if (kept.length === lines.length) return text;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

// The form marked as having no origin, the prefilled origin URL line of the brief removed.
export function clearOrigin(form: AddJobForm): AddJobForm {
  const url = form.originUrl?.trim() ?? "";
  const text = url ? withoutLine(form.text, url) : form.text;
  return { ...form, origin: false, originUrl: null, text };
}
