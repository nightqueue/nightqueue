import { Plus } from "lucide-react";
import { canAddConnection, connectionsOfKind, moduleState, placeLabel } from "../../lib/integrations";
import type { ConnectionRow as Row, IntegrationsView, ModuleCard as Module } from "../../lib/types";
import { Button } from "../ui";
import { AmbientBody } from "./AmbientBody";
import { SettingsCardTitle } from "./bits";
import { ConnectionRow, type ConnectionHandlers } from "./ConnectionRow";

interface ModuleCardProps {
  module: Module;
  view: IntegrationsView;
  handlers: ConnectionHandlers;
  onAdd: (kind: string) => void;
}

// The header of a module card: its name, where it lives, its state, what it does, and the add button.
function ModuleHeader({ module, state, addable, onAdd }: { module: Module; state: string | null; addable: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-3 lg:border-b lg:border-line lg:px-4 lg:py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsCardTitle>{module.label}</SettingsCardTitle>
          <span className="text-sm text-dim">{placeLabel(module.place)}</span>
          {state && <span className="text-sm text-muted">· {state}</span>}
        </div>
        {module.description && <div className="text-sm text-muted">{module.description}</div>}
      </div>
      {addable && (
        <Button size="sm" variant="primary" onClick={onAdd} className="ml-auto gap-1.5 max-lg:min-h-10">
          <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
          Add
        </Button>
      )}
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

// One Settings card per provider of the registry: its stored connections with an add, or its machine login.
export function ModuleCard({ module, view, handlers, onAdd }: ModuleCardProps) {
  const rows = connectionsOfKind(view, module.kind);
  const stored = module.add !== null;
  return (
    <section aria-label={`${module.label} module`} className="flex flex-col max-lg:gap-3.5 lg:rounded-lg lg:border lg:border-line lg:bg-surface">
      <ModuleHeader module={module} state={stored ? moduleState(module, view) : null} addable={canAddConnection(module, view)} onAdd={() => onAdd(module.kind)} />
      {module.ambient && !stored ? <AmbientBody module={module} /> : <StoredBody rows={rows} view={view} handlers={handlers} />}
    </section>
  );
}
