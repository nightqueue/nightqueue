import { useCallback, useState } from "react";
import { AddConnectionDialog } from "../components/settings/AddConnectionDialog";
import { AddWebhookDialog } from "../components/settings/AddWebhookDialog";
import type { ConnectionHandlers } from "../components/settings/ConnectionRow";
import { DestinationsCard } from "../components/settings/DestinationsCard";
import { LinkProjectsDialog } from "../components/settings/LinkProjectsDialog";
import { ModuleCard } from "../components/settings/ModuleCard";
import { RemoveConnectionDialog, type RemoveTarget } from "../components/settings/RemoveConnectionDialog";
import { SettingsError } from "../components/settings/SettingsError";
import { SettingsSections } from "../components/settings/SettingsSections";
import { SettingsSkeleton } from "../components/settings/SettingsSkeleton";
import { DISCORD, discordConnections, joinLabels, projectsUsingInOrg } from "../lib/integrations";
import { showToast } from "../lib/toast";
import type { ConnectionRow, IntegrationsView } from "../lib/types";
import { useAction } from "../lib/useAction";
import { allowOrg, removeOrg, useIntegrations, useRefreshIntegrations } from "../lib/useIntegrations";

type Dialog = { kind: "add"; module: string } | { kind: "link"; connection: string } | { kind: "remove"; target: RemoveTarget } | null;

interface OrgEdit {
  name: string;
  org: string;
}

// The in-flight key of an org edit.
function orgEditKey(edit: OrgEdit): string {
  return `${edit.name}\u0000${edit.org}`;
}

// The explainer under the title, naming the modules of the registry.
function explainer(view: IntegrationsView): string {
  const names = joinLabels(view.modules);
  return `${names ? `Connections to ${names}. ` : ""}A connection's secret is never shown again once saved.`;
}

// The section header: title and a one-line state.
function IntegrationsHeader({ note, noteTone }: { note: string; noteTone: "muted" | "red" }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-[20px] font-semibold">Integrations</h1>
      <div className={`text-[13px] ${noteTone === "red" ? "text-red" : "text-muted"}`}>{note}</div>
    </div>
  );
}

// The connection handlers of the page: dialogs for link and remove, immediate org edits when no project depends on them.
function useConnectionHandlers(view: IntegrationsView | undefined, open: (dialog: Dialog) => void): ConnectionHandlers {
  const refresh = useRefreshIntegrations();
  const allow = useAction(async ({ name, org }: OrgEdit) => {
    try {
      await allowOrg(name, org);
      showToast(`${name} allowed for ${org}`, "success");
    } finally {
      refresh();
    }
  }, orgEditKey);
  const takeAway = useAction(async ({ name, org }: OrgEdit) => {
    try {
      await removeOrg(name, org, false);
      showToast(`${name} removed from org ${org}`, "success");
    } finally {
      refresh();
    }
  }, orgEditKey);
  return {
    onLink: (row: ConnectionRow) => open({ kind: "link", connection: row.name }),
    onRemove: (row: ConnectionRow) => open({ kind: "remove", target: { connection: row, org: null } }),
    onAllowOrg: (row: ConnectionRow, org: string) => allow({ name: row.name, org }),
    onRemoveOrg: (row: ConnectionRow, org: string) => {
      const inUse = view ? projectsUsingInOrg(view, row.name, org).length > 0 : true;
      if (inUse) open({ kind: "remove", target: { connection: row, org } });
      else takeAway({ name: row.name, org });
    },
  };
}

// The other Discord connection a remove can offer to switch to, as an opener of the link dialog.
function switchOpener(view: IntegrationsView, target: RemoveTarget, open: (dialog: Dialog) => void): (() => void) | null {
  const other = discordConnections(view).find((row) => row.present && row.name !== target.connection.name);
  return other ? () => open({ kind: "link", connection: other.name }) : null;
}

// The add dialog of a module: Discord keeps its own webhook dialog, every other stored module gets the generic form.
function AddDialog({ kind, view, open }: { kind: string; view: IntegrationsView; open: (dialog: Dialog) => void }) {
  const close = () => open(null);
  if (kind === DISCORD) return <AddWebhookDialog orgs={view.orgs} onClose={close} onLink={(connection) => open({ kind: "link", connection })} />;
  const module = view.modules.find((entry) => entry.kind === kind);
  if (!module?.add) return null;
  return <AddConnectionDialog module={module} form={module.add} orgs={view.orgs} onClose={close} />;
}

// The open dialog of the page, if any.
function PageDialog({ dialog, view, open }: { dialog: Dialog; view: IntegrationsView; open: (dialog: Dialog) => void }) {
  const close = () => open(null);
  if (dialog?.kind === "add") return <AddDialog kind={dialog.module} view={view} open={open} />;
  if (dialog?.kind === "link") return <LinkProjectsDialog key={dialog.connection} view={view} initial={dialog.connection} onClose={close} />;
  if (dialog?.kind === "remove") return <RemoveConnectionDialog view={view} target={dialog.target} onClose={close} onSwitch={switchOpener(view, dialog.target, open)} />;
  return null;
}

// The body of the Integrations section for the current state of the view: loading, error, or one card per module and the destinations.
function IntegrationsBody({ query, handlers, onAdd }: { query: ReturnType<typeof useIntegrations>; handlers: ConnectionHandlers; onAdd: (kind: string) => void }) {
  if (query.isPending) return <SettingsSkeleton />;
  if (query.isError) return <SettingsError error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />;
  return (
    <>
      {query.data.modules.map((module) => (
        <ModuleCard key={module.kind} module={module} view={query.data} handlers={handlers} onAdd={onAdd} />
      ))}
      <DestinationsCard view={query.data} />
    </>
  );
}

// The header note of the section for the current state of the view.
function headerNote(query: ReturnType<typeof useIntegrations>): { note: string; noteTone: "muted" | "red" } {
  if (query.isPending) return { note: "Reading connections and project destinations…", noteTone: "muted" };
  if (query.isError) return { note: "runtime unreachable · retrying in 8 s", noteTone: "red" };
  return { note: explainer(query.data), noteTone: "muted" };
}

// Settings › Integrations: a card per module of the registry, the log destination of every project, and their dialogs.
export function SettingsPage() {
  const query = useIntegrations();
  const [dialog, setDialog] = useState<Dialog>(null);
  const open = useCallback((next: Dialog) => setDialog(next), []);
  const handlers = useConnectionHandlers(query.data, open);
  const onAdd = (kind: string) => open({ kind: "add", module: kind });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)] max-lg:gap-3">
      <SettingsSections />
      <section id="integrations" aria-label="integrations" className="flex min-w-0 flex-col gap-3.5">
        <IntegrationsHeader {...headerNote(query)} />
        <IntegrationsBody query={query} handlers={handlers} onAdd={onAdd} />
      </section>
      {query.data && <PageDialog dialog={dialog} view={query.data} open={open} />}
    </div>
  );
}
