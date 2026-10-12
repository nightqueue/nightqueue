import { integrationsSummary, isPathMissing, pathParts } from "../../../lib/projects";
import type { ProviderSettings, SettingsProject } from "../../../lib/types";
import { Button } from "../../ui";
import { Pill } from "../bits";

export const ROW_GRID = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_auto] items-start gap-4 max-lg:grid-cols-1 max-lg:gap-2.5";

const PHONE_BUTTON = "max-lg:min-h-11 max-lg:flex-1";

export interface ProjectRowHandlers {
  onEdit: (project: SettingsProject) => void;
  onRemove: (project: SettingsProject) => void;
  onRepick: (project: SettingsProject) => void;
}

interface ProjectRowProps {
  project: SettingsProject;
  providers: ProviderSettings[];
  lastPostFailed: boolean;
  handlers: ProjectRowHandlers;
}

// A small mono key chip.
export function KeyChip({ value }: { value: string }) {
  return <span className="rounded-full border border-button-line px-1.5 font-mono text-xs leading-[18px] text-muted">{value}</span>;
}

// The name of a project with its key and the old keys that still resolve.
function NameCell({ project }: { project: SettingsProject }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[14px] text-fg">{project.name}</span>
        {project.key && <KeyChip value={project.key} />}
      </div>
      {project.aliases.length > 0 && <span className="text-xs text-dim">old keys {project.aliases.join(", ")} still resolve</span>}
    </div>
  );
}

// A path truncated on the left, the folder name bright.
export function TruncatedPath({ path }: { path: string }) {
  const { head, folder } = pathParts(path);
  return (
    <span dir="rtl" title={path} className="block truncate text-left font-mono text-[13px]">
      <bdi>
        <span className="text-dim">{head}</span>
        <span className="text-fg">{folder}</span>
      </bdi>
    </span>
  );
}

// The checkout of a project: its path and whether it exists, or that it has none, with its origin.
function CheckoutCell({ project, onRepick }: { project: SettingsProject; onRepick: () => void }) {
  if (!project.path) {
    return (
      <div className="flex flex-col gap-1">
        <Pill tone="off">no path</Pill>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <TruncatedPath path={project.path} />
      <div className="flex flex-wrap items-center gap-2">
        {isPathMissing(project) ? <Pill tone="err">path missing</Pill> : <Pill tone="ok">ok</Pill>}
        {isPathMissing(project) && (
          <button type="button" className="text-sm text-link hover:underline max-lg:min-h-11" onClick={onRepick}>
            Pick the folder again…
          </button>
        )}
        <span className="truncate font-mono text-xs text-dim">{project.origin ?? "no origin"}</span>
      </div>
    </div>
  );
}

// The two-line summary of a project's integrations, with the red pill of a failed last post.
function IntegrationsCell({ project, providers, lastPostFailed }: { project: SettingsProject; providers: ProviderSettings[]; lastPostFailed: boolean }) {
  const lines = integrationsSummary(project, providers);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[13px]">
      {lines.map((line) => (
        <span key={line.text} className={`truncate ${line.dim ? "text-dim" : "text-muted"}`}>
          {line.text}
        </span>
      ))}
      {lastPostFailed && <Pill tone="err">last post failed</Pill>}
    </div>
  );
}

// One project row: name, checkout, integrations and its Edit and Remove actions; a missing checkout tints the row.
export function ProjectRow({ project, providers, lastPostFailed, handlers }: ProjectRowProps) {
  const tint = isPathMissing(project) ? "bg-[#1f1214]" : "";
  return (
    <div className={`${ROW_GRID} border-t border-line p-4 max-lg:rounded-md max-lg:border max-lg:m-3 max-lg:mt-0 ${tint}`}>
      <NameCell project={project} />
      <CheckoutCell project={project} onRepick={() => handlers.onRepick(project)} />
      <IntegrationsCell project={project} providers={providers} lastPostFailed={lastPostFailed} />
      <div className="flex gap-2">
        <Button size="sm" className={PHONE_BUTTON} onClick={() => handlers.onEdit(project)}>
          Edit
        </Button>
        <Button size="sm" variant="danger" className={PHONE_BUTTON} onClick={() => handlers.onRemove(project)}>
          Remove
        </Button>
      </div>
    </div>
  );
}
