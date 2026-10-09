import { useQuery } from "@tanstack/react-query";
import type { Project, StudioInfo } from "./types";

type ErrorBody = Record<string, unknown>;

// A failed call of the studio API, carrying the server's own message, the HTTP status and the parsed error body.
export class ApiError extends Error {
  readonly status: number | null;
  readonly body: ErrorBody | null;

  constructor(message: string, status: number | null = null, body: ErrorBody | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// The JSON object of a failed answer, or null when it sent none.
async function errorBody(response: Response): Promise<ErrorBody | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as ErrorBody) : null;
  } catch {
    return null;
  }
}

// The ApiError of a failed answer: the server's `{ error }` as message when it sent one, the status otherwise.
async function apiError(response: Response): Promise<ApiError> {
  const body = await errorBody(response);
  const message = typeof body?.error === "string" && body.error ? body.error : `${response.status} ${response.statusText}`;
  return new ApiError(message, response.status, body);
}

// Reads one JSON route of the studio API, throwing an ApiError with the server's message on failure.
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

// Reads one text route of the studio API, throwing an ApiError with the server's message on failure.
export async function getText(path: string): Promise<string> {
  const response = await fetch(path, { headers: { accept: "text/plain, text/markdown" }, credentials: "same-origin" });
  if (!response.ok) throw await apiError(response);
  return response.text();
}

// Sends a JSON body with one method to one route of the studio API, throwing an ApiError with the server's message on failure.
async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

// Posts a JSON body to one route of the studio API, throwing an ApiError with the server's message on failure.
export function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  return sendJson<T>("POST", path, body);
}

// Puts a JSON body on one route of the studio API, throwing an ApiError with the server's message on failure.
export function putJson<T>(path: string, body: unknown = {}): Promise<T> {
  return sendJson<T>("PUT", path, body);
}

// Deletes one resource of the studio API, throwing an ApiError with the server's message on failure.
export async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "DELETE", headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!response.ok) throw await apiError(response);
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
