import { Link, Outlet } from "@tanstack/react-router";
import { CircleCheck, CircleX, Info, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useStudioInfo } from "../lib/api";
import { useQueueStream } from "../lib/events";
import { utcClock } from "../lib/format";
import { useMcpStatus } from "../lib/mcp";
import { useOperatorRequest } from "../lib/operator";
import { dismissToast, useToasts, type ToastTone } from "../lib/toast";
import { useNow } from "../lib/useNow";
import { ActionIcon } from "./StatusIcon";
import { TerminalDock, useDockPadding } from "./TerminalDock";
import { TerminalLaunchButton } from "./TerminalLaunchButton";
import { TerminalUnavailable } from "./TerminalUnavailable";

// The logo: the accent dot, the product name and the muted `studio`.
function Logo() {
  return (
    <div className="flex items-center gap-2.5 font-semibold tracking-[.2px]">
      <span className="inline-block size-2.5 rounded-full bg-accent" />
      nightqueue <span className="font-normal text-muted">studio</span>
    </div>
  );
}

// One entry of the main navigation that is not built yet: dimmed, with the stage it lands in.
function SoonLink({ label, stage }: { label: string; stage: string }) {
  return (
    <span className="cursor-default rounded-md px-2.5 py-1.5 text-dim" aria-disabled="true">
      {label} <span className="text-[10px] text-dim">{stage}</span>
    </span>
  );
}

// The main navigation: Queue, and the screens of the later stages dimmed.
function Nav() {
  return (
    <nav className="ml-3 hidden gap-0.5 sm:flex">
      <Link to="/" className="rounded-md px-2.5 py-1.5 text-muted" activeProps={{ className: "bg-row-line !text-fg" }}>
        Queue
      </Link>
      <SoonLink label="Memory" stage="S2" />
      <SoonLink label="Home" stage="S3" />
      <SoonLink label="Doctor" stage="S3" />
    </nav>
  );
}

// The MCP endpoint and its tool count, with a green dot while it answers and a red one when it does not.
function McpStatus() {
  const status = useMcpStatus();
  if (status.isPending) return <span className="h-3 w-40 animate-pulse rounded bg-row-line" aria-label="checking MCP" />;
  const connected = status.isSuccess;
  return (
    <span className="whitespace-nowrap">
      <span className={`mr-1.5 inline-block size-2 rounded-full ${connected ? "bg-green" : "bg-red-strong"}`} />
      MCP {window.location.host}
      {connected ? ` · ${status.data.tools} tools` : " · unreachable"}
    </span>
  );
}

// The version of the runtime serving this studio, in mono.
function RuntimeVersion() {
  const info = useStudioInfo();
  if (info.isPending) return <span className="h-3 w-24 animate-pulse rounded bg-row-line" aria-label="loading version" />;
  if (info.isError) return <span className="text-red">version unknown</span>;
  const label = info.data.runtime ?? info.data.version;
  return (
    <span className="inline-block max-w-[220px] truncate align-bottom font-mono" title={label}>
      {label}
    </span>
  );
}

// The UTC wall clock, ticking.
function UtcClock() {
  const now = useNow(1000);
  return <span className="whitespace-nowrap">UTC {utcClock(now)}</span>;
}

const TOAST_TONES: Record<ToastTone, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: "border-line text-fg" },
  success: { icon: CircleCheck, className: "border-run-line text-accent" },
  error: { icon: CircleX, className: "border-red-strong text-red" },
};

// The toasts of the page, stacked in the bottom right corner.
function ToastHost() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => {
        const tone = TOAST_TONES[toast.tone] ?? TOAST_TONES.info;
        return (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismissToast(toast.id)}
            className={`pointer-events-auto inline-flex max-w-md items-start gap-2 rounded-md border bg-surface px-3 py-2 text-left text-sm shadow-lg ${tone.className}`}
          >
            <ActionIcon icon={tone.icon} className="mt-0.5" />
            {toast.text}
          </button>
        );
      })}
    </div>
  );
}

// The header's Operator: opens the operator in the nightqueue home, preselecting the queue toolbar's project when one is picked.
function HeaderOperatorButton() {
  const request = useOperatorRequest();
  return (
    <TerminalLaunchButton size="sm" variant="run" request={request} blockedReason={null} title={request.project ? `Open the operator (${request.project} preselected)` : "Open the operator"}>
      Operator
    </TerminalLaunchButton>
  );
}

// The header of every page: logo, navigation, Operator, MCP status, runtime version and clock.
function Header() {
  return (
    <header className="flex h-[52px] items-center gap-5 border-b border-line bg-header px-4 sm:px-6">
      <Logo />
      <Nav />
      <div className="ml-auto flex items-center gap-4 text-sm text-muted">
        <HeaderOperatorButton />
        <span className="hidden md:inline">
          <McpStatus />
        </span>
        <span className="hidden sm:inline">
          <RuntimeVersion />
        </span>
        <UtcClock />
      </div>
    </header>
  );
}

// The page layout around every route: header, the queue stream subscription, the routed screen, the terminal dock and the toasts.
export function Shell({ children }: { children?: ReactNode }) {
  useQueueStream();
  const dockPadding = useDockPadding();
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <div className="flex grow flex-col md:pl-[var(--dock-w)]" style={{ "--dock-w": `${dockPadding}px` } as CSSProperties}>
        <main className="mx-auto box-border flex w-full max-w-[1280px] grow flex-col gap-4 px-4 pt-5 pb-8 sm:px-6">{children ?? <Outlet />}</main>
      </div>
      <TerminalDock />
      <TerminalUnavailable />
      <ToastHost />
    </div>
  );
}
