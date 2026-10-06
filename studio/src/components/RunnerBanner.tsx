import { Link } from "@tanstack/react-router";
import { Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { useStudioInfo } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { hhmmUtc } from "../lib/format";
import { jobRef, jobTitle, oldestPendingJob, pendingWaitLabel, runnerExitRule, runnerModeLabel, runnersOnlineLabel } from "../lib/queue";
import type { Job, QueueSnapshot, Runner, RunnerChoice } from "../lib/types";
import { StartRunnerForm } from "./StartRunnerForm";
import { ActionIcon } from "./StatusIcon";
import { Button, Tag } from "./ui";

export interface RunnerActions {
  onStart?: (choice: RunnerChoice) => void;
  onStop?: (runner: Runner) => void;
  onPauseToggle?: (paused: boolean) => void;
}

interface BannerProps {
  snapshot: QueueSnapshot;
  actions: RunnerActions;
}

// The queue-wide `Pause queue` / `Resume queue` control: pausing stops claims, running jobs finish normally.
function PauseQueueButton({ paused, onToggle }: { paused: boolean; onToggle?: (paused: boolean) => void }) {
  return (
    <Button variant="ghost" disabled={!onToggle} onClick={() => onToggle?.(paused)} title={paused ? "claims resume" : "stop claiming; running jobs finish normally"}>
      <ActionIcon icon={paused ? Play : Pause} />
      {paused ? "Resume queue" : "Pause queue"}
    </Button>
  );
}

// The amber line saying the queue is paused, shown only while it is.
function PausedNote({ paused }: { paused: boolean }) {
  if (!paused) return null;
  return <span className="text-sm text-amber">queue paused — running jobs finish, nothing new is claimed</span>;
}

// The runtime label of the studio, `runtime <label>`, empty while it loads.
function RuntimeLabel() {
  const info = useStudioInfo();
  const label = info.data?.runtime ?? info.data?.version;
  return label ? <span className="font-mono">runtime {label}</span> : null;
}

// The job a runner holds, `on J-n <title>`, linking to its job screen.
function HeldJob({ jobId, jobs }: { jobId: number | null; jobs: Job[] }) {
  if (jobId === null) return <span className="text-muted">idle</span>;
  const job = jobs.find((candidate) => candidate.id === jobId);
  const ref = jobRef(jobId);
  return (
    <span className="min-w-0 flex-1 truncate">
      on{" "}
      <Link to="/jobs/$ref" params={{ ref }} className="font-mono">
        {ref}
      </Link>
      {job && <span className="text-muted"> {jobTitle(job)}</span>}
    </span>
  );
}

// One runner line: pid, mode chip, held job, start time and exit rule, and `Stop`.
function RunnerLine({ runner, jobs, onStop }: { runner: Runner; jobs: Job[]; onStop?: (runner: Runner) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-x-4 border-t border-row-line px-4 py-2 text-[13px]">
      <span className="w-[70px] shrink-0 font-mono text-muted">{runner.pid}</span>
      <span className="shrink-0">
        <Tag>{runnerModeLabel(runner)}</Tag>
      </span>
      <HeldJob jobId={runner.job_id} jobs={jobs} />
      <span className="ml-auto hidden shrink-0 whitespace-nowrap text-sm text-muted sm:inline">
        started {hhmmUtc(runner.startedAt)} UTC · {runnerExitRule(runner)}
      </span>
      <Button variant="ghost" size="sm" className="shrink-0" disabled={!onStop} onClick={() => onStop?.(runner)} aria-label={`stop runner ${runner.pid}`}>
        <ActionIcon icon={Square} />
        Stop
      </Button>
    </div>
  );
}

// The log path of every runner, each with a copy button.
function RunnerLogs({ runners }: { runners: Runner[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 border-t border-row-line px-4 py-2 text-sm">
      {runners.map((runner) => (
        <li key={runner.pid} className="flex min-w-0 items-center gap-3">
          <span className="w-[70px] shrink-0 font-mono text-muted">{runner.pid}</span>
          <span className="min-w-0 grow font-mono break-all text-muted">{runner.logPath ?? "no log path recorded"}</span>
          {runner.logPath && (
            <Button variant="ghost" size="sm" onClick={() => copyText(runner.logPath ?? "", "the runner log path")}>
              Copy
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

type Panel = "none" | "logs" | "start";

// The banner with runners online: the header with count, runtime and advisories, then one line per runner.
function OnlineBanner({ snapshot, actions }: BannerProps) {
  const [panel, setPanel] = useState<Panel>("none");
  const toggle = (next: Panel) => setPanel((current) => (current === next ? "none" : next));
  const advisories = (snapshot.advisories ?? []).join(" · ");
  return (
    <section aria-label="runners" className="flex flex-col rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-x-3 px-4 py-2.5">
        <span className="inline-block size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_4px_#1b2a21]" aria-hidden="true" />
        <span className="shrink-0 font-medium whitespace-nowrap">{runnersOnlineLabel(snapshot.runnersOnline)}</span>
        <span className="min-w-0 truncate text-sm text-muted">
          <RuntimeLabel />
          {advisories && ` · ${advisories}`}
        </span>
        <PausedNote paused={snapshot.queue_paused} />
        <div className="ml-auto flex shrink-0 gap-2">
          <PauseQueueButton paused={snapshot.queue_paused} onToggle={actions.onPauseToggle} />
          <Button variant="ghost" aria-expanded={panel === "logs"} onClick={() => toggle("logs")}>
            Runner logs
          </Button>
          <Button aria-expanded={panel === "start"} onClick={() => toggle("start")}>
            <ActionIcon icon={Play} />
            Start runner
          </Button>
        </div>
      </div>
      {panel === "logs" && <RunnerLogs runners={snapshot.runners} />}
      {panel === "start" && (
        <div className="border-t border-row-line px-4 py-2">
          <StartRunnerForm pendingJob={oldestPendingJob(snapshot.jobs)} onStart={actions.onStart} />
        </div>
      )}
      {snapshot.runners.map((runner) => (
        <RunnerLine key={runner.pid} runner={runner} jobs={snapshot.jobs} onStop={actions.onStop} />
      ))}
    </section>
  );
}

// The amber banner with no runner online: how many pending jobs wait, how a job gets claimed, and the runner start form.
function IdleBanner({ snapshot, actions }: BannerProps) {
  const pending = snapshot.counts?.pending ?? 0;
  return (
    <section aria-label="runners" className="flex flex-wrap items-center gap-4 rounded-lg border border-amber-line bg-amber-bg px-4 py-3">
      <span className="inline-block size-2 shrink-0 rounded-full bg-amber shadow-[0_0_0_4px_#3a2b0c]" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="font-medium text-amber">0 runners online — {pendingWaitLabel(pending)} until a runner starts</div>
        <div className="text-sm text-[#b8a068]">
          A job queued now is claimed only after <span className="font-mono">nightqueue queue run</span> or Start runner.
        </div>
        <PausedNote paused={snapshot.queue_paused} />
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <PauseQueueButton paused={snapshot.queue_paused} onToggle={actions.onPauseToggle} />
        <StartRunnerForm pendingJob={oldestPendingJob(snapshot.jobs)} onStart={actions.onStart} primary tone="text-[#b8a068]" />
      </div>
    </section>
  );
}

// The runner banner between the toolbar and the table: the runners online, or the amber variant when there is none.
export function RunnerBanner({ snapshot, actions }: BannerProps) {
  if (snapshot.runnersOnline > 0 && snapshot.runners.length > 0) return <OnlineBanner snapshot={snapshot} actions={actions} />;
  return <IdleBanner snapshot={snapshot} actions={actions} />;
}
