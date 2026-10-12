import { useState } from "react";
import { collapsed, connectionsLine, plural } from "../../../lib/projects";
import type { OrgRow, ProviderSettings, SettingsProject } from "../../../lib/types";
import { Pill } from "../bits";
import { type OrgAction, OrgActionsMenu } from "./OrgActionsMenu";
import { KeyChip, ProjectRow, type ProjectRowHandlers } from "./ProjectRow";

interface OrgCardProps {
  org: OrgRow;
  projects: SettingsProject[];
  providers: ProviderSettings[];
  failedPosts: Set<string>;
  handlers: ProjectRowHandlers;
  onOrgAction: (action: OrgAction, org: OrgRow) => void;
}

// The header of an org card: name, key, default pill, project count, connections and the actions menu.
function OrgHeader({ org, onOrgAction }: { org: OrgRow; onOrgAction: OrgCardProps["onOrgAction"] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
      <h2 className="m-0 font-mono text-[15px] font-semibold">{org.name}</h2>
      {org.key && <KeyChip value={org.key} />}
      {org.isDefault && <Pill tone="ok">default</Pill>}
      <span className="text-sm text-muted">{plural(org.projects, "project")}</span>
      <a href="#integrations" className="min-w-0 truncate text-sm text-link hover:underline max-sm:order-last max-sm:flex max-sm:min-h-11 max-sm:w-full max-sm:items-center">
        {connectionsLine(org)}
      </a>
      <OrgActionsMenu org={org} onPick={onOrgAction} />
    </div>
  );
}

// One org card: its header and its project rows, collapsed after five.
export function OrgCard({ org, projects, providers, failedPosts, handlers, onOrgAction }: OrgCardProps) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = collapsed(projects, open);
  return (
    <section aria-label={`org ${org.name}`} className="rounded-lg border border-line bg-surface">
      <OrgHeader org={org} onOrgAction={onOrgAction} />
      {shown.map((project) => (
        <ProjectRow key={project.id} project={project} providers={providers} lastPostFailed={failedPosts.has(project.id)} handlers={handlers} />
      ))}
      {projects.length === 0 && <div className="border-t border-line px-4 py-3 text-sm text-dim">No project in this org yet.</div>}
      {hidden > 0 && (
        <button type="button" className="w-full border-t border-line px-4 py-2.5 text-left text-sm text-link hover:underline max-sm:min-h-11" onClick={() => setOpen(true)}>
          Show {plural(hidden, "more project")}
        </button>
      )}
    </section>
  );
}
