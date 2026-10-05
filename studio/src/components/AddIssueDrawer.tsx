import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useProjects } from "../lib/api";
import { callTool } from "../lib/mcp";
import { showToast } from "../lib/toast";
import { useEscape } from "../lib/useEscape";
import { useSubmit } from "../lib/useSubmit";
import { ProjectPicker } from "./ProjectPicker";
import { Button, FIELD_CLASS, Segmented } from "./ui";

interface AddIssueDrawerProps {
  onClose: () => void;
  initialProject?: string;
}

const ISSUE_TYPES = ["bug", "feature", "improvement", "chore", "incident"] as const;
type IssueType = (typeof ISSUE_TYPES)[number];

const TYPE_OPTIONS = ISSUE_TYPES.map((type) => ({ value: type, label: type }));
const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const DEFAULT_PRIORITY = 5;
const INPUT_CLASS = `${FIELD_CLASS} min-h-9 w-full px-2.5`;

interface IssueForm {
  project: string;
  title: string;
  type: IssueType;
  priority: number;
  detail: string;
}

type SetField = <K extends keyof IssueForm>(key: K, value: IssueForm[K]) => void;

// A labelled field of the drawer, with an optional dim aside after the label.
function Field({ id, label, aside, children }: { id?: string; label: string; aside?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm text-muted">
        {label} {aside && <span className="text-dim">{aside}</span>}
      </label>
      {children}
    </div>
  );
}

// The `issue_save` arguments the form sends: project, type and title always, priority and detail when set.
function buildSaveArgs(form: IssueForm): Record<string, unknown> {
  const args: Record<string, unknown> = { project: form.project, type: form.type, title: form.title.trim() };
  if (form.priority !== DEFAULT_PRIORITY) args.priority = form.priority;
  if (form.detail.trim()) args.detail = form.detail.trim();
  return args;
}

// What stops the form from being sent, or null when it can go.
function formProblem(form: IssueForm): string | null {
  if (!form.project) return "choose a project";
  if (!form.title.trim()) return "write a title";
  return null;
}

// Saves the issue through the MCP tool.
async function saveIssue(args: Record<string, unknown>): Promise<void> {
  const answer = await callTool<{ ref?: string }>("issue_save", args);
  showToast(answer?.ref ? `${answer.ref} saved` : "issue saved", "success");
}

// Closes the drawer after an issue is saved, refreshing the issues lists.
function useSavedDone(onClose: () => void) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["issues"] });
    onClose();
  }, [queryClient, onClose]);
}

// The project picker of the drawer, with its loading and failed states.
function ProjectField({ projects, value, onChange }: { projects: ReturnType<typeof useProjects>; value: string; onChange: (name: string) => void }) {
  if (projects.isPending) return <div className="h-11 animate-pulse rounded-md bg-row-line" aria-label="loading projects" />;
  if (projects.isError) return <p className="m-0 text-sm text-red">The projects cannot be read; reload the page.</p>;
  if (projects.data.length === 0) return <p className="m-0 text-sm text-muted">No project is registered in this home.</p>;
  return <ProjectPicker id="issue-project" projects={projects.data} value={value} onChange={onChange} />;
}

// The Add issue drawer: project, title, type, priority and detail; saves with `issue_save` (status `todo`).
export function AddIssueDrawer({ onClose, initialProject }: AddIssueDrawerProps) {
  const projects = useProjects();
  const [draft, setDraft] = useState<IssueForm>({ project: initialProject ?? "", title: "", type: "improvement", priority: DEFAULT_PRIORITY, detail: "" });
  const titleRef = useRef<HTMLInputElement>(null);
  const form: IssueForm = { ...draft, project: draft.project || projects.data?.[0]?.name || "" };
  const set: SetField = (key, value) => setDraft((current) => ({ ...current, project: form.project, [key]: value }));
  const args = buildSaveArgs(form);
  const problem = formProblem(form);
  const submit = useSubmit(saveIssue, useSavedDone(onClose));
  useEscape(onClose);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-[rgba(5,7,10,.55)]" onMouseDown={onClose} aria-hidden="true" />
      <aside aria-label="Add issue" className="absolute top-0 right-0 bottom-0 flex w-full flex-col border-l border-line bg-surface text-[14px] leading-[1.45] text-fg shadow-[-20px_0_60px_rgba(0,0,0,.5)] sm:w-[480px]">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <div className="text-base font-semibold">Add issue</div>
        </div>
        <div className="flex grow flex-col gap-4 overflow-auto p-5">
          <Field id="issue-project" label="Project">
            <ProjectField projects={projects} value={form.project} onChange={(project) => set("project", project)} />
          </Field>
          <Field id="issue-title" label="Title">
            <input ref={titleRef} id="issue-title" type="text" className={INPUT_CLASS} value={form.title} onChange={(event) => set("title", event.target.value)} />
          </Field>
          <Field label="Type" aside="(sets the default tier of its job)">
            <Segmented<IssueType> label="type" options={TYPE_OPTIONS} value={form.type} onChange={(type) => set("type", type)} />
          </Field>
          <Field id="issue-priority" label="Priority">
            <select id="issue-priority" className={INPUT_CLASS} value={form.priority} onChange={(event) => set("priority", Number(event.target.value))}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority === 1 ? "1 · urgent" : priority === DEFAULT_PRIORITY ? `${priority} · default` : priority}
                </option>
              ))}
            </select>
          </Field>
          <Field id="issue-detail" label="Detail" aside="(the brief a job built from this issue receives)">
            <textarea id="issue-detail" rows={10} className={`${INPUT_CLASS} resize-y py-2`} value={form.detail} onChange={(event) => set("detail", event.target.value)} />
          </Field>
          <div className="flex flex-col gap-1 rounded-md border border-button-line bg-header px-3 py-2.5 text-sm text-muted">
            <div className="max-h-24 overflow-auto font-mono break-all">issue_save {JSON.stringify(args)}</div>
            {problem && <div className="text-amber">To save: {problem}.</div>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="ml-auto">
            <Button variant="primary" disabled={problem !== null || submit.isPending} onClick={() => submit.mutate(args)}>
              {submit.isPending ? "Saving…" : "Save issue"}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
