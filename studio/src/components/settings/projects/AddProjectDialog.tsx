import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../../lib/api";
import { normalizeKeyInput, registerErrorText, KEY_MAX } from "../../../lib/projects";
import { showToast } from "../../../lib/toast";
import type { OrgRow, RepoFacts, SettingsProject } from "../../../lib/types";
import { patchProject, registerProject, useRefreshProjects, useRepoFacts, useSuggestKey } from "../../../lib/useProjectsSettings";
import { Button, Segmented } from "../../ui";
import { Bar, Field, INPUT_CLASS, Note } from "../bits";
import { SettingsDialog } from "../SettingsDialog";
import { FolderBrowser } from "./FolderBrowser";

export type AddMode = { kind: "register" } | { kind: "repick"; project: SettingsProject } | { kind: "choose"; onPick: (path: string) => void };

interface AddProjectDialogProps {
  mode: AddMode;
  orgs: OrgRow[];
  onClose: () => void;
}

type Tab = "browse" | "paste";

interface RegisterFields {
  name: string;
  key: string;
  org: string;
}

interface Refusal {
  text: string;
  holder: { id: string; name: string } | null;
}

const TABS = [
  { value: "browse", label: "Browse this computer" },
  { value: "paste", label: "Paste a path" },
] as const;

const PHONE_BUTTON = "max-sm:min-h-[46px] max-sm:w-full";

// The refusal a failed write shows inline, with the path-less project that holds the name when there is one.
function refusalOf(err: unknown): Refusal {
  const body = err instanceof ApiError ? err.body : null;
  const code = codeOf(err);
  const project = body?.project as { id?: unknown; name?: unknown; path?: unknown } | undefined;
  const pathless = code === "name-taken" && project && project.path === null && typeof project.id === "string" && typeof project.name === "string";
  return { text: registerErrorText(code, body ?? { error: err instanceof Error ? err.message : null }), holder: pathless ? { id: project.id as string, name: project.name as string } : null };
}

// The API code of a failed call, or null.
function codeOf(err: unknown): string | null {
  return err instanceof ApiError && typeof err.body?.code === "string" ? err.body.code : null;
}

// Tells whether the chosen folder can be written: a repository not registered yet, or a path outside the home the browser cannot preview.
function folderReady(query: ReturnType<typeof useRepoFacts>): boolean {
  if (query.isSuccess) return !query.data.registeredAs;
  return query.isError && codeOf(query.error) === "outside-home";
}

// The note under the folder choice: the folder the runtime would register, its origin and branch, or why it cannot.
function SelectionNote({ query, target }: { query: ReturnType<typeof useRepoFacts>; target: string }) {
  if (!target) return <div className="text-sm text-dim">Choose a git repository to register.</div>;
  if (query.isPending) return <Bar className="h-[52px] w-full" />;
  if (query.isError && codeOf(query.error) === "outside-home") return <Note tone="warn" icon="ⓘ">This folder is outside your home, so it cannot be previewed; the runtime still checks it when you register it.</Note>;
  if (query.isError) return <Note tone="err" icon="⚠">{refusalOf(query.error).text}</Note>;
  const facts = query.data;
  if (facts.registeredAs) return <Note tone="warn" icon="⚠">{`This folder is already registered as ${facts.registeredAs.name}.`}</Note>;
  return (
    <Note tone="info" icon="ⓘ">
      <div className="font-mono break-all">{facts.mainCheckout}</div>
      <div className="text-sm">
        origin <span className="font-mono">{facts.origin ?? "none"}</span> · branch <span className="font-mono">{facts.branch ?? "unknown"}</span>
      </div>
      {facts.worktreeOf && <div className="text-sm">{`A linked worktree: its main checkout is registered instead${facts.worktreeOf.project ? ` (${facts.worktreeOf.project})` : ""}.`}</div>}
    </Note>
  );
}

// The name, key and org of a registration, following the runtime's suggestions until the operator types over them.
function useRegisterFields(facts: RepoFacts | undefined, orgs: OrgRow[]) {
  const [name, setName] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [org, setOrg] = useState(() => orgs.find((entry) => entry.isDefault)?.name ?? orgs[0]?.name ?? "");
  const effectiveName = name ?? facts?.suggested.name ?? "";
  const suggestion = useSuggestKey("project", effectiveName);
  const fields: RegisterFields = { name: effectiveName, key: key ?? suggestion.data?.key ?? facts?.suggested.key ?? "", org };
  return { fields, setName, setKey: (value: string) => setKey(normalizeKeyInput(value)), setOrg };
}

// The name, key and org inputs of a registration, the default org first.
function RegisterInputs({ form, orgs, disabled }: { form: ReturnType<typeof useRegisterFields>; orgs: OrgRow[]; disabled: boolean }) {
  const ordered = [...orgs.filter((org) => org.isDefault), ...orgs.filter((org) => !org.isDefault)];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1">
      <Field label="Name">
        <input className={`${INPUT_CLASS} font-mono`} value={form.fields.name} disabled={disabled} spellCheck={false} onChange={(event) => form.setName(event.target.value)} />
      </Field>
      <Field label="Key">
        <input className={`${INPUT_CLASS} font-mono uppercase`} value={form.fields.key} maxLength={KEY_MAX} disabled={disabled} spellCheck={false} onChange={(event) => form.setKey(event.target.value)} />
      </Field>
      <Field label="Org">
        <select className={INPUT_CLASS} value={form.fields.org} disabled={disabled} onChange={(event) => form.setOrg(event.target.value)}>
          {ordered.map((org) => (
            <option key={org.id} value={org.name}>
              {org.isDefault ? `${org.name} (default)` : org.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

// Runs the write of the dialog's mode: register, give a project its folder again, or hand the folder back to the caller.
async function writeFor(mode: AddMode, target: string, fields: RegisterFields): Promise<string> {
  if (mode.kind === "choose") {
    mode.onPick(target);
    return "";
  }
  if (mode.kind === "repick") {
    const answer = await patchProject(mode.project.id, { path: target });
    return `${mode.project.name} now checks out ${answer.project?.path ?? target}`;
  }
  const answer = await registerProject({ path: target, name: fields.name.trim() || undefined, key: fields.key || undefined, org: fields.org || undefined });
  const from = answer.registeredFrom ? " from its main checkout" : "";
  return `Registered ${answer.project?.name ?? fields.name}${from} with key ${answer.project?.key ?? "?"}`;
}

// The red note of a refused write, offering to give a path-less project this folder when it holds the name.
function RefusalNote({ refusal, onAdopt, adopting }: { refusal: Refusal; onAdopt: () => void; adopting: boolean }) {
  return (
    <Note tone="err" icon="⚠" role="alert">
      <div>{refusal.text}</div>
      {refusal.holder && (
        <button type="button" disabled={adopting} className="self-start text-link hover:underline" onClick={onAdopt}>
          {`Give ${refusal.holder.name} this folder instead`}
        </button>
      )}
    </Note>
  );
}

// The Add project dialog: browse the home or paste a path, then register it, give a project its folder again, or pick one.
export function AddProjectDialog({ mode, orgs, onClose }: AddProjectDialogProps) {
  const refresh = useRefreshProjects();
  const [tab, setTab] = useState<Tab>("browse");
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState("");
  const [pasted, setPasted] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const target = tab === "browse" ? selected : pasted.trim();
  const facts = useRepoFacts(target);
  const form = useRegisterFields(facts.data, orgs);
  const write = useMutation({
    mutationFn: () => writeFor(mode, facts.data?.mainCheckout ?? target, form.fields),
    onSuccess: (message) => {
      if (message) showToast(message, "success");
      if (mode.kind !== "choose") refresh();
      onClose();
    },
    onError: (err) => setRefusal(refusalOf(err)),
  });
  const adopt = useMutation({
    mutationFn: (holder: { id: string; name: string }) => patchProject(holder.id, { path: facts.data?.mainCheckout ?? target }),
    onSuccess: (_answer, holder) => {
      showToast(`${holder.name} has its checkout again`, "success");
      refresh();
      onClose();
    },
    onError: (err) => setRefusal(refusalOf(err)),
  });
  const choose =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setRefusal(null);
    };
  const ready = target !== "" && folderReady(facts) && (mode.kind !== "register" || form.fields.name.trim() !== "");
  const submit = () => {
    if (ready && !write.isPending) write.mutate();
  };
  const title = mode.kind === "register" ? "Add project" : mode.kind === "repick" ? `Pick the folder of ${mode.project.name}` : "Change folder";
  const primary = mode.kind === "register" ? "Register project" : "Use this folder";
  const footer = (
    <>
      <Button type="submit" variant="primary" className={PHONE_BUTTON} disabled={!ready || write.isPending}>
        {write.isPending ? "Working…" : primary}
      </Button>
      <Button variant="ghost" className={PHONE_BUTTON} onClick={onClose}>
        Cancel
      </Button>
    </>
  );
  return (
    <SettingsDialog title={title} label={title} width="xwide" phone="full" onClose={onClose} onSubmit={submit} footer={footer}>
      <Segmented label="how to choose the folder" options={TABS} value={tab} onChange={choose<Tab>(setTab)} />
      {tab === "browse" ? (
        <FolderBrowser dir={dir} selected={selected} onEnter={choose(setDir)} onSelect={choose(setSelected)} />
      ) : (
        <Field label="Folder" hint="absolute, or starting with ~/">
          <input className={`${INPUT_CLASS} font-mono`} value={pasted} placeholder="~/code/api" autoFocus spellCheck={false} onChange={(event) => choose(setPasted)(event.target.value)} />
        </Field>
      )}
      <SelectionNote query={facts} target={target} />
      {mode.kind === "register" && <RegisterInputs form={form} orgs={orgs} disabled={write.isPending} />}
      {refusal && <RefusalNote refusal={refusal} adopting={adopt.isPending} onAdopt={() => refusal.holder && adopt.mutate(refusal.holder)} />}
    </SettingsDialog>
  );
}
