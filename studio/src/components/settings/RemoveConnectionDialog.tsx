import { useMutation } from "@tanstack/react-query";
import { errorText } from "../../lib/actions";
import { isDiscord, projectsUsing, projectsUsingInOrg } from "../../lib/integrations";
import { showToast } from "../../lib/toast";
import type { ConnectionRow, IntegrationsView, ProjectDestination } from "../../lib/types";
import { removeConnection, removeOrg, useRefreshIntegrations } from "../../lib/useIntegrations";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui";
import { Note } from "./bits";
import { SettingsDialog } from "./SettingsDialog";

export interface RemoveTarget {
  connection: ConnectionRow;
  org: string | null;
}

interface RemoveFlowProps {
  view: IntegrationsView;
  target: RemoveTarget;
  onClose: () => void;
  onSwitch: (() => void) | null;
}

interface InUseProps {
  target: RemoveTarget;
  projects: ProjectDestination[];
  onClose: () => void;
  onSwitch: (() => void) | null;
}

const FILLED_DANGER = "!border-gate-bar !bg-gate-bar !text-bg enabled:hover:!bg-[#f06a62] max-sm:min-h-[46px] max-sm:w-full";

// The count of projects as `5 projects`.
function projectCount(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

// The projects that would lose their destination when the target is removed.
function affectedProjects(view: IntegrationsView, target: RemoveTarget): ProjectDestination[] {
  if (!isDiscord(target.connection)) return [];
  const name = target.connection.name;
  return target.org ? projectsUsingInOrg(view, name, target.org) : projectsUsing(view, name);
}

// Runs the confirmed remove of a connection or of one of its orgs, unlinking the projects first.
function useConfirmedRemove(target: RemoveTarget, onClose: () => void) {
  const refresh = useRefreshIntegrations();
  const name = target.connection.name;
  return useMutation({
    mutationFn: () => (target.org ? removeOrg(name, target.org, true) : removeConnection(name, true)),
    onSuccess: () => {
      showToast(target.org ? `${name} removed from org ${target.org}` : `Connection ${name} removed`, "success");
      onClose();
    },
    onError: (err) => showToast(errorText(err), "error"),
    onSettled: refresh,
  });
}

// The list of the projects that lose their destination, with their org.
function AffectedList({ projects }: { projects: ProjectDestination[] }) {
  return (
    <div className="rounded-lg border border-line">
      <div className="px-3 py-2 text-xs tracking-[.3px] text-dim uppercase">Projects that will lose their destination</div>
      {projects.map((project) => (
        <div key={project.id} className="flex items-center gap-2.5 border-t border-[#1b2030] px-3 py-1.5 text-[13px]">
          <span className="truncate font-mono">{project.name}</span>
          <span className="ml-auto text-sm text-dim">{project.org}</span>
        </div>
      ))}
    </div>
  );
}

// The confirmation of a remove that unlinks projects: the list, the no-undo warning and the red action.
function InUseDialog({ target, projects, onClose, onSwitch }: InUseProps) {
  const remove = useConfirmedRemove(target, onClose);
  const name = target.connection.name;
  const count = projectCount(projects.length);
  const title = target.org ? (
    <>
      Remove org <span className="font-mono">{target.org}</span> from <span className="font-mono">{name}</span>?
    </>
  ) : (
    <>
      Remove <span className="font-mono">{name}</span>?
    </>
  );
  const footer = (
    <>
      <Button variant="danger" className={FILLED_DANGER} disabled={remove.isPending} onClick={() => remove.mutate()}>
        {remove.isPending ? "Removing…" : `Unlink ${count} and remove${target.org ? " the org" : ""}`}
      </Button>
      <Button variant="ghost" className="max-sm:min-h-[46px]" onClick={onClose}>
        Cancel
      </Button>
      {onSwitch && (
        <span className="ml-auto text-sm text-muted max-sm:ml-0">
          Rather switch the destination?{" "}
          <button type="button" className="text-link hover:underline" onClick={onSwitch}>
            Link to another connection
          </button>
        </span>
      )}
    </>
  );
  return (
    <SettingsDialog title={<><span className="text-red">⚠</span> {title}</>} label={target.org ? `Remove org ${target.org} from ${name}` : `Remove ${name}`} width="narrow" phone="sheet" alert onClose={onClose} footer={footer}>
      <div className="text-[13px] text-[#d6dae3]">
        {target.org ? (
          <>
            <strong>{count}</strong> of org <span className="font-mono">{target.org}</span> use <span className="font-mono">{name}</span>; they lose their destination and stop getting the “job closed” notice.
          </>
        ) : (
          <>
            This connection is the log destination of <strong>{count}</strong>. Removing it leaves them <strong>without a destination</strong>: they stop getting the “job closed” notice.
          </>
        )}
      </div>
      <AffectedList projects={projects} />
      {!target.org && (
        <>
          <Note tone="warn" icon="⚠">
            The webhook URL cannot be recovered once removed. To use this channel again, add the webhook anew and link the projects.
          </Note>
          <div className="text-sm text-dim">The webhook still exists in Discord; delete it there if you won't use it again.</div>
        </>
      )}
    </SettingsDialog>
  );
}

// The confirmation of a remove no project depends on: an org taken away, or a connection whose secret is gone for good.
function PlainRemoveDialog({ target, onClose }: { target: RemoveTarget; onClose: () => void }) {
  const refresh = useRefreshIntegrations();
  const name = target.connection.name;
  const confirm = async () => {
    try {
      if (target.org) await removeOrg(name, target.org, false);
      else await removeConnection(name, false);
      showToast(target.org ? `${name} removed from org ${target.org}` : `Connection ${name} removed`, "success");
    } finally {
      refresh();
    }
  };
  if (target.org) {
    return (
      <ConfirmDialog title={`Remove org ${target.org} from ${name}?`} confirmLabel="Remove the org" onConfirm={confirm} onClose={onClose}>
        {`No project of org ${target.org} uses ${name} any more.`}
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog title={`Remove ${name}?`} confirmLabel="Remove" onConfirm={confirm} onClose={onClose}>
      {`The ${isDiscord(target.connection) ? "webhook URL" : "secret"} of ${name} cannot be recovered once removed: to use it again, add it anew.`}
      {isDiscord(target.connection) ? " The webhook still exists in Discord; delete it there if you won't use it again." : ""}
    </ConfirmDialog>
  );
}

// The remove flow of a connection or of one of its orgs: the in-use confirmation when projects lose their destination, a plain one otherwise.
export function RemoveConnectionDialog({ view, target, onClose, onSwitch }: RemoveFlowProps) {
  const projects = affectedProjects(view, target);
  if (projects.length) return <InUseDialog target={target} projects={projects} onClose={onClose} onSwitch={target.org ? null : onSwitch} />;
  return <PlainRemoveDialog target={target} onClose={onClose} />;
}
