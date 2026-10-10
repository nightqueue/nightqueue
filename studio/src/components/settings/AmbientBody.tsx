import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ambientLine, ambientTool } from "../../lib/integrations";
import { onTerminalSocketClosed } from "../../lib/terminalController";
import { terminalEnded, useTerminals } from "../../lib/terminals";
import type { AmbientStatus, ModuleCard } from "../../lib/types";
import { ambientStatusKey, useAmbientStatus } from "../../lib/useIntegrations";
import { TerminalLaunchButton } from "../TerminalLaunchButton";
import { Bar, Pill } from "./bits";

// Refreshes a module's machine status once the connect terminal it launched ends: its socket closed, or the listing shows it exited or gone.
function useRefreshOnTerminalEnd(kind: string, launched: string | null, clear: () => void) {
  const queryClient = useQueryClient();
  const terminals = useTerminals().data?.terminals;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!launched) return undefined;
    const refresh = () => {
      clear();
      void queryClient.invalidateQueries({ queryKey: ambientStatusKey(kind) });
    };
    if (terminals?.some((terminal) => terminal.id === launched)) seen.current = launched;
    if (terminals && seen.current === launched && terminalEnded(terminals, launched)) {
      refresh();
      return undefined;
    }
    return onTerminalSocketClosed((id) => {
      if (id === launched) refresh();
    });
  }, [kind, launched, terminals, clear, queryClient]);
}

// Why the connect button is disabled, or null when it can run.
function connectBlockedReason(status: AmbientStatus | undefined, tool: string): string | null {
  return status?.installed === false ? `${tool} is not installed` : null;
}

// The status pill of an ambient module: checking, connected, or not.
function AmbientPill({ status, failed, tool }: { status: AmbientStatus | undefined; failed: boolean; tool: string }) {
  if (failed) return <Pill tone="err">status unavailable</Pill>;
  if (!status) return <Bar className="h-5 w-[180px] rounded-full" />;
  return <Pill tone={status.authenticated ? "ok" : "warn"}>{ambientLine(status, tool)}</Pill>;
}

// The body of a module the machine is logged into: its live status and a Connect or Reconnect in the embedded terminal.
export function AmbientBody({ module }: { module: ModuleCard }) {
  const status = useAmbientStatus(module);
  const [launched, setLaunched] = useState<string | null>(null);
  const clear = useCallback(() => setLaunched(null), []);
  useRefreshOnTerminalEnd(module.kind, launched, clear);
  const tool = ambientTool(module);
  const data = status.data;
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <AmbientPill status={data} failed={status.isError} tool={tool} />
      {module.ambient?.command && <span className="font-mono text-sm text-dim max-sm:hidden">{module.ambient.command}</span>}
      <TerminalLaunchButton
        size="sm"
        className="ml-auto max-lg:min-h-10"
        request={{ kind: "connect", provider: module.kind }}
        blockedReason={connectBlockedReason(data, tool)}
        fallback={module.ambient?.command ?? null}
        title={`Run ${module.ambient?.command ?? "the login"} in a studio terminal`}
        onLaunched={setLaunched}
      >
        {data?.authenticated ? "Reconnect" : "Connect"}
      </TerminalLaunchButton>
    </div>
  );
}
