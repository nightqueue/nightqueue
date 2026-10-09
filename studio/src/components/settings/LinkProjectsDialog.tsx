import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../lib/actions";
import { connectionLabel, discordConnections, linkCta, linkPlan, toggledOrg, toggledProject, type LinkGroup, type LinkRow } from "../../lib/integrations";
import { showToast } from "../../lib/toast";
import type { ConnectionRow, IntegrationsView } from "../../lib/types";
import { allowOrg, linkProjects, useRefreshIntegrations } from "../../lib/useIntegrations";
import { Button } from "../ui";
import { INPUT_CLASS, Note, Pill } from "./bits";
import { SettingsDialog } from "./SettingsDialog";

interface LinkProjectsDialogProps {
  view: IntegrationsView;
  initial: string;
  onClose: () => void;
}

const PHONE_VISIBLE = 3;
const CHECKBOX_CLASS = "size-[18px] shrink-0 accent-accent max-sm:size-5";

// The checkbox of a whole org: checked, cleared, or indeterminate when only some of its free projects are checked.
function OrgCheckbox({ group, onToggle }: { group: LinkGroup; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = group.state === "some";
  }, [group.state]);
  return <input ref={ref} type="checkbox" className={CHECKBOX_CLASS} checked={group.state === "all"} disabled={!group.free.length} aria-label={`whole org ${group.org}`} onChange={onToggle} />;
}

// The pill of a project row: already on this connection, no destination, or another one with the switch once checked.
function RowPill({ row, connection }: { row: LinkRow; connection: string }) {
  if (row.pill === "already") {
    return (
      <Pill tone="ok">
        <span className="max-sm:hidden">{`destination: ${connection}`}</span>
        <span className="sm:hidden">already linked</span>
      </Pill>
    );
  }
  if (row.pill === "none") return <Pill tone="off">{row.checked ? `no destination → ${connection}` : "no destination"}</Pill>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Pill tone="warn">{`destination: ${row.project.destination}`}</Pill>
      {row.switching && <span className="text-[#f0c674]">{`→ ${connection}`}</span>}
    </span>
  );
}

// One project of an org group: a checkbox, its name and its pill; locked when already linked.
function ProjectRow({ row, connection, hiddenOnPhone, onToggle }: { row: LinkRow; connection: string; hiddenOnPhone: boolean; onToggle: () => void }) {
  return (
    <label className={`grid grid-cols-[22px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2.5 border-t border-[#1b2030] px-3 py-2.5 max-sm:min-h-[46px] max-sm:grid-cols-[22px_minmax(0,1fr)] ${row.locked ? "text-muted" : ""} ${hiddenOnPhone ? "max-sm:hidden" : ""}`}>
      <input type="checkbox" className={CHECKBOX_CLASS} checked={row.checked} disabled={row.locked} onChange={onToggle} />
      <span className="truncate font-mono text-[13px]">{row.project.name}</span>
      <span className="flex justify-end text-sm max-sm:col-start-2 max-sm:justify-start">
        <RowPill row={row} connection={connection} />
      </span>
    </label>
  );
}

// One allowed org of the dialog: the whole-org header and its project rows, collapsed after three on a phone.
function OrgGroupBox({ group, connection, checked, setChecked }: { group: LinkGroup; connection: string; checked: Set<string>; setChecked: (next: Set<string>) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.rows.length - PHONE_VISIBLE;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2.5 bg-header px-3 py-2.5 text-[13px] max-sm:min-h-[46px]">
        <OrgCheckbox group={group} onToggle={() => setChecked(toggledOrg(checked, group))} />
        <span className="font-medium">{`org ${group.org}`}</span>
        <span className="text-muted">{`· ${group.count} ${group.count === 1 ? "project" : "projects"}`}</span>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={!group.free.length} onClick={() => setChecked(toggledOrg(checked, group))}>
          {group.state === "all" ? "clear org" : "whole org"}
        </Button>
      </div>
      {group.rows.map((row, index) => (
        <ProjectRow key={row.project.id} row={row} connection={connection} hiddenOnPhone={!expanded && index >= PHONE_VISIBLE} onToggle={() => setChecked(toggledProject(checked, row.project.id))} />
      ))}
      {!expanded && hidden > 0 && (
        <div className="border-t border-[#1b2030] px-3 py-2.5 sm:hidden">
          <Button variant="ghost" className="min-h-10 w-full" onClick={() => setExpanded(true)}>
            {`Show the other ${hidden} in org ${group.org}`}
          </Button>
        </div>
      )}
    </div>
  );
}

// The dim line naming an org whose projects are not listed, with its one-click allow.
function NotAllowedLine({ org, connection }: { org: string; connection: string }) {
  const refresh = useRefreshIntegrations();
  const allow = useMutation({
    mutationFn: () => allowOrg(connection, org),
    onSuccess: () => showToast(`${connection} allowed for ${org}`, "success"),
    onError: (err) => showToast(errorText(err), "error"),
    onSettled: refresh,
  });
  return (
    <div className="text-sm text-dim">
      Projects of org <span className="font-mono">{org}</span> are not listed: <span className="font-mono">{connection}</span> is not allowed for it.{" "}
      <button type="button" disabled={allow.isPending} onClick={() => allow.mutate()} className="text-link hover:underline disabled:opacity-50">
        {allow.isPending ? "Allowing…" : `Allow for ${org}`}
      </button>
    </div>
  );
}

// The connection select and the fixed event of the dialog.
function LinkHeader({ connections, selected, onSelect }: { connections: ConnectionRow[]; selected: ConnectionRow; onSelect: (name: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3.5 max-sm:grid-cols-1">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm text-muted">Connection</span>
        <select aria-label="connection" className={`${INPUT_CLASS} font-mono`} value={selected.name} onChange={(event) => onSelect(event.target.value)}>
          {connections.map((row) => (
            <option key={row.name} value={row.name}>
              {connectionLabel(row)}
            </option>
          ))}
        </select>
        <span className="text-sm text-dim">{`allowed for: ${selected.orgs.join(", ") || "no org"}`}</span>
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted">Event</span>
        <label className="flex min-h-[38px] items-center gap-2.5 rounded-md border border-line bg-header px-2.5 max-sm:min-h-[46px]">
          <input type="checkbox" className={CHECKBOX_CLASS} checked disabled aria-label="job closed" />
          <span>Job closed</span>
          <span className="ml-auto">
            <Pill tone="off">only one for now</Pill>
          </span>
        </label>
        <span className="text-sm text-dim">more events (gate, failure) come later</span>
      </div>
    </div>
  );
}

// The Link projects dialog: the allowed orgs' projects to check, the switch warning, and one batch link of the newly checked ones.
export function LinkProjectsDialog({ view, initial, onClose }: LinkProjectsDialogProps) {
  const refresh = useRefreshIntegrations();
  const connections = discordConnections(view).filter((row) => row.present);
  const [name, setName] = useState(initial);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const selected = connections.find((row) => row.name === name) ?? null;
  const plan = selected ? linkPlan(view, selected, checked) : null;
  const link = useMutation({
    mutationFn: (ids: string[]) => linkProjects(name, ids),
    onSuccess: (answer, ids) => {
      const count = Array.isArray(answer?.linked) ? answer.linked.length : ids.length;
      showToast(`Connection ${name} linked to ${count} ${count === 1 ? "project" : "projects"} · event job closed`, "success");
      onClose();
    },
    onError: (err) => showToast(errorText(err), "error"),
    onSettled: refresh,
  });
  const choose = (next: string) => {
    setName(next);
    setChecked(new Set());
  };
  const count = plan?.newIds.length ?? 0;
  const footer = (
    <>
      <Button variant="primary" className="max-sm:min-h-[46px] max-sm:w-full" disabled={!count || link.isPending} onClick={() => plan && link.mutate(plan.newIds)}>
        {link.isPending ? "Linking…" : linkCta(count)}
      </Button>
      <Button variant="ghost" className="max-sm:hidden" onClick={onClose}>
        Cancel
      </Button>
      <span className="ml-auto text-sm text-muted max-sm:ml-0 max-sm:text-center">{`${plan?.alreadyCount ?? 0} already linked · unchanged`}</span>
    </>
  );
  return (
    <SettingsDialog title="Link projects" label="Link projects" width="wide" phone="full" onClose={onClose} footer={footer}>
      {!selected || !plan ? (
        <Note tone="warn" icon="⚠">
          <span>
            The Discord connection <span className="font-mono">{name}</span> is not in the list yet. Wait for the list to refresh, or close and pick it again.
          </span>
        </Note>
      ) : (
        <>
          <LinkHeader connections={connections} selected={selected} onSelect={choose} />
          <div className="text-sm text-muted">
            Only projects of the allowed orgs are listed. A project has one destination: linking here <strong className="text-[#f0c674]">replaces</strong> the current one.
          </div>
          {plan.groups.map((group) => (
            <OrgGroupBox key={group.org} group={group} connection={selected.name} checked={checked} setChecked={setChecked} />
          ))}
          {plan.notAllowed.map((org) => (
            <NotAllowedLine key={org} org={org} connection={selected.name} />
          ))}
          {plan.switching.length > 0 && (
            <Note tone="warn" icon="⚠" role="status">
              <span>
                {`${plan.switching.length} project(s) already have a destination and will switch to `}
                <span className="font-mono">{selected.name}</span>
                {`: ${plan.switching.join(", ")}. The old channel stops getting their notices.`}
              </span>
            </Note>
          )}
        </>
      )}
    </SettingsDialog>
  );
}
