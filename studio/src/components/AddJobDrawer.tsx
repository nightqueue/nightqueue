import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type AddJobForm, addFormProblem, buildAddArgs, DEFAULT_PRIORITY, EMPTY_ADD_FORM, PRIORITIES, queueJob, TIERS, type Tier } from "../lib/addJob";
import { useProjects } from "../lib/api";
import { runnersOnlineLabel } from "../lib/queue";
import { useEscape } from "../lib/useEscape";
import { useSubmit } from "../lib/useSubmit";
import { IssuePicker } from "./IssuePicker";
import { ProjectPicker } from "./ProjectPicker";
import { Button, FIELD_CLASS, Segmented } from "./ui";

interface AddJobDrawerProps {
  runnersOnline: number;
  onClose: () => void;
  initialIssue?: string;
  initialProject?: string;
}

type SetField = <K extends keyof AddJobForm>(key: K, value: AddJobForm[K]) => void;

const INPUT_CLASS = `${FIELD_CLASS} min-h-9 w-full px-2.5`;

const TIER_OPTIONS = TIERS.map((tier) => ({ value: tier, label: tier }));

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

// The project picker of the drawer, with its loading and failed states.
function ProjectField({ projects, value, onChange }: { projects: ReturnType<typeof useProjects>; value: string; onChange: (name: string) => void }) {
  if (projects.isPending) return <div className="h-11 animate-pulse rounded-md bg-row-line" aria-label="loading projects" />;
  if (projects.isError) return <p className="m-0 text-sm text-red">The projects cannot be read; reload the page.</p>;
  if (projects.data.length === 0) return <p className="m-0 text-sm text-muted">No project is registered in this home.</p>;
  return <ProjectPicker id="add-project" projects={projects.data} value={value} onChange={onChange} />;
}

// The brief part of the form: an optional issue, then the operator note on an issue or the whole brief without one.
function BriefFields({ form, set, textRef }: { form: AddJobForm; set: SetField; textRef: RefObject<HTMLTextAreaElement | null> }) {
  const onIssue = form.issueRef !== null;
  return (
    <>
      <Field id="add-issue" label="Issue" aside="(optional)">
        <IssuePicker project={form.project} selected={form.issueRef} onSelect={(ref) => set("issueRef", ref)} />
      </Field>
      <Field id="add-text" label={onIssue ? "Operator note" : "Brief"} aside={onIssue ? "(optional, one-off, after the item block)" : "(the whole request, as prose)"}>
        <textarea ref={textRef} id="add-text" rows={onIssue ? 3 : 8} className={`${INPUT_CLASS} resize-y py-2`} value={form.text} onChange={(event) => set("text", event.target.value)} />
      </Field>
    </>
  );
}

// What `auto` means on the current path: the issue type's default tier, or the pipeline's own choice.
function autoTierAside(form: AddJobForm): string {
  return form.issueRef ? "(auto = the issue type's default tier)" : "(auto = the pipeline decides)";
}

// Tier and priority of the job.
function RunFields({ form, set }: { form: AddJobForm; set: SetField }) {
  return (
    <>
      <Field label="Tier" aside={autoTierAside(form)}>
        <Segmented<Tier> label="tier" options={TIER_OPTIONS} value={form.tier} onChange={(tier) => set("tier", tier)} />
      </Field>
      <Field id="add-priority" label="Priority">
        <select id="add-priority" className={INPUT_CLASS} value={form.priority} onChange={(event) => set("priority", Number(event.target.value))}>
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority === 1 ? "1 · urgent" : priority === DEFAULT_PRIORITY ? `${priority} · default` : priority}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

// The mono footer: the exact `queue_add` call the form sends, and what the runners will do with it.
function CallPreview({ args, runnersOnline, problem }: { args: Record<string, unknown>; runnersOnline: number; problem: string | null }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-button-line bg-header px-3 py-2.5 text-sm text-muted">
      <div className="max-h-24 overflow-auto font-mono break-all">queue_add {JSON.stringify(args)}</div>
      <div>{runnersOnline === 0 ? "0 runners online — the job will wait. Start one from the banner after queueing." : `${runnersOnlineLabel(runnersOnline)} — one claims the job when it frees.`}</div>
      {problem && <div className="text-amber">To queue: {problem}.</div>}
    </div>
  );
}

// Closes the drawer after a job is queued, refreshing the issues so a queued one shows its new state.
function useQueuedDone(onClose: () => void) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["issues"] });
    onClose();
  }, [queryClient, onClose]);
}

// The Add job drawer: one form (project, optional issue, brief or note, tier, priority); queues with `queue_add`, optionally starting a runner.
export function AddJobDrawer({ runnersOnline, onClose, initialIssue, initialProject }: AddJobDrawerProps) {
  const projects = useProjects();
  const [draft, setDraft] = useState<AddJobForm>({ ...EMPTY_ADD_FORM, project: initialProject ?? "", issueRef: initialIssue ?? null });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const form: AddJobForm = { ...draft, project: draft.project || projects.data?.[0]?.name || "" };
  const set: SetField = (key, value) => setDraft((current) => ({ ...current, project: form.project, [key]: value }));
  const changeProject = (project: string) => setDraft((current) => ({ ...current, project, issueRef: null }));
  const args = buildAddArgs(form);
  const problem = addFormProblem(form);
  const submit = useSubmit(queueJob, useQueuedDone(onClose));
  useEscape(onClose);
  useEffect(() => {
    if (initialIssue) textRef.current?.focus();
  }, [initialIssue]);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-[rgba(5,7,10,.55)]" onMouseDown={onClose} aria-hidden="true" />
      <aside aria-label="Add job" className="absolute top-0 right-0 bottom-0 flex w-full flex-col border-l border-line bg-surface text-[14px] leading-[1.45] text-fg shadow-[-20px_0_60px_rgba(0,0,0,.5)] sm:w-[480px]">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <div className="text-base font-semibold">Add job</div>
        </div>
        <div className="flex grow flex-col gap-4 overflow-auto p-5">
          <Field id="add-project" label="Project">
            <ProjectField projects={projects} value={form.project} onChange={changeProject} />
          </Field>
          <BriefFields form={form} set={set} textRef={textRef} />
          <RunFields form={form} set={set} />
          <CallPreview args={args} runnersOnline={runnersOnline} problem={problem} />
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button disabled={problem !== null || submit.isPending} onClick={() => submit.mutate({ args, start: false })}>
              Queue
            </Button>
            <Button variant="primary" disabled={problem !== null || submit.isPending} onClick={() => submit.mutate({ args, start: true })}>
              {submit.isPending ? "Queueing…" : "Queue and start runner"}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
