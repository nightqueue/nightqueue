import { useMutation } from "@tanstack/react-query";
import { KeyRound, Send } from "lucide-react";
import { errorText } from "../../lib/actions";
import { isDiscord, remainingOrgs, typeLabel, typeLine, usedByNames, webhookLine } from "../../lib/integrations";
import { showToast } from "../../lib/toast";
import type { ConnectionRow as Row, IntegrationsView, LastTest } from "../../lib/types";
import { testConnection, useRefreshIntegrations } from "../../lib/useIntegrations";
import { Button } from "../ui";
import { ColumnLabel, Pill } from "./bits";
import { LastTestPill } from "./LastTestPill";
import { OrgChips } from "./OrgChips";

export interface ConnectionHandlers {
  onLink: (row: Row) => void;
  onRemove: (row: Row) => void;
  onAllowOrg: (row: Row, org: string) => void;
  onRemoveOrg: (row: Row, org: string) => void;
}

interface ConnectionRowProps {
  row: Row;
  view: IntegrationsView;
  handlers: ConnectionHandlers;
}

const USAGE_TEXT: Record<string, string> = {
  linear: "source of tracker tickets for jobs",
  sentry: "error issues of the projects of its orgs",
};

const PHONE_BUTTON = "max-lg:min-h-10 max-lg:text-[13px]";

// Says how a test went, in a toast.
function announceTest(name: string, result: LastTest) {
  if (result.ok) showToast(`${name}: test ok`, "success");
  else showToast(`${name}: test failed${result.reason ? ` — ${result.reason}` : ""}`, "error");
}

// The type line of a connection: its icon, service and secret kind.
function TypeLine({ type }: { type: string }) {
  const Icon = isDiscord({ type }) ? Send : KeyRound;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
      <Icon size={14} aria-hidden="true" />
      {typeLine(type)}
    </span>
  );
}

// What a row knows of its target: webhook and short ids for Discord, a missing secret in red.
function TargetLine({ row }: { row: Row }) {
  if (!row.present) return <Pill tone="err">secret missing</Pill>;
  if (!isDiscord(row)) return null;
  const line = webhookLine(row);
  return (
    <div className="font-mono text-sm break-words text-muted" title={line.title}>
      {line.text}
    </div>
  );
}

// The projects a connection serves: their names for Discord, what it is used for otherwise.
function UsedBy({ row, view }: { row: Row; view: IntegrationsView }) {
  if (!isDiscord(row)) return <div className="text-sm text-muted">{USAGE_TEXT[row.type] ?? "the projects of its orgs"}</div>;
  const names = usedByNames(view, row);
  if (!names.length) return <div className="text-sm text-dim">no project yet</div>;
  return <div className="text-sm leading-[1.6] break-words text-log">{names.join(" · ")}</div>;
}

// The Test button, `Test again` after a failure, with its own busy state.
function TestButton({ row, className = "" }: { row: Row; className?: string }) {
  const refresh = useRefreshIntegrations();
  const test = useMutation({
    mutationFn: () => testConnection(row.name),
    onSuccess: (result) => announceTest(row.name, result),
    onError: (err) => showToast(errorText(err), "error"),
    onSettled: refresh,
  });
  const label = row.lastTest && !row.lastTest.ok ? "Test again" : "Test";
  return (
    <Button size="sm" className={className} disabled={!row.present || test.isPending} title={row.present ? undefined : "the secret is missing"} onClick={() => test.mutate()}>
      {test.isPending ? "Testing…" : label}
    </Button>
  );
}

// The actions of a connection: Test, Link projects for Discord, and Remove.
function ConnectionButtons({ row, handlers, phone = false }: { row: Row; handlers: ConnectionHandlers; phone?: boolean }) {
  const extra = phone ? PHONE_BUTTON : "";
  return (
    <>
      <TestButton row={row} className={extra} />
      {isDiscord(row) && (
        <Button size="sm" className={extra} disabled={!row.present} onClick={() => handlers.onLink(row)}>
          {phone ? "Link" : "Link projects"}
        </Button>
      )}
      <Button size="sm" variant="danger" className={extra} onClick={() => handlers.onRemove(row)}>
        Remove
      </Button>
    </>
  );
}

// The allowed orgs of a row wired to its handlers.
function RowOrgs({ row, view, handlers }: ConnectionRowProps) {
  return <OrgChips row={row} remaining={remainingOrgs(view, row)} onAllow={(org) => handlers.onAllowOrg(row, org)} onRemove={(org) => handlers.onRemoveOrg(row, org)} />;
}

// One connection on a desktop: the five columns of the design's grid.
function DesktopRow({ row, view, handlers }: ConnectionRowProps) {
  return (
    <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,.9fr)_minmax(0,1.1fr)_minmax(0,1.25fr)_auto] items-start gap-4 border-t border-line px-4 py-3.5 first:border-t-0 max-lg:hidden">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="font-mono text-[14px] font-medium break-words">{row.name}</div>
        <TypeLine type={row.type} />
        <TargetLine row={row} />
      </div>
      <div className="flex flex-col gap-1.5">
        <ColumnLabel>Allowed orgs</ColumnLabel>
        <RowOrgs row={row} view={view} handlers={handlers} />
      </div>
      <div className="flex flex-col gap-1.5">
        <ColumnLabel>Last test</ColumnLabel>
        <LastTestPill lastTest={row.lastTest} />
        {isDiscord(row) && row.lastTest?.ok !== false && <div className="text-sm text-dim">event: job closed</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <ColumnLabel>{`Used by ${row.usedBy.length} ${row.usedBy.length === 1 ? "project" : "projects"}`}</ColumnLabel>
        <UsedBy row={row} view={view} />
      </div>
      <div className="flex shrink-0 gap-1.5">
        <ConnectionButtons row={row} handlers={handlers} />
      </div>
    </div>
  );
}

// The orgs and project count of a non-Discord connection on a phone, in one line.
function scopeLine(row: Row): string {
  const orgs = row.scope === "home" ? "all orgs" : row.orgs.length ? `org ${row.orgs.join(", ")}` : "no org";
  return `${orgs} · ${row.usedBy.length} ${row.usedBy.length === 1 ? "project" : "projects"}`;
}

// The key/value grid of a Discord connection on a phone: channel, orgs and projects.
function PhoneDetails({ row, view, handlers }: ConnectionRowProps) {
  const names = usedByNames(view, row);
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13px]">
      <span className="text-muted">channel</span>
      <TargetLine row={row} />
      <span className="text-muted">orgs</span>
      <RowOrgs row={row} view={view} handlers={handlers} />
      <span className="text-muted">projects</span>
      <span className="break-words">{names.length ? `${names.length} — ${names.join(", ")}` : "none yet"}</span>
    </div>
  );
}

// One connection on a phone: a card with its status, details and equal buttons.
function PhoneCard({ row, view, handlers }: ConnectionRowProps) {
  const failed = row.lastTest?.ok === false;
  const discord = isDiscord(row);
  return (
    <section aria-label={`connection ${row.name}`} className={`flex flex-col gap-2.5 rounded-lg border bg-surface p-3.5 lg:hidden ${failed ? "border-tag-red-line" : "border-line"}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[15px] font-medium">{row.name}</span>
        <span className="text-sm text-muted">{typeLabel(row.type)}</span>
        <span className="ml-auto">
          <LastTestPill lastTest={row.lastTest} compact />
        </span>
      </div>
      {failed && row.lastTest?.reason && <div className="text-sm text-red">{row.lastTest.reason}</div>}
      {discord ? <PhoneDetails row={row} view={view} handlers={handlers} /> : <div className="text-sm text-muted">{scopeLine(row)}</div>}
      <div className={`grid gap-2 ${discord ? "grid-cols-3" : "grid-cols-2"}`}>
        <ConnectionButtons row={row} handlers={handlers} phone />
      </div>
    </section>
  );
}

// One connection of the list: the desktop row and the phone card, each shown at its width.
export function ConnectionRow(props: ConnectionRowProps) {
  return (
    <>
      <DesktopRow {...props} />
      <PhoneCard {...props} />
    </>
  );
}
