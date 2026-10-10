import { destinationOptions, NO_DESTINATION, noticeLabel } from "../../lib/integrations";
import type { IntegrationsView, ProjectDestination } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { Button } from "../ui";
import { Note, SELECT_CLASS } from "./bits";
import { useDestinationControl, type DestinationControl } from "./useDestinationControl";

interface DestinationRowProps {
  project: ProjectDestination;
  view: IntegrationsView;
  locked: boolean;
}

interface ControlledProps extends DestinationRowProps {
  control: DestinationControl;
}

// The id that ties a refused select to the note explaining it.
function refusalId(project: ProjectDestination): string {
  return `refusal-${project.id}`;
}

// The destination select of a project; red while a refusal is shown.
function DestinationSelect({ project, view, locked, control }: ControlledProps) {
  const refused = control.refusal !== null;
  return (
    <select
      aria-label={`destination of ${project.name}`}
      aria-invalid={refused}
      aria-describedby={refused ? refusalId(project) : undefined}
      disabled={control.pending || locked}
      value={control.value}
      onChange={(event) => control.pick(event.target.value)}
      className={`${SELECT_CLASS} ${control.value === NO_DESTINATION ? "text-muted" : ""}`}
    >
      {destinationOptions(view, project).map((option) => (
        <option key={option.value || "none"} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// The Last notice of a project: the job and when, red when the post failed, or the empty text.
function NoticeText({ project, empty }: { project: ProjectDestination; empty: string }) {
  const now = useNow(60_000);
  const label = noticeLabel(project.lastNotice, now);
  if (!label) return <span className="text-dim">{empty}</span>;
  return (
    <span className={label.tone === "err" ? "text-red" : "text-muted"} title={project.lastNotice?.note ?? undefined}>
      {label.text}
    </span>
  );
}

// The red note under a refused pick, with the one-click allow and apply.
function RefusalNote({ project, control }: Pick<ControlledProps, "project" | "control">) {
  const refusal = control.refusal;
  if (!refusal) return null;
  const stays = project.destination ? (
    <>
      The destination stays <span className="font-mono">{project.destination}</span>.
    </>
  ) : (
    "The project stays without a destination."
  );
  return (
    <div id={refusalId(project)}>
      <Note tone="err" icon="⚠" role="alert">
        <div className="font-semibold text-red">
          <span className="font-mono">{refusal.connectionId}</span> can't be used on <span className="font-mono">{project.name}</span>
        </div>
        <div>
          The connection is not allowed for org <span className="font-mono">{refusal.org}</span>. {stays}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={control.pending} onClick={control.allowAndApply} className="max-lg:min-h-10">
            {`Allow ${refusal.connectionId} for ${refusal.org}`}
          </Button>
          <Button size="sm" variant="ghost" onClick={control.cancel} className="max-lg:min-h-10">
            Cancel
          </Button>
        </div>
      </Note>
    </div>
  );
}

// One project of the destination table on a desktop, with its refusal row when a pick was refused.
export function DesktopDestinationRow({ project, view, locked }: DestinationRowProps) {
  const control = useDestinationControl(project);
  return (
    <>
      <tr>
        <td className="border-b border-[#1b2030] px-3 py-2 font-mono">{project.name}</td>
        <td className="border-b border-[#1b2030] px-3 py-2">
          <DestinationSelect project={project} view={view} locked={locked} control={control} />
        </td>
        <td className="border-b border-[#1b2030] px-3 py-2">
          <NoticeText project={project} empty="—" />
        </td>
        <td className="border-b border-[#1b2030] px-3 py-2">
          {project.destination && (
            <Button size="sm" variant="ghost" disabled={control.pending} onClick={control.unlink}>
              Unlink
            </Button>
          )}
        </td>
      </tr>
      {control.refusal && (
        <tr>
          <td colSpan={4} className="border-b border-[#1b2030] px-3 pb-3">
            <RefusalNote project={project} control={control} />
          </td>
        </tr>
      )}
    </>
  );
}

// One project of the destination list on a phone: name and last notice, then a full-width select.
export function PhoneDestinationRow({ project, view, locked }: DestinationRowProps) {
  const control = useDestinationControl(project);
  return (
    <div className="flex flex-col gap-2 border-t border-[#1b2030] px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono">{project.name}</span>
        <span className="ml-auto shrink-0 text-xs">
          <NoticeText project={project} empty="never notified" />
        </span>
      </div>
      <DestinationSelect project={project} view={view} locked={locked} control={control} />
      <RefusalNote project={project} control={control} />
    </div>
  );
}
