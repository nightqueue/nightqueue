import { useState } from "react";
import { filterConnections, typeChips, typeSummary } from "../../lib/integrations";
import type { IntegrationsView } from "../../lib/types";
import { Chip } from "../ui";
import { SettingsCardTitle } from "./bits";
import { ConnectionRow, type ConnectionHandlers } from "./ConnectionRow";

// The Connections card: its count, a filter chip per type, and one row per connection.
export function ConnectionsCard({ view, handlers }: { view: IntegrationsView; handlers: ConnectionHandlers }) {
  const [type, setType] = useState("all");
  const rows = filterConnections(view.connections, type);
  return (
    <section aria-label="connections" className="flex flex-col max-lg:gap-3.5 lg:rounded-lg lg:border lg:border-line lg:bg-surface">
      <div className="flex flex-wrap items-center gap-3 lg:border-b lg:border-line lg:px-4 lg:py-3">
        <SettingsCardTitle>{`Connections · ${view.connections.length}`}</SettingsCardTitle>
        <span className="text-sm text-muted max-lg:hidden">{typeSummary(view.connections)}</span>
        <div className="ml-auto flex gap-1.5 overflow-x-auto" role="group" aria-label="filter by type">
          {typeChips(view.connections).map((chip) => (
            <Chip key={chip.value} on={chip.value === type} onClick={() => setType(chip.value)}>
              {chip.label}
            </Chip>
          ))}
        </div>
      </div>
      {rows.length ? rows.map((row) => <ConnectionRow key={row.id} row={row} view={view} handlers={handlers} />) : <p className="m-0 px-4 py-3.5 text-[13px] text-muted">No connection of this type.</p>}
    </section>
  );
}
