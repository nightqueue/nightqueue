import { useState } from "react";
import { destinationSummary, groupProjectsByOrg, withoutDestination, type OrgGroup } from "../../lib/integrations";
import type { IntegrationsView } from "../../lib/types";
import { Button, Chip } from "../ui";
import { SettingsCardTitle } from "./bits";
import { DesktopDestinationRow, PhoneDestinationRow } from "./DestinationRow";

const PHONE_VISIBLE = 3;

const TH_CLASS = "border-b border-line px-3 py-2 text-left text-xs font-medium tracking-[.3px] text-dim uppercase";

// The destination table on a desktop: one group row per org, then its projects.
function DesktopTable({ view, groups }: { view: IntegrationsView; groups: OrgGroup[] }) {
  return (
    <table className="w-full border-collapse text-[13px] max-lg:hidden">
      <thead>
        <tr>
          <th className={`${TH_CLASS} w-[38%]`}>Project</th>
          <th className={`${TH_CLASS} w-[30%]`}>Destination (Discord connection)</th>
          <th className={TH_CLASS}>Last notice</th>
          <th className={`${TH_CLASS} w-[1%]`} aria-label="actions" />
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <DesktopGroup key={group.org} view={view} group={group} />
        ))}
      </tbody>
    </table>
  );
}

// One org of the desktop table: its group row and its project rows.
function DesktopGroup({ view, group }: { view: IntegrationsView; group: OrgGroup }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-header px-3 py-1.5 text-sm text-muted">
          {group.label}
        </td>
      </tr>
      {group.projects.map((project) => (
        <DesktopDestinationRow key={project.id} project={project} view={view} />
      ))}
    </>
  );
}

// One org of the phone list: collapsed after three projects until asked to show the rest.
function PhoneGroup({ view, group }: { view: IntegrationsView; group: OrgGroup }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.projects.length - PHONE_VISIBLE;
  const shown = expanded || hidden <= 0 ? group.projects : group.projects.slice(0, PHONE_VISIBLE);
  return (
    <>
      <div className="bg-header px-3.5 py-2 text-sm text-muted">{group.label}</div>
      {shown.map((project) => (
        <PhoneDestinationRow key={project.id} project={project} view={view} />
      ))}
      {!expanded && hidden > 0 && (
        <div className="border-t border-[#1b2030] px-3.5 py-2.5">
          <Button variant="ghost" size="sm" className="min-h-10 w-full" onClick={() => setExpanded(true)}>
            {`Show the other ${hidden} in org ${group.org}`}
          </Button>
        </div>
      )}
    </>
  );
}

// The Log destination per project card: the summary, the no-destination filter, and the table grouped by org.
export function DestinationsCard({ view }: { view: IntegrationsView }) {
  const [onlyMissing, setOnlyMissing] = useState(false);
  const missing = withoutDestination(view);
  const projects = onlyMissing ? view.projects.filter((project) => !project.destination) : view.projects;
  const groups = groupProjectsByOrg(view, projects);
  return (
    <section aria-label="log destination per project" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 max-lg:px-3.5">
        <SettingsCardTitle>Log destination per project</SettingsCardTitle>
        <span className="text-sm text-muted">{`event “job closed” · ${destinationSummary(view)}`}</span>
        <div className="ml-auto flex gap-1.5" role="group" aria-label="filter projects">
          <Chip on={!onlyMissing} onClick={() => setOnlyMissing(false)}>
            all orgs
          </Chip>
          <Chip on={onlyMissing} onClick={() => setOnlyMissing(true)}>
            {`no destination · ${missing}`}
          </Chip>
        </div>
      </div>
      {groups.length ? (
        <>
          <DesktopTable view={view} groups={groups} />
          <div className="flex flex-col lg:hidden">
            {groups.map((group) => (
              <PhoneGroup key={group.org} view={view} group={group} />
            ))}
          </div>
        </>
      ) : (
        <p className="m-0 px-4 py-3.5 text-[13px] text-muted">{view.projects.length ? "Every project has a destination." : "No project is registered in this home yet."}</p>
      )}
      <div className="border-t border-[#1b2030] px-4 py-2.5 text-sm text-dim">Changing the destination here applies at once. Picking a connection not allowed for the org is refused, with a shortcut to allow it.</div>
    </section>
  );
}
