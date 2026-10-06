import { Ban, CircleCheck, CircleX, Clock, GitMerge, LoaderCircle, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";
import type { CloseState, JobStatus } from "../lib/types";

export const ICON_STROKE = 1.75;

export interface StatusVisual {
  Icon: LucideIcon;
  color: string;
  spin: boolean;
}

const STATUS_VISUAL: Record<JobStatus, StatusVisual> = {
  running: { Icon: LoaderCircle, color: "text-accent", spin: true },
  pending: { Icon: Clock, color: "text-muted", spin: false },
  gate: { Icon: TriangleAlert, color: "text-amber", spin: false },
  done: { Icon: CircleCheck, color: "text-green", spin: false },
  failed: { Icon: CircleX, color: "text-red", spin: false },
  cancelled: { Icon: Ban, color: "text-dim", spin: false },
  closed: { Icon: GitMerge, color: "text-pr-merged", spin: false },
};

const CLOSE_FAILED: StatusVisual = { Icon: OctagonX, color: "text-red", spin: false };
const CLOSING: StatusVisual = { Icon: LoaderCircle, color: "text-pr-merged", spin: true };

// The icon, colour and spin of a job: its close state first (failed or stalled, closing, closed), its status otherwise.
export function statusVisual(status: JobStatus, closeState: CloseState | null, closing: boolean): StatusVisual {
  if (closeState === "failed" || closeState === "stalled") return CLOSE_FAILED;
  if (closeState === "closing" || (closeState === null && closing)) return CLOSING;
  if (closeState === "closed") return STATUS_VISUAL.closed;
  return STATUS_VISUAL[status] ?? STATUS_VISUAL.pending;
}

// The status icon of a job, spinning inside its own box while it runs or closes.
export function StatusIcon({ status, closeState, closing, size = 14 }: { status: JobStatus; closeState: CloseState | null; closing: boolean; size?: number }) {
  const { Icon, color, spin } = statusVisual(status, closeState, closing);
  return <Icon size={size} strokeWidth={ICON_STROKE} aria-hidden="true" className={`shrink-0 ${color} ${spin ? "animate-spin" : ""}`} />;
}

// A Lucide icon for a button or a menu entry, at the shared stroke width.
export function ActionIcon({ icon: Icon, size = 14, className = "" }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Icon size={size} strokeWidth={ICON_STROKE} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
