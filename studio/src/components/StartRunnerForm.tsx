import { Play } from "lucide-react";
import { useState } from "react";
import { jobRef, WATCH_INTERVAL_DEFAULT_S } from "../lib/queue";
import type { Job, RunnerChoice } from "../lib/types";
import { ActionIcon } from "./StatusIcon";
import { Button, FIELD_CLASS } from "./ui";

type Mode = RunnerChoice["mode"];

interface WindowTimes {
  from: string;
  until: string;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The runner the form describes, or null while it is incomplete (no pending job for once, a window without a valid `until`).
function choiceOf(mode: Mode, pendingJob: Job | null, times: WindowTimes): RunnerChoice | null {
  if (mode === "drain") return { mode };
  if (mode === "loop") return { mode, intervalS: WATCH_INTERVAL_DEFAULT_S };
  if (mode === "once") return pendingJob ? { mode, jobId: pendingJob.id } : null;
  const fromValid = times.from === "" || HH_MM.test(times.from);
  return fromValid && HH_MM.test(times.until) ? { mode, from: times.from, until: times.until } : null;
}

// The two HH:MM inputs of a window runner.
function WindowInputs({ times, onChange, tone }: { times: WindowTimes; onChange: (next: WindowTimes) => void; tone: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor="runner-from" className={`text-sm ${tone}`}>
        from
      </label>
      <input id="runner-from" type="time" className={`${FIELD_CLASS} min-h-9`} value={times.from} onChange={(event) => onChange({ ...times, from: event.target.value })} />
      <label htmlFor="runner-until" className={`text-sm ${tone}`}>
        until
      </label>
      <input id="runner-until" type="time" className={`${FIELD_CLASS} min-h-9`} value={times.until} onChange={(event) => onChange({ ...times, until: event.target.value })} />
    </span>
  );
}

interface StartRunnerFormProps {
  pendingJob: Job | null;
  onStart?: (choice: RunnerChoice) => void;
  primary?: boolean;
  tone?: string;
}

// The runner mode select (drain, loop, once for the oldest pending job, window) and its `Start runner` button.
export function StartRunnerForm({ pendingJob, onStart, primary = false, tone = "text-muted" }: StartRunnerFormProps) {
  const [mode, setMode] = useState<Mode>("drain");
  const [times, setTimes] = useState<WindowTimes>({ from: "22:00", until: "04:00" });
  const choice = choiceOf(mode, pendingJob, times);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="runner-mode" className={`text-sm ${tone}`}>
        mode
      </label>
      <select id="runner-mode" className={`${FIELD_CLASS} min-h-9`} value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
        <option value="drain">drain</option>
        <option value="loop">loop · {WATCH_INTERVAL_DEFAULT_S}s</option>
        <option value="once" disabled={!pendingJob}>
          once · {pendingJob ? jobRef(pendingJob.id) : "no pending job"}
        </option>
        <option value="window">window</option>
      </select>
      {mode === "window" && <WindowInputs times={times} onChange={setTimes} tone={tone} />}
      <Button variant={primary ? "primary" : "default"} disabled={!onStart || !choice} onClick={() => choice && onStart?.(choice)}>
        <ActionIcon icon={Play} />
        Start runner
      </Button>
    </div>
  );
}
