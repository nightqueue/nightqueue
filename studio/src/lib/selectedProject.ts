import { useSyncExternalStore } from "react";
import { ALL_PROJECTS } from "./queue";

let selectedProjectId: string = ALL_PROJECTS;
const listeners = new Set<() => void>();

// Records the project the queue toolbar shows, so the header can open its operator.
export function setSelectedProject(projectId: string) {
  if (projectId === selectedProjectId) return;
  selectedProjectId = projectId;
  for (const listener of listeners) listener();
}

// Subscribes a component to the queue toolbar's project.
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The id of the project the queue toolbar shows, or ALL_PROJECTS.
export function useSelectedProject(): string {
  return useSyncExternalStore(subscribe, () => selectedProjectId);
}
