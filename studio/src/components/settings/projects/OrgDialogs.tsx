import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { errorText } from "../../../lib/actions";
import { KEY_MAX, normalizeKeyInput, setDefaultExplainer } from "../../../lib/projects";
import { showToast } from "../../../lib/toast";
import type { OrgRow } from "../../../lib/types";
import { createOrg, patchOrg, useRefreshProjects, useSuggestKey } from "../../../lib/useProjectsSettings";
import { Button } from "../../ui";
import { Field, INPUT_CLASS, Note } from "../bits";
import { SettingsDialog } from "../SettingsDialog";

export type OrgDialog = { kind: "new" } | { kind: "rename"; org: OrgRow } | { kind: "key"; org: OrgRow } | { kind: "default"; org: OrgRow } | { kind: "remove-refused"; org: OrgRow; reason: string };

interface OrgDialogsProps {
  dialog: OrgDialog;
  orgs: OrgRow[];
  onClose: () => void;
}

interface OrgFormProps {
  title: string;
  submitLabel: string;
  ready: boolean;
  run: () => Promise<unknown>;
  successText: string;
  onClose: () => void;
  children: ReactNode;
}

const PHONE_BUTTON = "max-sm:min-h-[46px] max-sm:w-full";

// A small org dialog: its fields, one write, the toast of its success and the inline note of its refusal.
function OrgForm({ title, submitLabel, ready, run, successText, onClose, children }: OrgFormProps) {
  const refresh = useRefreshProjects();
  const write = useMutation({
    mutationFn: run,
    onSuccess: () => {
      showToast(successText, "success");
      onClose();
    },
    onSettled: refresh,
  });
  const submit = () => {
    if (ready && !write.isPending) write.mutate();
  };
  const footer = (
    <>
      <Button type="submit" variant="primary" className={PHONE_BUTTON} disabled={!ready || write.isPending}>
        {write.isPending ? "Saving…" : submitLabel}
      </Button>
      <Button variant="ghost" className={PHONE_BUTTON} onClick={onClose}>
        Cancel
      </Button>
    </>
  );
  return (
    <SettingsDialog title={title} label={title} width="narrow" phone="sheet" onClose={onClose} onSubmit={submit} footer={footer}>
      {children}
      {write.isError && (
        <Note tone="err" icon="⚠" role="alert">
          {`${errorText(write.error)} Nothing was saved.`}
        </Note>
      )}
    </SettingsDialog>
  );
}

// The New org dialog: a name and the key suggested live from it.
function NewOrgDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const suggestion = useSuggestKey("org", name);
  const effectiveKey = key ?? suggestion.data?.key ?? "";
  return (
    <OrgForm title="New org" submitLabel="Create org" ready={name.trim() !== ""} run={() => createOrg(name.trim(), effectiveKey)} successText={`Created org ${name.trim()}`} onClose={onClose}>
      <Field label="Name">
        <input className={`${INPUT_CLASS} font-mono`} value={name} autoFocus spellCheck={false} placeholder="e.g. acme" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Key" hint="suggested from the name">
        <input className={`${INPUT_CLASS} font-mono uppercase`} value={effectiveKey} maxLength={KEY_MAX} spellCheck={false} onChange={(event) => setKey(normalizeKeyInput(event.target.value))} />
      </Field>
    </OrgForm>
  );
}

// The Rename org dialog: one row, so its projects and bindings follow.
function RenameOrgDialog({ org, onClose }: { org: OrgRow; onClose: () => void }) {
  const [name, setName] = useState(org.name);
  const ready = name.trim() !== "" && name.trim() !== org.name;
  return (
    <OrgForm title={`Rename ${org.name}`} submitLabel="Rename" ready={ready} run={() => patchOrg(org.id, { name: name.trim() })} successText={`Renamed ${org.name} to ${name.trim()}`} onClose={onClose}>
      <Field label="New name">
        <input className={`${INPUT_CLASS} font-mono`} value={name} autoFocus spellCheck={false} onChange={(event) => setName(event.target.value)} />
      </Field>
      <div className="text-sm text-dim">Its projects and connection bindings follow the new name.</div>
    </OrgForm>
  );
}

// The Change key dialog: the old key keeps resolving.
function ChangeKeyDialog({ org, onClose }: { org: OrgRow; onClose: () => void }) {
  const [key, setKey] = useState(org.key);
  const ready = key.length >= 2 && key !== org.key;
  return (
    <OrgForm title={`Change the key of ${org.name}`} submitLabel="Change key" ready={ready} run={() => patchOrg(org.id, { key })} successText={`${org.name} now has key ${key}; ${org.key} refs still resolve`} onClose={onClose}>
      <Field label="New key" hint="2 to 5 letters or digits">
        <input className={`${INPUT_CLASS} font-mono uppercase`} value={key} maxLength={KEY_MAX} autoFocus spellCheck={false} onChange={(event) => setKey(normalizeKeyInput(event.target.value))} />
      </Field>
      <div className="text-sm text-dim">{`${org.key} keeps resolving to ${org.name} after the change.`}</div>
    </OrgForm>
  );
}

// The Set as default dialog, naming the current default and what the default org is for.
function SetDefaultDialog({ org, orgs, onClose }: { org: OrgRow; orgs: OrgRow[]; onClose: () => void }) {
  const current = orgs.find((entry) => entry.isDefault)?.name ?? null;
  return (
    <OrgForm title={`Make ${org.name} the default org?`} submitLabel="Set as default" ready run={() => patchOrg(org.id, { isDefault: true })} successText={`${org.name} is now the default org`} onClose={onClose}>
      <div className="text-[13px] text-[#d6dae3]">{setDefaultExplainer(org.name, current)}</div>
      <div className="text-sm text-dim">
        Same as <span className="font-mono">nightqueue org default {org.name}</span>.
      </div>
    </OrgForm>
  );
}

// The answer to a remove the runtime refused: the reason, and nothing removed.
function RemoveRefusedDialog({ org, reason, onClose }: { org: OrgRow; reason: string; onClose: () => void }) {
  const footer = (
    <Button className={PHONE_BUTTON} onClick={onClose}>
      Close
    </Button>
  );
  return (
    <SettingsDialog title={`Can't remove ${org.name}`} label={`Can't remove ${org.name}`} width="narrow" phone="sheet" alert onClose={onClose} footer={footer}>
      <Note tone="err" icon="⚠" role="alert">
        {`${reason} Nothing was removed.`}
      </Note>
    </SettingsDialog>
  );
}

// The open org dialog: new, rename, change key, set as default, or a refused remove.
export function OrgDialogs({ dialog, orgs, onClose }: OrgDialogsProps) {
  if (dialog.kind === "new") return <NewOrgDialog onClose={onClose} />;
  if (dialog.kind === "rename") return <RenameOrgDialog org={dialog.org} onClose={onClose} />;
  if (dialog.kind === "key") return <ChangeKeyDialog org={dialog.org} onClose={onClose} />;
  if (dialog.kind === "default") return <SetDefaultDialog org={dialog.org} orgs={orgs} onClose={onClose} />;
  return <RemoveRefusedDialog org={dialog.org} reason={dialog.reason} onClose={onClose} />;
}
