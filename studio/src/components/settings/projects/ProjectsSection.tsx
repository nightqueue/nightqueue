import { useCallback, useState } from "react";
import { errorText } from "../../../lib/actions";
import { filterCounts, filterProjects, groupByOrg, historyProjects, type ProjectFilter, summaryLine } from "../../../lib/projects";
import { showToast } from "../../../lib/toast";
import type { OrgRow, ProjectsAnswer, SettingsProject } from "../../../lib/types";
import { useIntegrations } from "../../../lib/useIntegrations";
import { removeOrgById, useOrgs, useProjectsAnswer, useRefreshProjects } from "../../../lib/useProjectsSettings";
import { Button, Chip } from "../../ui";
import { SettingsError } from "../SettingsError";
import { AddProjectDialog, type AddMode } from "./AddProjectDialog";
import { EditProjectDrawer } from "./EditProjectDrawer";
import { HistoryCard } from "./HistoryCard";
import type { OrgAction } from "./OrgActionsMenu";
import { OrgCard } from "./OrgCard";
import { type OrgDialog, OrgDialogs } from "./OrgDialogs";
import type { ProjectRowHandlers } from "./ProjectRow";
import { ProjectsEmpty } from "./ProjectsEmpty";
import { ProjectsSkeleton } from "./ProjectsSkeleton";
import { RemoveProjectDialog } from "./RemoveProjectDialog";

type SectionDialog = { kind: "add"; mode: AddMode } | { kind: "edit"; id: string } | { kind: "remove"; id: string } | { kind: "org"; dialog: OrgDialog } | null;

interface Loaded {
  answer: ProjectsAnswer;
  orgs: OrgRow[];
}

const FILTERS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "path-missing", label: "path missing" },
  { value: "no-path", label: "no path" },
];

// The ids of the projects whose last "job closed" post failed, read from the Integrations view.
function useFailedPosts(): Set<string> {
  const integrations = useIntegrations();
  return new Set((integrations.data?.projects ?? []).filter((project) => project.lastNotice?.ok === false).map((project) => project.id));
}

// Removes an empty org at once; a refusal opens the dialog that tells why.
function useRemoveOrgNow(open: (dialog: SectionDialog) => void): (org: OrgRow) => void {
  const refresh = useRefreshProjects();
  return useCallback(
    (org: OrgRow) => {
      removeOrgById(org.id)
        .then(() => showToast(`Removed org ${org.name}`, "success"))
        .catch((err: unknown) => open({ kind: "org", dialog: { kind: "remove-refused", org, reason: errorText(err) } }))
        .finally(refresh);
    },
    [open, refresh],
  );
}

// The section header: title, summary line and the two add buttons.
function ProjectsHeader({ summary, onAdd, onNewOrg }: { summary: string; onAdd: () => void; onNewOrg: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 text-[20px] font-semibold">Projects &amp; orgs</h1>
        <div className="text-[13px] text-muted">{summary}</div>
      </div>
      <div className="ml-auto flex gap-2 max-sm:ml-0 max-sm:w-full">
        <Button className="max-sm:min-h-11 max-sm:flex-1" onClick={onNewOrg}>
          + New org
        </Button>
        <Button variant="primary" className="max-sm:min-h-11 max-sm:flex-1" onClick={onAdd}>
          + Add project
        </Button>
      </div>
    </div>
  );
}

// The filter chips with their counts.
function FilterChips({ rows, filter, onChange }: { rows: SettingsProject[]; filter: ProjectFilter; onChange: (filter: ProjectFilter) => void }) {
  const counts = filterCounts(rows);
  return (
    <div role="group" aria-label="filter projects" className="flex flex-wrap gap-2 max-sm:[&>button]:min-h-11">
      {FILTERS.map((entry) => (
        <Chip key={entry.value} on={filter === entry.value} onClick={() => onChange(entry.value)}>
          {`${entry.label} · ${counts[entry.value]}`}
        </Chip>
      ))}
    </div>
  );
}

// The loaded body: the empty state, or the filter chips, one card per org and the history card.
function ProjectsBody({ loaded, filter, setFilter, handlers, onOrgAction, onAdd }: { loaded: Loaded; filter: ProjectFilter; setFilter: (filter: ProjectFilter) => void; handlers: ProjectRowHandlers & { onPurge: (project: SettingsProject) => void }; onOrgAction: (action: OrgAction, org: OrgRow) => void; onAdd: () => void }) {
  const failedPosts = useFailedPosts();
  const { projects, providers } = loaded.answer;
  const groups = groupByOrg(filterProjects(projects, filter), loaded.orgs).filter((group) => filter === "all" || group.projects.length > 0);
  const cards = groups.map((group) => <OrgCard key={group.org.id} org={group.org} projects={group.projects} providers={providers} failedPosts={failedPosts} handlers={handlers} onOrgAction={onOrgAction} />);
  if (!projects.length) return <ProjectsEmpty onAdd={onAdd}>{cards}</ProjectsEmpty>;
  return (
    <>
      <FilterChips rows={projects} filter={filter} onChange={setFilter} />
      {cards}
      <HistoryCard projects={historyProjects(filterProjects(projects, filter))} onRepick={handlers.onRepick} onPurge={handlers.onPurge} />
    </>
  );
}

// The open dialog or drawer of the section, if any.
function SectionDialogs({ dialog, loaded, open }: { dialog: SectionDialog; loaded: Loaded; open: (dialog: SectionDialog) => void }) {
  const close = () => open(null);
  const byId = (id: string) => loaded.answer.projects.find((project) => project.id === id);
  if (dialog?.kind === "add") return <AddProjectDialog mode={dialog.mode} orgs={loaded.orgs} onClose={close} />;
  if (dialog?.kind === "org") return <OrgDialogs dialog={dialog.dialog} orgs={loaded.orgs} onClose={close} />;
  const project = dialog ? byId(dialog.id) : undefined;
  if (dialog?.kind === "edit" && project) return <EditProjectDrawer project={project} providers={loaded.answer.providers} orgs={loaded.orgs} onClose={close} onRemove={(target) => open({ kind: "remove", id: target.id })} />;
  if (dialog?.kind === "remove" && project) return <RemoveProjectDialog project={project} onClose={close} />;
  return null;
}

// Settings › Projects & orgs: every org and project of the home, their dialogs, and the loading, error and empty states.
export function ProjectsSection() {
  const answer = useProjectsAnswer();
  const orgs = useOrgs();
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [dialog, setDialog] = useState<SectionDialog>(null);
  const open = useCallback((next: SectionDialog) => setDialog(next), []);
  const removeOrgNow = useRemoveOrgNow(open);
  const loaded: Loaded | null = answer.data && orgs.data ? { answer: answer.data, orgs: orgs.data } : null;
  const handlers = {
    onEdit: (project: SettingsProject) => open({ kind: "edit", id: project.id }),
    onRemove: (project: SettingsProject) => open({ kind: "remove", id: project.id }),
    onPurge: (project: SettingsProject) => open({ kind: "remove", id: project.id }),
    onRepick: (project: SettingsProject) => open({ kind: "add", mode: { kind: "repick", project } }),
  };
  const onOrgAction = (action: OrgAction, org: OrgRow) => {
    if (action === "remove") removeOrgNow(org);
    else open({ kind: "org", dialog: action === "key" ? { kind: "key", org } : action === "default" ? { kind: "default", org } : { kind: "rename", org } });
  };
  const failure = answer.error ?? orgs.error;
  const retry = () => {
    void answer.refetch();
    void orgs.refetch();
  };
  const summary = loaded ? summaryLine(loaded.answer.projects, loaded.orgs) : failure ? "runtime unreachable · retrying in 8 s" : "Reading projects and orgs…";
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <ProjectsHeader summary={summary} onAdd={() => open({ kind: "add", mode: { kind: "register" } })} onNewOrg={() => open({ kind: "org", dialog: { kind: "new" } })} />
      {failure && !loaded && <SettingsError error={failure} retrying={answer.isFetching || orgs.isFetching} onRetry={retry} title="Couldn't read the projects and orgs" kept="projects and orgs stay as they were" />}
      {!failure && !loaded && <ProjectsSkeleton />}
      {loaded && <ProjectsBody loaded={loaded} filter={filter} setFilter={setFilter} handlers={handlers} onOrgAction={onOrgAction} onAdd={() => open({ kind: "add", mode: { kind: "register" } })} />}
      {loaded && <SectionDialogs dialog={dialog} loaded={loaded} open={open} />}
    </div>
  );
}
