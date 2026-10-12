import { footprintCounters, plural } from "../../../lib/projects";
import type { SettingsProject } from "../../../lib/types";
import { Button } from "../../ui";
import { KeyChip } from "./ProjectRow";

interface HistoryCardProps {
  projects: SettingsProject[];
  onRepick: (project: SettingsProject) => void;
  onPurge: (project: SettingsProject) => void;
}

// The dashed card of the projects known only from history: no checkout, rows they still own.
export function HistoryCard({ projects, onRepick, onPurge }: HistoryCardProps) {
  if (!projects.length) return null;
  return (
    <section aria-label="known from history" className="rounded-lg border border-dashed border-button-line">
      <div className="flex flex-col gap-0.5 px-4 py-3">
        <h2 className="m-0 text-sm font-medium tracking-[.3px] text-muted uppercase">Known from history</h2>
        <span className="text-sm text-dim">These projects have no checkout any more; their jobs, decisions and memory are kept until you purge them.</span>
      </div>
      {projects.map((project) => (
        <div key={project.id} className="flex flex-wrap items-center gap-3 border-t border-dashed border-line px-4 py-3">
          <span className="font-mono text-[14px]">{project.name}</span>
          {project.key && <KeyChip value={project.key} />}
          <span className="text-sm text-dim">
            {project.org} · owns {plural(footprintCounters(project.footprint).total, "row")}
          </span>
          <div className="ml-auto flex gap-2 max-sm:ml-0 max-sm:w-full">
            <Button size="sm" className="max-sm:min-h-11 max-sm:flex-1" onClick={() => onRepick(project)}>
              Pick a folder…
            </Button>
            <Button size="sm" variant="danger" className="max-sm:min-h-11 max-sm:flex-1" onClick={() => onPurge(project)}>
              Purge…
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
