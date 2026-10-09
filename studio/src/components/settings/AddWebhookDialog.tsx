import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { addErrorView, shortId, type AddErrorView } from "../../lib/integrations";
import type { ConnectionRow, OrgSummary } from "../../lib/types";
import { addWebhook, useRefreshIntegrations } from "../../lib/useIntegrations";
import { Button } from "../ui";
import { INPUT_CLASS, Note } from "./bits";
import { SettingsDialog } from "./SettingsDialog";

interface AddWebhookDialogProps {
  orgs: OrgSummary[];
  onClose: () => void;
  onLink: (connection: string) => void;
}

const URL_PLACEHOLDER = "https://discord.com/api/webhooks/…";
const SAVED_PLACEHOLDER = "URL saved — not shown, not even masked";
const PHONE_BUTTON = "max-sm:min-h-[46px] max-sm:w-full";

// A labelled field of the dialog, with an optional dim hint beside the label.
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex justify-between gap-2 text-sm text-muted">
        {label}
        {hint && <span className="text-dim max-sm:hidden">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

// The org select option text, as `dlw · 7 projects`.
function orgOption(org: OrgSummary): string {
  return `${org.name} · ${org.projects} ${org.projects === 1 ? "project" : "projects"}`;
}

// The red note of a failed add; it always says nothing was saved.
function AddError({ error }: { error: AddErrorView }) {
  return (
    <Note tone="err" icon="⚠" role="alert">
      <div className="font-semibold text-red">{error.title}</div>
      <div>{error.body}</div>
      <div className="text-sm text-[#c98f8a]">Nothing was saved. Fix it and test again.</div>
    </Note>
  );
}

// The green note of a saved connection: what the webhook told about its channel, and the next step.
function AddSuccess({ connection, org }: { connection: ConnectionRow | null; org: string }) {
  const webhook = connection?.webhookName ? (
    <>
      Webhook <span className="font-mono">{connection.webhookName}</span> in channel{" "}
    </>
  ) : (
    "Channel "
  );
  return (
    <Note tone="ok" icon={<span className="text-accent">✓</span>}>
      <div className="font-semibold text-accent">Webhook valid · connection saved</div>
      <div>
        {webhook}
        <span className="font-mono" title={connection?.channelId ?? undefined}>
          {shortId(connection?.channelId)}
        </span>{" "}
        · server{" "}
        <span className="font-mono" title={connection?.serverId ?? undefined}>
          {shortId(connection?.serverId)}
        </span>
        . A “nightqueue connected” message was posted there.
      </div>
      <div className="text-sm text-[#8fbf9f]">Tip: name the webhook after its channel in Discord, so the list reads which channel each connection posts to.</div>
      <div className="text-sm text-[#8fbf9f]">{`Next: choose which projects of org ${org} notify this channel when a job closes.`}</div>
    </Note>
  );
}

// The Add Discord webhook dialog: one Test and save, errors kept inside, and the URL never kept once saved or closed.
export function AddWebhookDialog({ orgs, onClose, onLink }: AddWebhookDialogProps) {
  const refresh = useRefreshIntegrations();
  const [name, setName] = useState("");
  const [org, setOrg] = useState(orgs[0]?.name ?? "");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<AddErrorView | null>(null);
  const add = useMutation({
    mutationFn: () => addWebhook({ name: name.trim(), org, url: url.trim() }),
    onSuccess: () => {
      setUrl("");
      refresh();
    },
    onError: (err) => setError(addErrorView(err, name.trim())),
  });
  const saved = add.isSuccess;
  const locked = add.isPending || saved;
  const ready = name.trim() !== "" && url.trim() !== "" && org !== "";
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };
  const submit = () => {
    if (!ready || locked) return;
    setError(null);
    add.mutate();
  };
  const close = () => {
    setUrl("");
    onClose();
  };
  const submitLabel = add.isPending ? "Testing…" : error ? "Test again and save" : "Test and save";
  const footer = saved ? (
    <>
      <Button variant="primary" className={PHONE_BUTTON} onClick={() => onLink(name.trim())}>
        Link projects
      </Button>
      <Button className={PHONE_BUTTON} onClick={close}>
        Done
      </Button>
    </>
  ) : (
    <>
      <Button type="submit" variant="primary" className={PHONE_BUTTON} disabled={!ready || add.isPending}>
        {submitLabel}
      </Button>
      <Button variant="ghost" className={PHONE_BUTTON} onClick={close}>
        Cancel
      </Button>
      <span className="ml-auto text-xs text-dim max-sm:hidden">Enter submits · Esc closes</span>
    </>
  );
  return (
    <SettingsDialog title="Add Discord webhook" label="Add Discord webhook" width="medium" phone="sheet" onClose={close} onSubmit={submit} footer={footer}>
      <Note tone="info" icon="ⓘ">
        <span className="text-[12.5px]">
          A webhook belongs to one channel and can only post. The URL is tested against Discord before it is saved and <strong>is never shown again</strong> — not even masked.
        </span>
      </Note>
      {!orgs.length && (
        <Note tone="warn" icon="⚠">
          No org is registered in this home yet. Register a project first, then add the webhook for its org.
        </Note>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3.5 max-sm:grid-cols-1">
        <Field label="Connection name" hint="as it appears in the list">
          <input className={`${INPUT_CLASS} font-mono`} value={name} placeholder="e.g. dlw-log" required disabled={locked} aria-invalid={error?.field === "name"} autoFocus spellCheck={false} onChange={(event) => edit(setName)(event.target.value)} />
        </Field>
        <Field label="Org">
          <select className={INPUT_CLASS} value={org} disabled={locked || !orgs.length} onChange={(event) => setOrg(event.target.value)}>
            {orgs.map((entry) => (
              <option key={entry.id} value={entry.name}>
                {orgOption(entry)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Webhook URL" hint="Discord › channel › Integrations › Webhooks">
        <input
          className={`${INPUT_CLASS} font-mono`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          placeholder={saved ? SAVED_PLACEHOLDER : URL_PLACEHOLDER}
          required={!saved}
          disabled={locked}
          aria-invalid={error?.field === "url"}
          onChange={(event) => edit(setUrl)(event.target.value)}
        />
        <span className="text-sm text-dim">Only allowed orgs can use this connection. It starts with the org you pick; allow others later, from the list.</span>
      </Field>
      {add.isPending && (
        <Note tone="info" icon={<span className="inline-block size-3.5 animate-spin rounded-full border-2 border-button-line border-t-accent" />}>
          Testing with Discord… posting a verification message to the channel.
        </Note>
      )}
      {error && <AddError error={error} />}
      {saved && <AddSuccess connection={add.data ?? null} org={org} />}
    </SettingsDialog>
  );
}
