import { useSyncExternalStore } from "react";

export interface DockState {
  open: boolean;
  activeId: string | null;
  height: number;
}

const HEIGHT_KEY = "nq.studio.dock.height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
const MAX_SHARE = 0.8;

const listeners = new Set<() => void>();
let state: DockState = { open: false, activeId: null, height: readSavedHeight() };

// Bounds a dock height between the minimum and 80 % of the viewport; a non-finite value falls back to the default.
export function clampHeight(height: number): number {
  const max = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * MAX_SHARE));
  const value = Number.isFinite(height) ? height : DEFAULT_HEIGHT;
  return Math.min(Math.max(Math.round(value), MIN_HEIGHT), max);
}

// The dock height saved by an earlier visit, the default when none is saved or it is unreadable.
function readSavedHeight(): number {
  try {
    const saved = window.localStorage.getItem(HEIGHT_KEY);
    return clampHeight(saved === null ? DEFAULT_HEIGHT : Number(saved));
  } catch {
    return DEFAULT_HEIGHT;
  }
}

// Replaces the dock state and tells every subscriber.
function update(next: Partial<DockState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

// Opens the dock on one terminal's tab.
export function focusTab(id: string) {
  update({ open: true, activeId: id });
}

// Opens the dock on the tab it last showed.
export function showDock() {
  update({ open: true });
}

// Hides the dock; its terminals keep running.
export function hideDock() {
  update({ open: false });
}

// Changes the dock height while it is dragged, without saving it.
export function resizeDock(height: number) {
  update({ height: clampHeight(height) });
}

// Saves the current dock height for the next visit; a storage failure only loses the preference.
export function saveDockHeight() {
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(state.height));
  } catch {
    return;
  }
}

// Subscribes a component to the dock state.
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The dock state right now: open or hidden, the active tab and the height.
export function useDock(): DockState {
  return useSyncExternalStore(subscribe, () => state);
}
