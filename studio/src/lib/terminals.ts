import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { errorText } from "./actions";
import { ApiError, deleteJson, getJson, postJson } from "./api";
import { focusTab } from "./dock";
import { disposeController, disposeControllersExcept, onTerminalSocketClosed } from "./terminalController";
import { showTerminalFallback } from "./terminalUnavailable";
import { showToast } from "./toast";
import type { JobStatus, TerminalCreated, TerminalInfo, TerminalRequest, TerminalsAnswer } from "./types";

export const TERMINALS_KEY = ["terminals"] as const;

export const TERMINAL_SESSION_STATUSES: readonly JobStatus[] = ["gate", "failed", "done", "cancelled"];

const REFRESH_MS = 5000;

const SESSION_BLOCK_REASONS: Partial<Record<JobStatus, string>> = {
  running: "the runner owns this session while the job runs",
  pending: "the job has not run yet",
  closed: "a closed job is not resumed from the studio; copy the session command",
};

// Tells whether one listing entry has the fields a tab needs.
function isTerminalInfo(entry: unknown): entry is TerminalInfo {
  const value = entry as Partial<TerminalInfo> | null;
  return typeof value?.id === "string" && typeof value?.label === "string" && (value?.kind === "session" || value?.kind === "operator");
}

// Reads the terminal listing, keeping only the well-formed entries.
async function fetchTerminals(): Promise<TerminalsAnswer> {
  const body = await getJson<Partial<TerminalsAnswer> | null>("/api/terminals");
  return {
    available: body?.available === true,
    reason: typeof body?.reason === "string" ? body.reason : null,
    cap: Number.isFinite(body?.cap) ? Number(body?.cap) : 0,
    instruction_max: Number.isFinite(body?.instruction_max) ? Number(body?.instruction_max) : 0,
    terminals: Array.isArray(body?.terminals) ? body.terminals.filter(isTerminalInfo) : [],
  };
}

// The terminals the studio holds, refreshed every few seconds and whenever one's websocket closes; controllers of vanished terminals are freed.
export function useTerminals() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: TERMINALS_KEY, queryFn: fetchTerminals, refetchInterval: REFRESH_MS });
  useEffect(() => onTerminalSocketClosed(() => void queryClient.invalidateQueries({ queryKey: TERMINALS_KEY })), [queryClient]);
  const terminals = query.data?.terminals;
  useEffect(() => {
    if (terminals) disposeControllersExcept(new Set(terminals.map((terminal) => terminal.id)));
  }, [terminals]);
  return query;
}

// Opens a terminal (or reuses a job's live session) and shows its tab in the dock.
export function useOpenTerminal() {
  const queryClient = useQueryClient();
  return useCallback(
    async (request: TerminalRequest): Promise<TerminalCreated> => {
      const created = await postJson<TerminalCreated>("/api/terminals", request);
      if (typeof created?.terminal?.id !== "string") throw new Error("the studio answered a terminal without an id");
      await queryClient.invalidateQueries({ queryKey: TERMINALS_KEY });
      focusTab(created.terminal.id);
      return created;
    },
    [queryClient],
  );
}

// The command a terminal request runs by hand when the studio cannot embed it.
export function fallbackCommand(request: TerminalRequest): string {
  return request.kind === "session" ? `nightqueue queue session ${request.job}` : `nightqueue open ${request.project}`;
}

// Opens a terminal from an entry point: the copy-the-command fallback when the studio cannot embed one, a toast on any other refusal, the full page when already on one.
export function useLaunchTerminal() {
  const queryClient = useQueryClient();
  const openTerminal = useOpenTerminal();
  const navigate = useNavigate();
  const onTerminalPage = useRouterState({ select: (state) => state.location.pathname.startsWith("/terminal/") });
  return useCallback(
    async (request: TerminalRequest): Promise<void> => {
      const listing = queryClient.getQueryData<TerminalsAnswer>(TERMINALS_KEY);
      if (listing && !listing.available) {
        showTerminalFallback({ reason: listing.reason ?? "node-pty is not loaded", command: fallbackCommand(request) });
        return;
      }
      try {
        const created = await openTerminal(request);
        if (onTerminalPage) await navigate({ to: "/terminal/$id", params: { id: created.terminal.id } });
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) showTerminalFallback({ reason: err.message, command: fallbackCommand(request) });
        else showToast(`The terminal was not opened: ${errorText(err)}`, "error");
      }
    },
    [queryClient, openTerminal, navigate, onTerminalPage],
  );
}

// Ends a terminal on the server and frees its tab; on a failure the listing is refreshed and the error goes to the caller.
export function useCloseTerminal() {
  const queryClient = useQueryClient();
  return useCallback(
    async (id: string) => {
      try {
        await deleteJson<{ id: string; ended: boolean }>(`/api/terminals/${id}`);
        disposeController(id);
      } finally {
        await queryClient.invalidateQueries({ queryKey: TERMINALS_KEY });
      }
    },
    [queryClient],
  );
}

// Why a job's session cannot be resumed in a terminal, null when its status allows it.
export function sessionBlockReason(status: JobStatus): string | null {
  if (TERMINAL_SESSION_STATUSES.includes(status)) return null;
  return SESSION_BLOCK_REASONS[status] ?? `a ${status} job is not resumed from the studio`;
}

// The line a tab shows once its process exited.
export function exitText(terminal: TerminalInfo): string | null {
  if (!terminal.exited) return null;
  const detail = terminal.exited.code ?? terminal.exited.signal ?? "?";
  return `process exited (${detail})`;
}
