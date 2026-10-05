import { useSyncExternalStore } from "react";

export interface TerminalFallback {
  reason: string;
  command: string;
}

let fallback: TerminalFallback | null = null;
const listeners = new Set<() => void>();

// Tells every subscribed host that the fallback changed.
function emit() {
  for (const listener of listeners) listener();
}

// Shows the "terminal unavailable" dialog with the command to run by hand.
export function showTerminalFallback(next: TerminalFallback) {
  fallback = next;
  emit();
}

// Closes the "terminal unavailable" dialog.
export function dismissTerminalFallback() {
  fallback = null;
  emit();
}

// Subscribes a component to the fallback dialog.
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The fallback on screen right now, or null.
export function useTerminalFallback(): TerminalFallback | null {
  return useSyncExternalStore(subscribe, () => fallback);
}
