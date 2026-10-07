import { useSyncExternalStore } from "react";
import { clampDockWidth, DEFAULT_WIDTH } from "./dock-geometry";

export interface DockState {
  open: boolean;
  activeId: string | null;
  width: number;
}

const WIDTH_KEY = "nq.studio.dock.width";
const OPEN_KEY = "nq.studio.dock.open";

const listeners = new Set<() => void>();
let preferred = readSavedWidth();
let state: DockState = { open: readSavedOpen(), activeId: null, width: clampWidth(preferred) };

// Bounds a dock width to the current viewport.
export function clampWidth(width: number): number {
  return clampDockWidth(width, window.innerWidth);
}

// Reads one saved preference, null when none is saved or storage is unreadable.
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Saves one preference; a storage failure only loses the preference.
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

// The dock width chosen on an earlier visit, unbounded by this viewport; the default when none is saved or it is unreadable.
function readSavedWidth(): number {
  const saved = Number(readStored(WIDTH_KEY) ?? DEFAULT_WIDTH);
  return Number.isFinite(saved) ? saved : DEFAULT_WIDTH;
}

// Whether the dock was left open by an earlier visit.
function readSavedOpen(): boolean {
  return readStored(OPEN_KEY) === "true";
}

// Replaces the dock state and tells every subscriber.
function update(next: Partial<DockState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

// Changes the open state and saves it for the next visit.
function setOpen(open: boolean, next: Partial<DockState> = {}) {
  update({ ...next, open });
  writeStored(OPEN_KEY, String(open));
}

// Opens the dock on one terminal's tab.
export function focusTab(id: string) {
  setOpen(true, { activeId: id });
}

// Opens the dock on the tab it last showed.
export function showDock() {
  setOpen(true);
}

// Hides the dock; its terminals keep running.
export function hideDock() {
  setOpen(false);
}

// Changes the dock width while it is dragged, without saving it.
export function resizeDock(width: number) {
  preferred = clampWidth(width);
  update({ width: preferred });
}

// Saves the width the user chose for the next visit, never a bound the window imposed.
export function saveDockWidth() {
  writeStored(WIDTH_KEY, String(preferred));
}

// Re-bounds the chosen width to the resized window, telling subscribers only when the rendered width changes.
function fitDockToWindow() {
  const width = clampWidth(preferred);
  if (width !== state.width) update({ width });
}

// Subscribes a component to the dock state; the first subscriber starts watching the window size, the last one stops it.
function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("resize", fitDockToWindow);
    fitDockToWindow();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("resize", fitDockToWindow);
  };
}

// The dock state right now: open or hidden, the active tab and the width.
export function useDock(): DockState {
  return useSyncExternalStore(subscribe, () => state);
}
