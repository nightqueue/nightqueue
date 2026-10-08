import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { ActionIcon } from "../../StatusIcon";

export type TagTone = "plain" | "green" | "accent" | "red" | "blue";

const TAG_TONES: Record<TagTone, string> = {
  plain: "border-line text-muted",
  green: "border-run-line text-green",
  accent: "border-run-line text-accent",
  red: "border-tag-red-line text-red",
  blue: "border-tag-blue-line text-link",
};

// A small bordered tag of the log tree: a phase state, a block kind or a report name.
export function LogTag({ tone = "plain", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`flex-none rounded-[3px] border px-[5px] font-sans text-[10px] leading-[14px] whitespace-nowrap ${TAG_TONES[tone]}`}>{children}</span>;
}

// The chevron of a collapsible row, turned down while open.
export function Chevron({ open }: { open: boolean }) {
  return <ActionIcon icon={ChevronRight} size={12} className={`text-dim transition-transform ${open ? "rotate-90" : ""}`} />;
}

// The blinking cursor after the last line of a running job.
export function LogCursor() {
  return <span className="ml-1 inline-block h-[13px] w-[7px] animate-blink bg-accent align-[-2px]" aria-hidden="true" />;
}

// The cyan rule a subagent lane's lines sit under.
export function LaneRule({ children }: { children: ReactNode }) {
  return <div className="ml-3 border-l-2 border-lane-rule pl-3">{children}</div>;
}
