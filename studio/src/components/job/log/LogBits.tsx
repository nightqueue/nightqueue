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

// The line standing for the tool calls a long run folded away.
export function MoreToolsRow({ count }: { count: number }) {
  return (
    <div className="flex gap-2 px-3 py-px text-log-dim">
      <span className="w-[52px] flex-none" />
      <span className="w-3 flex-none">·</span>
      <span>{`… ${count} more tools`}</span>
    </div>
  );
}
