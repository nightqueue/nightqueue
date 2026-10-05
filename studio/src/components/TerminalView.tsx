import { useEffect, useRef } from "react";
import { controllerFor, useConnection, type TerminalController } from "../lib/terminalController";
import { exitText } from "../lib/terminals";
import type { TerminalInfo } from "../lib/types";
import { Button } from "./ui";

const SKELETON_LINES = ["w-2/3", "w-1/2", "w-3/4", "w-1/3", "w-5/12"];

// The shape of a terminal while it connects: a dark pane with a few prompt-like lines.
export function TerminalSkeleton() {
  return (
    <div className="flex h-full w-full flex-col gap-2 bg-bg p-3" aria-label="connecting the terminal">
      {SKELETON_LINES.map((width, index) => (
        <span key={index} className={`h-3 animate-pulse rounded bg-row-line ${width}`} />
      ))}
    </div>
  );
}

// The pane of a terminal whose process ended: its exit line.
function ExitedPane({ terminal }: { terminal: TerminalInfo }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg p-4 text-center text-sm text-muted">
      {exitText(terminal)} — close the tab to remove it.
    </div>
  );
}

// The bar over a terminal whose websocket closed while its process still runs, with a reconnect button.
function ClosedBar({ controller, reason }: { controller: TerminalController; reason: string }) {
  return (
    <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 border-b border-line bg-surface px-3 py-1.5 text-sm text-muted">
      <span className="truncate">{reason}</span>
      <Button size="sm" variant="run" onClick={() => controller.reconnect()}>
        Reconnect
      </Button>
    </div>
  );
}

// A live terminal on screen: the shared controller is moved into this container and moved out on unmount, never disconnected.
function LiveTerminal({ id }: { id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = controllerFor(id);
  const connection = useConnection(controller);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    controller.attach(container);
    return () => controller.detach(container);
  }, [controller]);
  return (
    <div className="relative h-full w-full bg-bg">
      <div ref={containerRef} className="h-full w-full px-2 pt-1" />
      {connection.state === "connecting" && (
        <div className="absolute inset-0">
          <TerminalSkeleton />
        </div>
      )}
      {connection.state === "closed" && <ClosedBar controller={controller} reason={connection.reason} />}
    </div>
  );
}

// One terminal's pane: the live xterm while its process runs, the exit line once it ended.
export function TerminalView({ terminal }: { terminal: TerminalInfo }) {
  return terminal.exited ? <ExitedPane terminal={terminal} /> : <LiveTerminal id={terminal.id} />;
}
