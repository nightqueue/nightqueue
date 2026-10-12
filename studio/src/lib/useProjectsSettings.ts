import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { deleteJson, fetchProjectsAnswer, getJson, patchJson, postJson, PROJECTS_KEY } from "./api";
import { normalizeOrgs, normalizeProject, type ProjectPatch } from "./projects";
import type { DirListing, OrgRow, ProjectsAnswer, RepoFacts, SettingsProject } from "./types";
import { useDebounced } from "./useDebounced";
import { INTEGRATIONS_KEY, RETRY_MS } from "./useIntegrations";

export const ORGS_KEY = ["orgs"] as const;

const SUGGEST_DEBOUNCE_MS = 250;

export interface RegisterInput {
  path: string;
  name?: string;
  key?: string;
  org?: string;
}

export interface RegisterAnswer {
  project: SettingsProject | null;
  registeredFrom: string | null;
}

export interface PatchAnswer {
  project: SettingsProject | null;
  applied: string[];
  unlinked: string[];
}

export interface OrgPatch {
  name?: string;
  key?: string;
  isDefault?: true;
}

// The query string of one parameter, escaped.
function param(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

// The path of one project or org by id.
function itemPath(kind: "projects" | "orgs", id: string): string {
  return `/api/${kind}/${encodeURIComponent(id)}`;
}

// The projects with their facts and the providers' settings, retried every 8 s while the runtime does not answer.
export function useProjectsAnswer() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: fetchProjectsAnswer,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? RETRY_MS : false),
  });
}

// Reads the orgs of the home.
async function fetchOrgs(): Promise<OrgRow[]> {
  return normalizeOrgs(await getJson<unknown>("/api/orgs"));
}

// The orgs of the home, retried every 8 s while the runtime does not answer.
export function useOrgs() {
  return useQuery({
    queryKey: ORGS_KEY,
    queryFn: fetchOrgs,
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? RETRY_MS : false),
  });
}

// The folders of one directory inside the home; an empty path asks for the home itself.
export function useDirs(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["fs-dirs", path],
    queryFn: ({ signal }) => getJson<DirListing>(`/api/fs/dirs${path ? `?${param("path", path)}` : ""}`, signal),
    enabled,
    retry: false,
  });
}

// What registering one folder would do; idle until a folder is chosen.
export function useRepoFacts(path: string) {
  const settled = useDebounced(path.trim(), SUGGEST_DEBOUNCE_MS);
  return useQuery({
    queryKey: ["fs-repo", settled],
    queryFn: ({ signal }) => getJson<RepoFacts>(`/api/fs/repo?${param("path", settled)}`, signal),
    enabled: settled !== "",
    retry: false,
  });
}

// A free key suggested for a name as it is typed; idle while the name is empty.
export function useSuggestKey(kind: "project" | "org", name: string) {
  const settled = useDebounced(name.trim(), SUGGEST_DEBOUNCE_MS);
  return useQuery({
    queryKey: ["key-suggest", kind, settled],
    queryFn: ({ signal }) => getJson<{ key: string | null }>(`/api/keys/suggest?${param("kind", kind)}&${param("name", settled)}`, signal),
    enabled: settled !== "",
    retry: false,
    staleTime: 10_000,
  });
}

// Refreshes everything that shows projects or orgs after a write, without blocking the caller.
export function useRefreshProjects(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
    void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
  }, [queryClient]);
}

// Swaps one project row of the cached answer at once, so a new name or key shows before the refetch.
export function useSwapProjectRow(): (row: SettingsProject) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (row: SettingsProject) => {
      queryClient.setQueryData<ProjectsAnswer>(PROJECTS_KEY, (answer) => (answer ? { ...answer, projects: answer.projects.map((project) => (project.id === row.id ? row : project)) } : answer));
    },
    [queryClient],
  );
}

// Registers a git repository as a project, the way `nightqueue project add` does.
export async function registerProject(input: RegisterInput): Promise<RegisterAnswer> {
  const answer = await postJson<{ project?: unknown; registeredFrom?: unknown }>("/api/projects", input);
  return { project: normalizeProject(answer?.project), registeredFrom: typeof answer?.registeredFrom === "string" ? answer.registeredFrom : null };
}

// Applies an ordered PATCH to a project; a refused step throws with `{ step, reason, applied }` in its body.
export async function patchProject(id: string, patch: ProjectPatch): Promise<PatchAnswer> {
  const answer = await patchJson<{ project?: unknown; applied?: unknown; unlinked?: unknown }>(itemPath("projects", id), patch);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  return { project: normalizeProject(answer?.project), applied: strings(answer?.applied), unlinked: strings(answer?.unlinked) };
}

// Removes a project; `purge` also deletes every row it owns and its run directory.
export function removeProject(id: string, purge: boolean): Promise<unknown> {
  return deleteJson(`${itemPath("projects", id)}${purge ? "?purge=1" : ""}`);
}

// Creates an org under the key asked for, or the suggested one.
export function createOrg(name: string, key: string): Promise<unknown> {
  return postJson("/api/orgs", key ? { name, key } : { name });
}

// Renames an org, changes its key, or makes it the default one.
export function patchOrg(id: string, patch: OrgPatch): Promise<unknown> {
  return patchJson(itemPath("orgs", id), patch);
}

// Removes an empty org that is not the default one.
export function removeOrgById(id: string): Promise<unknown> {
  return deleteJson(itemPath("orgs", id));
}
