import { thousands } from "./format.ts";
import type { DiffKind } from "./types";

export const KIND_META: Record<DiffKind, { label: string; tone: string }> = {
  new: { label: "new file", tone: "text-green" },
  mod: { label: "modified", tone: "text-muted" },
  del: { label: "deleted", tone: "text-red" },
  ren: { label: "renamed", tone: "text-mem-decision" },
};

export type DrawerStep = { move: number } | { close: true } | null;

// A count usable in a sum or a bar: a finite positive number, else 0.
function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// A repo-relative path split into its directory (with the final slash) and its file name.
export function pathParts(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

// The `+1,234` and `−56` of a file's counts, each null when it is not counted or zero.
export function countsCell(file: { added?: number | null; deleted?: number | null }): { adds: string | null; dels: string | null } {
  const adds = positive(file.added);
  const dels = positive(file.deleted);
  return { adds: adds > 0 ? `+${thousands(adds)}` : null, dels: dels > 0 ? `−${thousands(dels)}` : null };
}

// The kind of one file, `new` for an untracked entry of a server that predates kinds.
export function fileKind(file: { kind?: DiffKind | null; untracked?: boolean }): DiffKind | null {
  if (file.kind && file.kind in KIND_META) return file.kind;
  return file.untracked === true ? "new" : null;
}

// The title of the files card with its count of changed files.
export function filesTitle(count: number): string {
  return `Files · ${thousands(count)} changed`;
}

// The pixel widths of the additions and deletions of a change in a bar of the given width, a gap between them only when both are drawn.
export function proportionBar(added: number | null | undefined, deleted: number | null | undefined, width = 120, gap = 2): { add: number; del: number } {
  const adds = positive(added);
  const dels = positive(deleted);
  if (adds === 0 && dels === 0) return { add: 0, del: 0 };
  if (dels === 0) return { add: width, del: 0 };
  if (adds === 0) return { add: 0, del: width };
  const room = width - gap;
  const add = Math.min(room - 1, Math.max(1, Math.round((room * adds) / (adds + dels))));
  return { add, del: room - add };
}

// What one key does in the file drawer: move to the previous or next file, close it, or nothing.
export function drawerStep(key: string, index: number, count: number): DrawerStep {
  if (key === "Escape") return { close: true };
  if (key === "ArrowUp") return index > 0 ? { move: index - 1 } : null;
  if (key === "ArrowDown") return index < count - 1 ? { move: index + 1 } : null;
  return null;
}
