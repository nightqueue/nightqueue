import type { JobDetail } from "../../lib/types";
import { PrBadge } from "../PrBadge";
import { Card, CardEmpty, KeyValues } from "./Card";

// What the card says while there is no pull request, by how far the job got.
function noPrSentence(job: JobDetail): string {
  if (job.status === "running" || job.status === "pending") return "Not opened yet (phase 8).";
  return "None — the run stopped before phase 8.";
}

// The pull request card: its badge or why there is none, then the branch it lives on.
export function PrCard({ job }: { job: JobDetail }) {
  return (
    <Card label="pull request" title="Pull request">
      {job.pr_url ? (
        <div>
          <PrBadge url={job.pr_url} state={job.pr_state} />
        </div>
      ) : (
        <CardEmpty>{noPrSentence(job)}</CardEmpty>
      )}
      {job.branch && <KeyValues rows={[["branch", job.branch]]} />}
    </Card>
  );
}
