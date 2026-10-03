import { useCallback, useMemo, useState } from "react";
import { AddJobDrawer } from "../components/AddJobDrawer";
import { CancelJobDialog } from "../components/CancelJobDialog";
import { CloseJobDialog } from "../components/CloseJobDialog";
import { IssuesSection } from "../components/IssuesSection";
import type { RowActions, RowContext } from "../components/JobCells";
import { QueueCards } from "../components/QueueCard";
import { QueueSkeleton } from "../components/QueueSkeleton";
import { QueueTable } from "../components/QueueTable";
import { RetryDialog } from "../components/RetryDialog";
import { RowMenu, type RowMenuPick } from "../components/RowMenu";
import { type RunnerActions, RunnerBanner } from "../components/RunnerBanner";
import { Toolbar } from "../components/Toolbar";
import { Kbd } from "../components/ui";
import { closeJob, closesWithoutConfirm, runJob, setQueuePaused, startRunner, stopRunner } from "../lib/actions";
import { useQueueSnapshot } from "../lib/events";
import { ALL_PROJECTS, filterJobs, normalizeSnapshot, totalCount } from "../lib/queue";
import type { Job, QueueFilters, Runner, RunnerChoice } from "../lib/types";
import { useAction } from "../lib/useAction";

const INITIAL_FILTERS: QueueFilters = { status: "all", projectId: ALL_PROJECTS, search: "" };

type Dialog = { pick: RowMenuPick; job: Job } | null;

type Menu = { job: Job; anchor: HTMLElement } | null;

type Drawer = { issueRef?: string; project?: string } | null;

const byJob = (job: Job) => String(job.id);

const byRunner = (runner: Runner) => String(runner.pid);

const byChoice = (choice: RunnerChoice) => choice.mode;

const byPause = () => "pause";

// The runner banner's actions: start by mode, stop one runner, pause or resume the whole queue.
function useRunnerActions(): RunnerActions {
  const onStart = useAction(startRunner, byChoice);
  const onStop = useAction(stopRunner, byRunner);
  const setPaused = useAction(setQueuePaused, byPause);
  return useMemo(() => ({ onStart, onStop, onPauseToggle: (paused: boolean) => setPaused(!paused) }), [onStart, onStop, setPaused]);
}

// The dialog a menu pick opens: retry with a note, cancel, or close, each confirmed before its tool runs.
function RowDialog({ dialog, runnersOnline, onClose }: { dialog: NonNullable<Dialog>; runnersOnline: number; onClose: () => void }) {
  const { pick, job } = dialog;
  if (pick === "retry") return <RetryDialog job={job} runnersOnline={runnersOnline} onClose={onClose} />;
  if (pick === "close") return <CloseJobDialog job={job} onClose={onClose} />;
  return <CancelJobDialog job={job} onClose={onClose} />;
}

// What the jobs section says when no row is shown: an empty queue, or filters that match nothing.
function EmptyRows({ queueEmpty }: { queueEmpty: boolean }) {
  return <p className="m-0 px-3 py-6 text-center text-muted">{queueEmpty ? "The queue is empty — + Add job queues the first one." : "No job matches these filters."}</p>;
}

// The footer of the jobs section: rows shown of the whole queue, and where the rows come from.
function QueueFooter({ shown, total }: { shown: number; total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2.5 text-sm text-muted">
      <span>
        {shown} of {total} · same columns as <Kbd>nightqueue queue status</Kbd> · rows refresh every 1s from /events
      </span>
    </div>
  );
}

// The jobs section: the table on wide screens, stacked cards on narrow ones, then the footer.
function JobsSection({ jobs, total, context, queueEmpty }: { jobs: Job[]; total: number; context: RowContext; queueEmpty: boolean }) {
  return (
    <section aria-label="jobs" className="overflow-hidden rounded-lg border border-line bg-surface">
      {jobs.length === 0 ? (
        <EmptyRows queueEmpty={queueEmpty} />
      ) : (
        <>
          <div className="hidden lg:block">
            <QueueTable jobs={jobs} context={context} />
          </div>
          <div className="lg:hidden">
            <QueueCards jobs={jobs} context={context} />
          </div>
        </>
      )}
      <QueueFooter shown={jobs.length} total={total} />
    </section>
  );
}

// The Queue screen: toolbar, runner banner and the live jobs, all from the `/events` snapshot.
export function QueuePage() {
  const raw = useQueueSnapshot();
  const [filters, setFilters] = useState<QueueFilters>(INITIAL_FILTERS);
  const [menu, setMenu] = useState<Menu>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const onRun = useAction(runJob, byJob);
  const closeMerged = useAction(closeJob, byJob);
  const runnerActions = useRunnerActions();
  const rowActions = useMemo<RowActions>(
    () => ({
      onRun,
      onClose: (job) => (closesWithoutConfirm(job) ? closeMerged(job) : setDialog({ pick: "close", job })),
      onMenu: (job, anchor) => setMenu((current) => (current?.job.id === job.id ? null : { job, anchor })),
    }),
    [onRun, closeMerged],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const queueIssue = useCallback(({ ref, project }: { ref: string; project: string }) => setDrawer({ issueRef: ref, project }), []);
  const snapshot = useMemo(() => (raw ? normalizeSnapshot(raw) : undefined), [raw]);
  const shown = useMemo(() => (snapshot ? filterJobs(snapshot.jobs, filters) : []), [snapshot, filters]);
  if (!snapshot) return <QueueSkeleton />;
  const context: RowContext = { runnersOnline: snapshot.runnersOnline, actions: rowActions };
  return (
    <>
      <Toolbar counts={snapshot.counts} filters={filters} onFilters={setFilters} onAddJob={() => setDrawer({})} />
      <RunnerBanner snapshot={snapshot} actions={runnerActions} />
      <JobsSection jobs={shown} total={totalCount(snapshot.counts)} context={context} queueEmpty={snapshot.jobs.length === 0} />
      <IssuesSection projectId={filters.projectId} onQueue={queueIssue} />
      {menu && <RowMenu job={menu.job} anchor={menu.anchor} onPick={(pick, job) => setDialog({ pick, job })} onClose={closeMenu} />}
      {dialog && <RowDialog dialog={dialog} runnersOnline={snapshot.runnersOnline} onClose={closeDialog} />}
      {drawer && <AddJobDrawer runnersOnline={snapshot.runnersOnline} onClose={closeDrawer} initialIssue={drawer.issueRef} initialProject={drawer.project} />}
    </>
  );
}
