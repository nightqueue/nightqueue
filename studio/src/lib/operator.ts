import { useProjects } from "./api";
import { ALL_PROJECTS } from "./queue";
import { useSelectedProject } from "./selectedProject";
import type { TerminalRequest } from "./types";

export type OperatorRequest = Extract<TerminalRequest, { kind: "operator" }>;

// The project the operator preselects, from the queue toolbar's select, or null when there is none to name.
function useOperatorProject(): string | null {
  const projectId = useSelectedProject();
  const projects = useProjects();
  if (projectId === ALL_PROJECTS || !projects.isSuccess || !Array.isArray(projects.data)) return null;
  return projects.data.find((entry) => entry.id === projectId)?.name ?? null;
}

// The operator terminal request: the selected project preselected, the nightqueue home when all projects are shown.
export function useOperatorRequest(): OperatorRequest {
  const name = useOperatorProject();
  return name ? { kind: "operator", project: name } : { kind: "operator" };
}
