import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { focusTab } from "../lib/dock";
import { exitText, useTerminals } from "../lib/terminals";
import type { TerminalInfo } from "../lib/types";
import { TerminalCloseButton } from "../components/TerminalCloseButton";
import { TerminalSkeleton, TerminalView } from "../components/TerminalView";

const PANE_CLASS = "h-[calc(100vh-180px)] min-h-[240px] overflow-hidden rounded-lg border border-line";

// The frame of the full-page terminal: its title row with the way back to the dock, over the terminal pane.
function TerminalFrame({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 truncate font-mono text-base font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-2 text-sm">{actions}</div>
      </div>
      <div className={PANE_CLASS}>{children}</div>
    </section>
  );
}

// The title row actions of a known terminal: back to the dock on this tab, and its ×.
function TerminalActions({ terminal }: { terminal: TerminalInfo }) {
  const navigate = useNavigate();
  return (
    <>
      <Link to="/" onClick={() => focusTab(terminal.id)} className="rounded-md px-2 py-1 text-muted hover:bg-button hover:text-fg">
        Back to dock
      </Link>
      <TerminalCloseButton terminal={terminal} className="text-base" onClosed={() => void navigate({ to: "/" })} />
    </>
  );
}

// The full-page view of one terminal, sharing the dock's connection; an unknown id says so.
export function TerminalPage({ id }: { id: string }) {
  const listing = useTerminals();
  if (listing.isPending) {
    return (
      <TerminalFrame title={<span className="inline-block h-4 w-40 animate-pulse rounded bg-row-line align-middle" />}>
        <TerminalSkeleton />
      </TerminalFrame>
    );
  }
  if (listing.isError) {
    return (
      <TerminalFrame title="Terminal">
        <p className="p-4 text-red">could not read the terminals: {listing.error.message}</p>
      </TerminalFrame>
    );
  }
  const terminal = listing.data.terminals.find((entry) => entry.id === id);
  if (!terminal) {
    return (
      <TerminalFrame title="Terminal" actions={<Link to="/">Back to the queue</Link>}>
        <p className="p-4 text-muted">No terminal `{id}`: it was closed, or the studio restarted.</p>
      </TerminalFrame>
    );
  }
  const exited = exitText(terminal);
  return (
    <TerminalFrame title={exited ? `${terminal.label} · ${exited}` : terminal.label} actions={<TerminalActions terminal={terminal} />}>
      <TerminalView terminal={terminal} />
    </TerminalFrame>
  );
}
