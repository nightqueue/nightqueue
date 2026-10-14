import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { errorText } from "../../../lib/actions";
import { ApiError } from "../../../lib/api";
import {
  buildPatch,
  changedSteps,
  draftOf,
  type Draft,
  footprintCounters,
  KEY_MAX,
  moveNote,
  normalizeKeyInput,
  normalizeProject,
  plural,
  type ProjectStep,
  saveLabel,
  saveOutcome,
  type SaveOutcome,
  settingControls,
  stepLabel,
  stepRefusalOf,
  toggleValues,
} from "../../../lib/projects";
import { showToast } from "../../../lib/toast";
import type { OrgRow, ProviderSettings, SettingsProject } from "../../../lib/types";
import { patchProject, useRefreshProjects, useSwapProjectRow } from "../../../lib/useProjectsSettings";
import { SideDrawer } from "../../SideDrawer";
import { Button } from "../../ui";
import { Field, INPUT_CLASS, Note } from "../bits";
import { AddProjectDialog } from "./AddProjectDialog";
import { DIRTY_CLASS, IntegrationFields } from "./IntegrationFields";
import { KeyChip, TruncatedPath } from "./ProjectRow";

interface EditProjectDrawerProps {
  project: SettingsProject;
  providers: ProviderSettings[];
  orgs: OrgRow[];
  onClose: () => void;
  onRemove: (project: SettingsProject) => void;
}

interface SectionProps {
  title: string;
  steps: ProjectStep[];
  outcome: SaveOutcome | null;
  children: ReactNode;
}

const PHONE_BUTTON = "max-sm:min-h-[46px] max-sm:flex-1";

// A titled section of the drawer, with the red note of its refused step and the amber note of its steps never applied.
function Section({ title, steps, outcome, children }: SectionProps) {
  const refused = outcome?.refused && steps.includes(outcome.refused.step) ? outcome.refused : null;
  const unapplied = outcome ? outcome.unapplied.filter((step) => steps.includes(step)) : [];
  return (
    <section className="flex flex-col gap-3 border-b border-line pb-5 last:border-b-0">
      <h3 className="m-0 text-xs font-medium tracking-[.3px] text-dim uppercase">{title}</h3>
      {children}
      {refused && (
        <Note tone="err" icon="⚠" role="alert">
          <div className="font-semibold text-red">{`${stepLabel(refused.step)} was refused`}</div>
          <div>{refused.reason}</div>
        </Note>
      )}
      {unapplied.length > 0 && <Note tone="warn" icon="⚠">{`Not applied: ${unapplied.map(stepLabel).join(", ")} — the save stopped at the refused step.`}</Note>}
    </section>
  );
}

// The draft of the drawer and its updaters.
function useDraft(project: SettingsProject, providers: ProviderSettings[]) {
  const [initial, setInitial] = useState<Draft>(() => draftOf(project, providers));
  const [draft, setDraft] = useState<Draft>(initial);
  const set = (field: keyof Omit<Draft, "integrations">, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const setSetting = (key: string, value: string) => setDraft((current) => ({ ...current, integrations: { ...current.integrations, [key]: value } }));
  const setSettings = (values: Record<string, string>) => setDraft((current) => ({ ...current, integrations: { ...current.integrations, ...values } }));
  return { initial, setInitial, draft, set, setSetting, setSettings };
}

// The ordered save of the drawer: on a refused step, the applied ones become the new baseline and the refusal is kept for its section.
function useSave({ project, providers, form, onClose }: { project: SettingsProject; providers: ProviderSettings[]; form: ReturnType<typeof useDraft>; onClose: () => void }) {
  const refresh = useRefreshProjects();
  const swap = useSwapProjectRow();
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const steps = changedSteps(form.initial, form.draft);
  const save = useMutation({
    mutationFn: () => patchProject(project.id, buildPatch(form.initial, form.draft)),
    onSuccess: (answer) => {
      if (answer.project) swap(answer.project);
      showToast(`Saved ${answer.project?.name ?? project.name}: ${answer.applied.map(stepLabel).join(", ") || "nothing changed"}`, "success");
      if (answer.unlinked.length) showToast(`Unset ${answer.unlinked.join(", ")}: the new org does not allow it`, "info");
      refresh();
      onClose();
    },
    onError: (err) => {
      const body = err instanceof ApiError ? err.body : null;
      setOutcome(saveOutcome(steps, stepRefusalOf(body)));
      const row = normalizeProject(body?.project);
      if (row) {
        swap(row);
        form.setInitial(draftOf(row, providers));
      }
      showToast(errorText(err), "error");
      refresh();
    },
  });
  return { save, steps, outcome, clearOutcome: () => setOutcome(null) };
}

// The Identity section: name and key, amber while changed, with the old keys that still resolve.
function IdentityFields({ form, project, disabled }: { form: ReturnType<typeof useDraft>; project: SettingsProject; disabled: boolean }) {
  const dirty = (field: "name" | "key") => (form.draft[field].trim() !== form.initial[field] ? DIRTY_CLASS : "");
  return (
    <>
      <Field label="Name">
        <input className={`${INPUT_CLASS} font-mono ${dirty("name")}`} value={form.draft.name} disabled={disabled} spellCheck={false} onChange={(event) => form.set("name", event.target.value)} />
      </Field>
      <Field label="Key" hint="refs read KEY-n">
        <input className={`${INPUT_CLASS} font-mono uppercase ${dirty("key")}`} value={form.draft.key} maxLength={KEY_MAX} disabled={disabled} spellCheck={false} onChange={(event) => form.set("key", normalizeKeyInput(event.target.value))} />
      </Field>
      {project.aliases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-dim">
          old keys {project.aliases.map((alias) => <KeyChip key={alias} value={alias} />)} keep resolving to this project
        </div>
      )}
      {form.draft.key.trim() !== form.initial.key && form.initial.key && <span className="text-sm text-dim">{`${form.initial.key} refs keep resolving after the change.`}</span>}
    </>
  );
}

// The Checkout section: the folder with Change folder…, the org select that moves the project, and the note of what a move unsets.
function CheckoutFields({ form, project, orgs, disabled, onChangeFolder }: { form: ReturnType<typeof useDraft>; project: SettingsProject; orgs: OrgRow[]; disabled: boolean; onChangeFolder: () => void }) {
  const note = moveNote(project, orgs, form.draft.org);
  const pathDirty = form.draft.path !== form.initial.path ? DIRTY_CLASS : "";
  return (
    <>
      <div className={`flex items-center gap-2 rounded-md border border-button-line bg-header px-2.5 py-2 ${pathDirty}`}>
        <div className="min-w-0 grow">{form.draft.path ? <TruncatedPath path={form.draft.path} /> : <span className="text-sm text-dim">no checkout</span>}</div>
        <Button size="sm" disabled={disabled} className="max-sm:min-h-11" onClick={onChangeFolder}>
          Change folder…
        </Button>
      </div>
      <Field label="Org" hint="changing it moves the project">
        <select className={`${INPUT_CLASS} ${form.draft.org !== form.initial.org ? DIRTY_CLASS : ""}`} value={form.draft.org} disabled={disabled} onChange={(event) => form.set("org", event.target.value)}>
          {orgs.map((org) => (
            <option key={org.id} value={org.name}>
              {org.name}
            </option>
          ))}
        </select>
      </Field>
      {note && <Note tone="warn" icon="⚠">{note}</Note>}
    </>
  );
}

// The Danger zone: what the project owns and the way to remove it.
function DangerZone({ project, onRemove }: { project: SettingsProject; onRemove: () => void }) {
  const rows = footprintCounters(project.footprint).total;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-strong px-3 py-3">
      <span className="text-sm text-muted">{rows ? `It owns ${plural(rows, "row")}: jobs, decisions, lessons and memory.` : "It owns no rows yet."}</span>
      <Button variant="danger" className="ml-auto max-sm:ml-0 max-sm:min-h-11 max-sm:w-full" onClick={onRemove}>
        Remove…
      </Button>
    </div>
  );
}

// The Edit project drawer: identity, checkout, integrations and danger zone, saved in one ordered PATCH.
export function EditProjectDrawer({ project, providers, orgs, onClose, onRemove }: EditProjectDrawerProps) {
  const form = useDraft(project, providers);
  const { save, steps, outcome, clearOutcome } = useSave({ project, providers, form, onClose });
  const [choosing, setChoosing] = useState(false);
  const busy = save.isPending;
  const controls = settingControls(providers, orgs.find((org) => org.name === form.draft.org));
  const edit = (apply: () => void) => {
    apply();
    clearOutcome();
  };
  const footer = (
    <div className="flex w-full gap-2">
      <Button variant="primary" className={PHONE_BUTTON} disabled={steps.length === 0 || busy} onClick={() => save.mutate()}>
        {busy ? "Saving…" : saveLabel(steps)}
      </Button>
      <Button variant="ghost" className={PHONE_BUTTON} onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
  const header = (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-dim">Edit project</span>
      <span className="truncate font-mono text-[16px] font-semibold">{project.name}</span>
    </div>
  );
  return (
    <SideDrawer label={`edit project ${project.name}`} header={header} footer={footer} onClose={choosing ? () => setChoosing(false) : onClose}>
      <div className="flex flex-col gap-5">
        <Section title="Identity" steps={["name", "key"]} outcome={outcome}>
          <IdentityFields form={{ ...form, set: (field, value) => edit(() => form.set(field, value)) }} project={project} disabled={busy} />
        </Section>
        <Section title="Checkout" steps={["org", "path"]} outcome={outcome}>
          <CheckoutFields form={{ ...form, set: (field, value) => edit(() => form.set(field, value)) }} project={project} orgs={orgs} disabled={busy} onChangeFolder={() => setChoosing(true)} />
        </Section>
        <Section title="Integrations" steps={["integrations"]} outcome={outcome}>
          <IntegrationFields providers={controls} values={form.draft.integrations} initial={form.initial.integrations} disabled={busy} onChange={(key, value) => edit(() => form.setSetting(key, value))} onToggle={(provider, on) => edit(() => form.setSettings(toggleValues(provider, on)))} />
        </Section>
        <Section title="Danger zone" steps={[]} outcome={null}>
          <DangerZone project={project} onRemove={() => onRemove(project)} />
        </Section>
      </div>
      {choosing && <AddProjectDialog mode={{ kind: "choose", onPick: (path) => edit(() => form.set("path", path)) }} orgs={orgs} onClose={() => setChoosing(false)} />}
    </SideDrawer>
  );
}
