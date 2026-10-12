import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { canAddConnection, connectionsOfKind, moduleState, placeLabel } from "../../lib/integrations";
import type { ConnectionRow as Row, IntegrationsView, ModuleCard as Module } from "../../lib/types";
import { useAmbientStatus } from "../../lib/useIntegrations";
import { Button } from "../ui";
import { AmbientBody } from "./AmbientBody";
import { ConnectionRow, type ConnectionHandlers } from "./ConnectionRow";
import { DestinationsSection } from "./DestinationsSection";
import { ProviderIcon } from "./ProviderIcon";

interface ModuleCardProps {
  module: Module;
  view: IntegrationsView;
  handlers: ConnectionHandlers;
  onAdd: (kind: string) => void;
}

// Tells whether a module is connected: it has a stored connection, or the machine is logged in.
function useConnected(module: Module, view: IntegrationsView): boolean {
  const status = useAmbientStatus(module);
  if (module.add) return connectionsOfKind(view, module.kind).length > 0;
  return status.data?.authenticated === true;
}

// The collapsed row of a module: icon, name with its one-line description, and the Manage or Connect toggle.
function ModuleRowHeader({ module, connected, open, onToggle }: { module: Module; connected: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 max-lg:px-3.5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-header text-fg">
        <ProviderIcon icon={module.icon} />
      </span>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <h3 className="m-0 text-[15px] font-semibold text-fg">{module.label}</h3>
        {module.description && <div className="truncate text-sm text-muted max-sm:whitespace-normal">{module.description}</div>}
      </div>
      <Button size="sm" variant={connected ? "ghost" : "primary"} aria-expanded={open} onClick={onToggle} className="shrink-0 gap-1.5 max-lg:min-h-10">
        {connected ? "Manage ✓" : "Connect"}
        <ChevronDown size={14} aria-hidden="true" className={open ? "rotate-180" : ""} />
      </Button>
    </div>
  );
}

// The stored connections of a module, or a note that it has none.
function StoredBody({ rows, view, handlers }: { rows: readonly Row[]; view: IntegrationsView; handlers: ConnectionHandlers }) {
  if (!rows.length) return <p className="m-0 px-4 py-3.5 text-[13px] text-muted">Not connected.</p>;
  return (
    <>
      {rows.map((row) => (
        <ConnectionRow key={row.id} row={row} view={view} handlers={handlers} />
      ))}
    </>
  );
}

// The line above the body of a stored module: where it lives, its state, and the add button.
function StoredToolbar({ module, view, onAdd }: { module: Module; view: IntegrationsView; onAdd: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 max-lg:px-3.5">
      <span className="text-sm text-dim">{placeLabel(module.place)}</span>
      <span className="text-sm text-muted">· {moduleState(module, view)}</span>
      {canAddConnection(module, view) && (
        <Button size="sm" variant="primary" onClick={onAdd} className="ml-auto gap-1.5 max-lg:min-h-10">
          <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
          Add
        </Button>
      )}
    </div>
  );
}

// The expanded body of a module: its machine login or stored connections, then its destinations when it declares them.
function ModuleBody({ module, view, handlers, onAdd }: ModuleCardProps) {
  const stored = module.add !== null;
  const rows = connectionsOfKind(view, module.kind);
  return (
    <div className="flex flex-col">
      {stored && <StoredToolbar module={module} view={view} onAdd={() => onAdd(module.kind)} />}
      {module.ambient && !stored ? <AmbientBody module={module} /> : <StoredBody rows={rows} view={view} handlers={handlers} />}
      {module.destinations && <DestinationsSection view={view} locked={rows.length === 0} />}
    </div>
  );
}

// One Conductor-style Settings row per provider of the registry: collapsed to a Manage or Connect toggle, expanded inline.
export function ModuleCard(props: ModuleCardProps) {
  const { module, view } = props;
  const [open, setOpen] = useState(false);
  const connected = useConnected(module, view);
  return (
    <section aria-label={`${module.label} module`} className="flex flex-col rounded-lg border border-line bg-surface">
      <ModuleRowHeader module={module} connected={connected} open={open} onToggle={() => setOpen((value) => !value)} />
      {open && <ModuleBody {...props} />}
    </section>
  );
}
