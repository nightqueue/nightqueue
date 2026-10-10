import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { deleteJson, getJson, postJson, putJson } from "./api";
import { normalizeView } from "./integrations";
import type { AmbientStatus, ConnectionRow, IntegrationsView, LastTest, ModuleCard } from "./types";

export const INTEGRATIONS_KEY = ["integrations"] as const;

export const RETRY_MS = 8000;

const AMBIENT_STALE_MS = 30_000;

export interface AddWebhookInput {
  name: string;
  org: string;
  url: string;
}

export interface LinkAnswer {
  linked: string[];
  unchanged: string[];
}

// The path of one connection, its name escaped.
function connectionPath(name: string, suffix = ""): string {
  return `/api/integrations/${encodeURIComponent(name)}${suffix}`;
}

// Reads the Settings › Integrations view.
async function fetchIntegrations(): Promise<IntegrationsView> {
  return normalizeView(await getJson<unknown>("/api/integrations"));
}

// The connections and project destinations, retried every 8 s while the runtime does not answer.
export function useIntegrations() {
  return useQuery({
    queryKey: INTEGRATIONS_KEY,
    queryFn: fetchIntegrations,
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? RETRY_MS : false),
  });
}

// Refreshes the integrations view and the project list after a write, without blocking the caller.
export function useRefreshIntegrations(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  }, [queryClient]);
}

// Adds a Discord webhook: tested and announced by the runtime first; the URL is sent once and never read back.
export async function addWebhook(input: AddWebhookInput): Promise<ConnectionRow | null> {
  const answer = await postJson<{ connection?: ConnectionRow | null }>("/api/integrations/discord", input);
  return answer?.connection ?? null;
}

// Adds a connection of a module kind: tested by the runtime first; the secret is sent once and never read back.
export async function addConnectionOf(kind: string, body: Record<string, unknown>): Promise<ConnectionRow | null> {
  const answer = await postJson<{ connection?: ConnectionRow | null }>(`/api/integrations/${encodeURIComponent(kind)}`, body);
  return answer?.connection ?? null;
}

// The query key of an ambient module's machine status.
export function ambientStatusKey(kind: string) {
  return [...INTEGRATIONS_KEY, kind, "status"] as const;
}

// Reads the machine status of an ambient module, keeping only the known fields.
async function fetchAmbientStatus(path: string): Promise<AmbientStatus> {
  const body = await getJson<Partial<AmbientStatus> | null>(path);
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    kind: text(body?.kind) ?? "",
    installed: body?.installed !== false,
    authenticated: body?.authenticated === null ? null : body?.authenticated === true,
    login: text(body?.login),
    host: text(body?.host),
    checkedAt: text(body?.checkedAt),
  };
}

// The machine status of an ambient module, read on demand and kept for 30 s; disabled for a stored module.
export function useAmbientStatus(module: ModuleCard) {
  const path = module.ambient?.statusPath ?? "";
  return useQuery({
    queryKey: ambientStatusKey(module.kind),
    queryFn: () => fetchAmbientStatus(path),
    enabled: path !== "",
    staleTime: AMBIENT_STALE_MS,
    retry: false,
  });
}

// Tests one connection against its service; a failed test is an answer with `ok: false`.
export function testConnection(name: string): Promise<LastTest> {
  return postJson<LastTest>(connectionPath(name, "/test"));
}

// Allows a Discord connection for one more org.
export function allowOrg(name: string, org: string): Promise<unknown> {
  return postJson(connectionPath(name, "/orgs"), { org });
}

// Takes one org away from a Discord connection; `unlink` confirms unlinking that org's projects.
export function removeOrg(name: string, org: string, unlink: boolean): Promise<unknown> {
  return deleteJson(connectionPath(name, `/orgs/${encodeURIComponent(org)}${unlink ? "?unlink=1" : ""}`));
}

// Removes a connection; `unlink` confirms unlinking the projects that use it.
export function removeConnection(name: string, unlink: boolean): Promise<unknown> {
  return deleteJson(connectionPath(name, unlink ? "?unlink=1" : ""));
}

// Links many projects to a Discord connection, all of them or none.
export function linkProjects(name: string, projectIds: string[]): Promise<LinkAnswer> {
  return postJson<LinkAnswer>(connectionPath(name, "/link"), { projectIds });
}

// Sets the log destination of one project, or clears it with null.
export function setDestination(projectId: string, connectionId: string | null): Promise<unknown> {
  return putJson(`/api/projects/${encodeURIComponent(projectId)}/destination`, { connectionId });
}
