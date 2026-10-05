import { compactCount, usdLabel } from "../../lib/format";
import type { JobDetail, JobMeta, Timeline } from "../../lib/types";
import { Card, KeyValues } from "./Card";

// The token counters of a job: the live ones while it runs, the row's once it stopped.
function tokenCounters(job: JobDetail): { out: number | null; cacheRead: number | null; cacheWrite: number | null } {
  const live = job.status === "running" ? job.live?.tokens : null;
  if (live) return { out: live.out, cacheRead: live.cache_read, cacheWrite: live.cache_creation };
  return { out: job.tokens_out, cacheRead: job.cache_read, cacheWrite: job.cache_creation };
}

// One big figure of the card: a caption over a mono value.
function Figure({ caption, value }: { caption: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{caption}</div>
      <div className="font-mono text-lg">{value}</div>
    </div>
  );
}

// The tier median line under the card, absent while the tier has no finished job to compare with.
function BaselineLine({ tier, baseline }: { tier: string | null; baseline: JobMeta["baseline"] | undefined }) {
  if (!tier || !baseline || !(baseline.n > 0)) return null;
  return <div className="text-xs text-dim">{`${tier} median: ${compactCount(baseline.turns)} turns · ${compactCount(baseline.ctx)} ctx · ${usdLabel(baseline.cost)} (n=${baseline.n})`}</div>;
}

// The estimated tokens of every phase that spent any, under a "per phase" caption; nothing while none did.
function PhaseTokens({ timeline }: { timeline: Timeline | null }) {
  const spent = (timeline?.phases ?? []).filter((phase) => phase.tokens > 0);
  if (!spent.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted">per phase</div>
      <KeyValues rows={spent.map((phase) => [phase.name, phase.tokens_label] as const)} />
    </div>
  );
}

// The tokens and cost card: cost, orchestrator turns and context, the counters, the tokens per phase, and the tier's median.
export function CostCard({ job, baseline, timeline }: { job: JobDetail; baseline: JobMeta["baseline"] | undefined; timeline: Timeline | null }) {
  const running = job.status === "running";
  const tokens = tokenCounters(job);
  return (
    <Card label="cost" title="Tokens and cost" aside={running ? "live · final at result" : `attempt ${job.attempts}`}>
      <div className="grid grid-cols-3 gap-2.5">
        <Figure caption={running ? "cost so far" : "cost"} value={usdLabel(job.cost_usd)} />
        <Figure caption="orch turns" value={compactCount(job.orch_turns)} />
        <Figure caption="orch ctx" value={compactCount(job.orch_ctx_last)} />
      </div>
      <KeyValues
        rows={[
          ["baseline ctx", compactCount(job.baseline_ctx)],
          ["cache read", compactCount(tokens.cacheRead)],
          ["cache write", compactCount(tokens.cacheWrite)],
          ["output", compactCount(tokens.out)],
          ["bash timeouts", String(job.bash_timeouts ?? 0)],
        ]}
      />
      <PhaseTokens timeline={timeline} />
      <BaselineLine tier={job.tier} baseline={baseline} />
    </Card>
  );
}
