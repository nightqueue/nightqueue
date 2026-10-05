import { useQuery } from "@tanstack/react-query";
import type { Project, StudioInfo } from "./types";

// A failed call of the studio API, carrying the server's own message and the HTTP status.
export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

// The error message of a failed answer: the server's `{ error }` when it sent one, the status otherwise.
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  return `${response.status} ${response.statusText}`;
}

// Reads one JSON route of the studio API, throwing an ApiError with the server's message on failure.
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
  return (await response.json()) as T;
}

// Posts a JSON body to one route of the studio API, throwing an ApiError with the server's message on failure.
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
  return (await response.json()) as T;
}

// Deletes one resource of the studio API, throwing an ApiError with the server's message on failure.
export async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "DELETE", headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
  return (await response.json()) as T;
}

// The facts of the running studio: version, runtime, MCP endpoint and queue pause.
export function useStudioInfo() {
  return useQuery({ queryKey: ["info"], queryFn: () => getJson<StudioInfo>("/api/info"), staleTime: 60_000 });
}

// Reads the registered projects, an empty list when the answer carries none.
async function fetchProjects(): Promise<Project[]> {
  const body = await getJson<{ projects?: unknown }>("/api/projects");
  return Array.isArray(body?.projects) ? (body.projects as Project[]) : [];
}

// The projects registered in this home, for the project select of the queue and the add drawer.
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: 60_000 });
}
