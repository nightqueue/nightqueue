import { sessionCommand } from "../../lib/actions";
import type { JobDetail, JobMeta } from "../../lib/types";
import { Card, CardEmpty, KeyValues } from "./Card";

// The run card: where the state and the log live, the resume command, and the run's artifact names.
export function RunCard({ job, meta }: { job: JobDetail; meta: JobMeta | null }) {
  const artifacts = Array.isArray(meta?.artifacts) ? meta.artifacts : [];
  return (
    <Card label="run" title="Run">
      <KeyValues
        rows={[
          ["state.json", meta?.state_json ?? "-"],
          ["log", meta?.log_path ?? "-"],
          ["resume", sessionCommand(job)],
        ]}
      />
      {artifacts.length === 0 ? (
        <CardEmpty>No artifact yet.</CardEmpty>
      ) : (
        <ul aria-label="artifacts" className="m-0 flex list-none flex-col gap-[3px] p-0 font-mono text-sm text-note">
          {artifacts.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
