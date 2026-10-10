import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { addConnectionErrorView, type ConnectionErrorView } from "../../lib/integrations";
import type { ModuleAddForm, ModuleCard, ModuleField, OrgSummary } from "../../lib/types";
import { addConnectionOf, useRefreshIntegrations } from "../../lib/useIntegrations";
import { Button } from "../ui";
import { AddError, Field, INPUT_CLASS, Note, orgOption } from "./bits";
import { SettingsDialog } from "./SettingsDialog";

interface AddConnectionDialogProps {
  module: ModuleCard;
  form: ModuleAddForm;
  orgs: OrgSummary[];
  onClose: () => void;
}

interface AddValues {
  name: string;
  org: string;
  secret: string;
  extra: Record<string, string>;
}

const PHONE_BUTTON = "max-sm:min-h-[46px] max-sm:w-full";

// The body an add posts: the name and org when the form asks for them, the secret under its field, and the filled extra fields.
function addBody(form: ModuleAddForm, values: AddValues): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(values.extra).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value !== ""));
  return {
    ...(form.nameRequired ? { name: values.name.trim() } : {}),
    ...(form.orgRequired ? { org: values.org } : {}),
    [form.secretField ?? "secret"]: values.secret.trim(),
    extra,
  };
}

// Tells whether every required value of the form is filled.
function isReady(form: ModuleAddForm, values: AddValues): boolean {
  if (form.nameRequired && !values.name.trim()) return false;
  if (form.orgRequired && !values.org) return false;
  if (!values.secret.trim()) return false;
  return form.fields.every((field) => !field.required || (values.extra[field.name] ?? "").trim() !== "");
}

// One extra field input of the form, its format as hint and its default as placeholder.
function ExtraField({ label, field, value, disabled, onChange }: { label: string; field: ModuleField; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <Field label={field.required ? `${label} ${field.name}` : `${label} ${field.name} (optional)`} hint={field.format ?? undefined}>
      <input className={`${INPUT_CLASS} font-mono`} value={value} placeholder={field.default ?? ""} required={field.required} disabled={disabled} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

// The org select of the form.
function OrgSelect({ orgs, value, disabled, invalid, onChange }: { orgs: OrgSummary[]; value: string; disabled: boolean; invalid: boolean; onChange: (value: string) => void }) {
  return (
    <Field label="Org">
      <select className={INPUT_CLASS} value={value} disabled={disabled || !orgs.length} aria-invalid={invalid} onChange={(event) => onChange(event.target.value)}>
        {orgs.map((entry) => (
          <option key={entry.id} value={entry.name}>
            {orgOption(entry)}
          </option>
        ))}
      </select>
    </Field>
  );
}

// The add dialog of a stored module, built from the form its provider declares; the secret is never kept once saved or closed.
export function AddConnectionDialog({ module, form, orgs, onClose }: AddConnectionDialogProps) {
  const refresh = useRefreshIntegrations();
  const [values, setValues] = useState<AddValues>({ name: "", org: orgs[0]?.name ?? "", secret: "", extra: {} });
  const [error, setError] = useState<ConnectionErrorView | null>(null);
  const add = useMutation({
    mutationFn: () => addConnectionOf(module.kind, addBody(form, values)),
    onSuccess: () => {
      setValues((current) => ({ ...current, secret: "" }));
      refresh();
    },
    onError: (err) => setError(addConnectionErrorView(err, module)),
  });
  const saved = add.isSuccess;
  const locked = add.isPending || saved;
  const ready = isReady(form, values);
  const edit = (patch: Partial<AddValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const submit = () => {
    if (!ready || locked) return;
    setError(null);
    add.mutate();
  };
  const close = () => {
    setValues((current) => ({ ...current, secret: "" }));
    onClose();
  };
  const title = `Add ${module.label}`;
  const footer = saved ? (
    <Button variant="primary" className={PHONE_BUTTON} onClick={close}>
      Done
    </Button>
  ) : (
    <>
      <Button type="submit" variant="primary" className={PHONE_BUTTON} disabled={!ready || add.isPending}>
        {add.isPending ? "Testing…" : error ? "Test again and save" : "Test and save"}
      </Button>
      <Button variant="ghost" className={PHONE_BUTTON} onClick={close}>
        Cancel
      </Button>
      <span className="ml-auto text-xs text-dim max-sm:hidden">Enter submits · Esc closes</span>
    </>
  );
  return (
    <SettingsDialog title={title} label={title} width="medium" phone="sheet" onClose={close} onSubmit={submit} footer={footer}>
      <Note tone="info" icon="ⓘ">
        <span className="text-[12.5px]">{`The ${form.secretLabel} is tested against ${module.label} before it is saved and `}<strong>is never shown again</strong>.</span>
      </Note>
      {form.orgRequired && !orgs.length && (
        <Note tone="warn" icon="⚠">
          No org is registered in this home yet. Register a project first, then add the connection for its org.
        </Note>
      )}
      {form.nameRequired && (
        <Field label="Connection name" hint="as it appears in the list">
          <input className={`${INPUT_CLASS} font-mono`} value={values.name} required disabled={locked} aria-invalid={error?.field === "name"} autoFocus spellCheck={false} onChange={(event) => edit({ name: event.target.value })} />
        </Field>
      )}
      {form.orgRequired && <OrgSelect orgs={orgs} value={values.org} disabled={locked} invalid={error?.field === "org"} onChange={(org) => edit({ org })} />}
      <Field label={form.secretLabel}>
        <input className={`${INPUT_CLASS} font-mono`} type="password" autoComplete="off" spellCheck={false} value={values.secret} placeholder={saved ? `${form.secretLabel} saved — not shown` : ""} required={!saved} disabled={locked} aria-invalid={error?.field === "secret"} onChange={(event) => edit({ secret: event.target.value })} />
      </Field>
      {form.fields.map((field) => (
        <ExtraField key={field.name} label={module.label} field={field} value={values.extra[field.name] ?? ""} disabled={locked} onChange={(value) => edit({ extra: { ...values.extra, [field.name]: value } })} />
      ))}
      {error && <AddError error={error} />}
      {saved && (
        <Note tone="ok" icon={<span className="text-accent">✓</span>}>
          <div className="font-semibold text-accent">{`${module.label} accepted the ${form.secretLabel} · connection saved`}</div>
        </Note>
      )}
    </SettingsDialog>
  );
}
