import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../../../lib/actions";
import { footprintCounters, type FootprintCounters, plural, removeMode, typedMatches } from "../../../lib/projects";
import { showToast } from "../../../lib/toast";
import type { SettingsProject } from "../../../lib/types";
import { removeProject, useRefreshProjects } from "../../../lib/useProjectsSettings";
import { Button } from "../../ui";
import { Field, INPUT_CLASS, Note } from "../bits";
import { SettingsDialog } from "../SettingsDialog";

interface RemoveProjectDialogProps {
  project: SettingsProject;
  onClose: () => void;
}

const FILLED_DANGER = "!border-gate-bar !bg-gate-bar !text-bg enabled:hover:!bg-[#f06a62] max-sm:min-h-[46px] max-sm:w-full";

// The four counters of what a purge deletes.
function Counters({ counters }: { counters: FootprintCounters }) {
  const cells = [
    ["jobs", counters.jobs],
    ["decisions", counters.decisions],
    ["memory rows", counters.memoryRows],
    ["lessons", counters.lessons],
  ] as const;
  return (
    <div className="grid grid-cols-4 gap-2 max-sm:grid-cols-2">
      {cells.map(([label, value]) => (
        <div key={label} className="flex flex-col rounded-md border border-line px-3 py-2">
          <span className="font-mono text-[18px] text-fg">{value}</span>
          <span className="text-xs text-dim">{label}</span>
        </div>
      ))}
    </div>
  );
}

// Runs the remove, with the purge when the project owns rows.
function useRemove(project: SettingsProject, purge: boolean, onClose: () => void) {
  const refresh = useRefreshProjects();
  return useMutation({
    mutationFn: () => removeProject(project.id, purge),
    onSuccess: () => {
      showToast(purge ? `Purged ${project.name} and everything it owned` : `Removed ${project.name}`, "success");
      onClose();
    },
    onSettled: refresh,
  });
}

// The Remove project alert: refused while a job runs, the typed name before a purge, one line otherwise.
export function RemoveProjectDialog({ project, onClose }: RemoveProjectDialogProps) {
  const mode = removeMode(project);
  const [typed, setTyped] = useState("");
  const remove = useRemove(project, mode.kind === "typed", onClose);
  const enabled = mode.kind === "plain" || (mode.kind === "typed" && typedMatches(typed, project.name));
  const label = mode.kind === "running" ? mode.text : mode.kind === "typed" ? `Delete ${plural(mode.rows, "row")} and remove the project` : "Remove project";
  const submit = () => {
    if (enabled && !remove.isPending) remove.mutate();
  };
  const footer = (
    <>
      <Button type="submit" variant="danger" className={`${FILLED_DANGER} whitespace-normal`} disabled={!enabled || remove.isPending}>
        {remove.isPending ? "Removing…" : label}
      </Button>
      <Button variant="ghost" className="max-sm:min-h-[46px]" onClick={onClose}>
        Cancel
      </Button>
    </>
  );
  return (
    <SettingsDialog title={<><span className="text-red">⚠</span> Remove {project.name}?</>} label={`Remove ${project.name}`} width="narrow" phone="sheet" alert onClose={onClose} onSubmit={submit} footer={footer}>
      {mode.kind === "running" && <div className="text-[13px] text-[#d6dae3]">{`A job is working on ${project.name} right now; a project cannot be removed under it.`}</div>}
      {mode.kind === "plain" && <div className="text-[13px] text-[#d6dae3]">{`No job, decision, lesson or memory belongs to ${project.name}; only its registration goes.`}</div>}
      {mode.kind === "typed" && (
        <>
          <div className="text-[13px] text-[#d6dae3]">{`${project.name} owns ${plural(mode.rows, "row")}. Removing it deletes all of them and its run directory.`}</div>
          <Counters counters={footprintCounters(project.footprint)} />
          <Note tone="warn" icon="⚠">
            This cannot be undone: the rows are deleted, not archived.
          </Note>
          <Field label={`Type ${project.name} to confirm`}>
            <input className={`${INPUT_CLASS} font-mono`} value={typed} autoFocus autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
          </Field>
        </>
      )}
      {remove.isError && (
        <Note tone="err" icon="⚠" role="alert">
          {`${errorText(remove.error)} Nothing was removed.`}
        </Note>
      )}
    </SettingsDialog>
  );
}
