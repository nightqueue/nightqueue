import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

const TOAST_MS = 6000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

// Tells every subscribed host that the list of toasts changed.
function emit() {
  for (const listener of listeners) listener();
}

// Removes one toast from the screen.
export function dismissToast(id: number) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

// Shows one toast for a few seconds; an info toast is a fact, never an error.
export function showToast(text: string, tone: ToastTone = "info") {
  const toast = { id: nextId++, tone, text };
  toasts = [...toasts, toast];
  emit();
  window.setTimeout(() => dismissToast(toast.id), TOAST_MS);
}

// Subscribes a component to the list of toasts.
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The toasts on screen right now.
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
