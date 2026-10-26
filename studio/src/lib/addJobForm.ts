import type { JobOrigin } from "./types";

export const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const DEFAULT_PRIORITY = 5;

export interface AddJobForm {
  project: string;
  text: string;
  priority: number;
  origin: JobOrigin[] | null;
  originUrl: string | null;
}

export const EMPTY_ADD_FORM: AddJobForm = { project: "", text: "", priority: DEFAULT_PRIORITY, origin: null, originUrl: null };

// The `origin` argument of the form: the chips' origins, `[]` once every chip was cleared, nothing when it never had one.
function originArg(origin: AddJobForm["origin"]): Record<string, unknown> {
  if (!Array.isArray(origin)) return {};
  return { origin: origin.map(({ kind, ref }) => ({ kind, ref })) };
}

// The exact arguments `queue_add` gets from the form: the text as the brief; the origin only when set or cleared.
export function buildAddArgs(form: AddJobForm): Record<string, unknown> {
  const text = form.text.trim();
  return { project: form.project, prompt: text, priority: form.priority, ...originArg(form.origin) };
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
  return { ...form, origin: [], originUrl: null, text };
}

// The form without the origin at the given position; removing the last one clears the origin and its URL line.
export function removeOrigin(form: AddJobForm, index: number): AddJobForm {
  const origins = Array.isArray(form.origin) ? form.origin : [];
  const kept = origins.filter((_, position) => position !== index);
  return kept.length === 0 ? clearOrigin(form) : { ...form, origin: kept };
}
