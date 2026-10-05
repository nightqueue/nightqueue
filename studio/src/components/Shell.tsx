import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useProjects, useStudioInfo } from "../lib/api";
import { useQueueStream } from "../lib/events";
import { utcClock } from "../lib/format";
import { useMcpStatus } from "../lib/mcp";
import { ALL_PROJECTS } from "../lib/queue";
import { useSelectedProject } from "../lib/selectedProject";
import { dismissToast, useToasts, type ToastTone } from "../lib/toast";
import { useNow } from "../lib/useNow";
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

const TOAST_TONES: Record<ToastTone, string> = {
  info: "border-line text-fg",
  success: "border-run-line text-accent",
  error: "border-red-strong text-red",
};

// The toasts of the page, stacked in the bottom right corner.
function ToastHost() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className={`pointer-events-auto max-w-md rounded-md border bg-surface px-3 py-2 text-left text-sm shadow-lg ${TOAST_TONES[toast.tone]}`}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}

// The project the header's Operator opens, from the queue toolbar's select, or why there is none.
function useHeaderOperatorProject(): { name: string | null; blockedReason: string | null } {
  const projectId = useSelectedProject();
  const projects = useProjects();
  if (projectId === ALL_PROJECTS) return { name: null, blockedReason: "pick a project in the queue toolbar" };
  if (projects.isPending) return { name: null, blockedReason: "loading the projects" };
  if (projects.isError) return { name: null, blockedReason: "the projects cannot be read; reload the page" };
  const name = projects.data?.find((entry) => entry.id === projectId)?.name ?? null;
  return name ? { name, blockedReason: null } : { name: null, blockedReason: "this project is no longer registered" };
}

// The header's Operator: opens the operator of the queue toolbar's project in a terminal.
function HeaderOperatorButton() {
  const { name, blockedReason } = useHeaderOperatorProject();
  return (
    <TerminalLaunchButton size="sm" variant="run" request={name ? { kind: "operator", project: name } : null} blockedReason={blockedReason} title={name ? `Open the ${name} operator in a terminal` : undefined}>
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
    <div className="flex min-h-screen flex-col" style={dockPadding > 0 ? { paddingBottom: dockPadding } : undefined}>
      <Header />
      <main className="mx-auto box-border flex w-full max-w-[1280px] grow flex-col gap-4 px-4 pt-5 pb-8 sm:px-6">{children ?? <Outlet />}</main>
      <TerminalDock />
      <TerminalUnavailable />
      <ToastHost />
    </div>
  );
}
