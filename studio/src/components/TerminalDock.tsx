import { Link, useRouterState } from "@tanstack/react-router";
import type { PointerEvent } from "react";
import { focusTab, hideDock, resizeDock, saveDockHeight, showDock, useDock } from "../lib/dock";
import { exitText, useTerminals } from "../lib/terminals";
import type { TerminalInfo } from "../lib/types";
import { TerminalCloseButton } from "./TerminalCloseButton";
import { TerminalView } from "./TerminalView";
import { Button } from "./ui";

// The strip on the dock's top edge that resizes it while dragged and saves the height on release.
function DockResizeHandle() {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeDock(window.innerHeight - event.clientY);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    saveDockHeight();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal dock"
      className="h-1.5 shrink-0 cursor-row-resize touch-none bg-line hover:bg-run-line"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

// One tab of the dock: the terminal's label, its exit line when it ended, and its ×.
function DockTab({ terminal, active }: { terminal: TerminalInfo; active: boolean }) {
  const exited = exitText(terminal);
  return (
    <div className={`flex shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-sm ${active ? "border-line bg-bg text-fg" : "border-transparent text-muted"}`}>
      <button type="button" aria-pressed={active} onClick={() => focusTab(terminal.id)} className="max-w-[220px] truncate font-mono" title={terminal.note ?? terminal.cwd}>
        {terminal.label}
        {exited && <span className="ml-1.5 text-dim">· {exited}</span>}
      </button>
      <TerminalCloseButton terminal={terminal} />
    </div>
  );
}

// The dock's top bar: the tabs, scrolling sideways on a narrow screen, then the full-page and hide buttons.
function DockBar({ terminals, active }: { terminals: TerminalInfo[]; active: TerminalInfo }) {
  return (
    <div className="flex shrink-0 items-end gap-2 border-b border-line bg-header px-2 pt-1.5">
      <div className="flex min-w-0 grow gap-1 overflow-x-auto" aria-label="Terminals">
        {terminals.map((terminal) => (
          <DockTab key={terminal.id} terminal={terminal} active={terminal.id === active.id} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1 pb-1">
        <Link to="/terminal/$id" params={{ id: active.id }} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-button hover:text-fg" title="Open this terminal on its own page">
          Full page
        </Link>
        <Button size="sm" variant="ghost" onClick={hideDock} title="Hide the dock; the terminals keep running">
          Hide
        </Button>
      </div>
    </div>
  );
}

// The button that brings a hidden dock back, with the count of its terminals.
function DockReopenButton({ count }: { count: number }) {
  return (
    <button type="button" onClick={showDock} className="fixed bottom-4 left-4 z-30 rounded-md border border-run-line bg-surface px-3 py-1.5 font-mono text-sm text-accent shadow-lg hover:bg-button">
      Terminals ({count})
    </button>
  );
}

// The dock state with the listed terminals, and whether the dock has nothing to show (no terminal, or the full-page terminal is on screen).
function useDockView() {
  const dock = useDock();
  const onTerminalPage = useRouterState({ select: (state) => state.location.pathname.startsWith("/terminal/") });
  const terminals = useTerminals().data?.terminals ?? [];
  return { dock, terminals, absent: onTerminalPage || terminals.length === 0 };
}

// The dock at the bottom of every page but the full-page terminal: tabs of the studio's terminals over the active one, resizable, hidden without ending anything.
export function TerminalDock() {
  const { dock, terminals, absent } = useDockView();
  if (absent) return null;
  if (!dock.open) return <DockReopenButton count={terminals.length} />;
  const active = terminals.find((terminal) => terminal.id === dock.activeId) ?? terminals[0];
  return (
    <section aria-label="Terminal dock" className="fixed inset-x-0 bottom-0 z-30 flex max-h-[80vh] flex-col border-t border-line bg-bg shadow-[0_-10px_30px_rgba(0,0,0,.4)]" style={{ height: dock.height }}>
      <DockResizeHandle />
      <DockBar terminals={terminals} active={active} />
      <div className="min-h-0 grow">
        <TerminalView key={active.id} terminal={active} />
      </div>
    </section>
  );
}

// The bottom padding the page keeps so the open dock never covers its end.
export function useDockPadding(): number {
  const { dock, absent } = useDockView();
  return dock.open && !absent ? dock.height : 0;
}
