import { useProjects } from "../lib/api";
import { ALL_PROJECTS, STATUS_ORDER, totalCount } from "../lib/queue";
import type { JobStatus, QueueFilters } from "../lib/types";
import { Button, Chip, FIELD_CLASS } from "./ui";

interface ToolbarProps {
  counts: Partial<Record<JobStatus, number>>;
  filters: QueueFilters;
  onFilters: (next: QueueFilters) => void;
  onAddJob?: () => void;
}

// The status chips: `All N` and one chip per status with its count, the active one highlighted.
function StatusChips({ counts, filters, onFilters }: Omit<ToolbarProps, "onAddJob">) {
  return (
    <>
      <Chip on={filters.status === "all"} onClick={() => onFilters({ ...filters, status: "all" })}>
        All {totalCount(counts)}
      </Chip>
      {STATUS_ORDER.map((status) => (
        <Chip key={status} on={filters.status === status} onClick={() => onFilters({ ...filters, status })}>
          {status} {counts[status] ?? 0}
        </Chip>
      ))}
    </>
  );
}

// The project select, built from the registered projects; it says so when they cannot be read.
function ProjectSelect({ value, onChange }: { value: string; onChange: (projectId: string) => void }) {
  const projects = useProjects();
  const fallback = projects.isPending ? "loading projects…" : projects.isError ? "projects unavailable" : "all projects";
  return (
    <span className="flex items-center gap-2">
      <label htmlFor="queue-project" className="text-sm text-muted">
        Project
      </label>
      <select id="queue-project" className={`${FIELD_CLASS} max-w-[200px]`} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL_PROJECTS}>{fallback}</option>
        {(projects.data ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </span>
  );
}

// The search box over the loaded rows: ref, title, slug, branch or PR number.
function SearchBox({ value, onChange }: { value: string; onChange: (search: string) => void }) {
  return (
    <>
      <label htmlFor="queue-search" className="sr-only">
        Search jobs
      </label>
      <input
        id="queue-search"
        type="search"
        placeholder="search ref, title, branch, PR…"
        className={`${FIELD_CLASS} w-full px-2.5 sm:w-[260px]`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}

// The toolbar above the queue: status filters, project select, search and `+ Add job`.
export function Toolbar({ counts, filters, onFilters, onAddJob }: ToolbarProps) {
  return (
    <section aria-label="filters" className="flex flex-wrap items-center gap-2">
      <StatusChips counts={counts} filters={filters} onFilters={onFilters} />
      <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" aria-hidden="true" />
      <ProjectSelect value={filters.projectId} onChange={(projectId) => onFilters({ ...filters, projectId })} />
      <SearchBox value={filters.search} onChange={(search) => onFilters({ ...filters, search })} />
      <div className="ml-auto flex gap-2">
        <Button variant="primary" disabled={!onAddJob} onClick={onAddJob}>
          + Add job
        </Button>
      </div>
    </section>
  );
}
