import type { ReactNode } from "react";

export type PillTone = "ok" | "err" | "off" | "warn";

export type NoteTone = "info" | "err" | "ok" | "warn";

const PILL_TONES: Record<PillTone, string> = {
  ok: "bg-[#163a26] text-accent",
  err: "bg-[#4a1b1b] text-red",
  off: "bg-row-line text-muted",
  warn: "bg-[#3f2e0f] text-[#f0c674]",
};

const NOTE_TONES: Record<NoteTone, string> = {
  info: "border-[#2c3a5a] bg-[#141b2b] text-[#c7d6f5]",
  err: "border-[#5a2a2a] bg-[#2a1515] text-[#ffb3ad]",
  ok: "border-[#2f5a40] bg-[#12291c] text-[#b9e6c7]",
  warn: "border-[#5a4a1f] bg-[#2e2410] text-[#f0d79a]",
};

export const SELECT_CLASS =
  "min-h-[34px] rounded-md border border-button-line bg-header py-1.5 pr-7 pl-2.5 text-[13px] text-fg aria-[invalid=true]:border-gate-bar max-lg:min-h-11 max-lg:w-full max-lg:text-[14px]";

export const INPUT_CLASS =
  "box-border min-h-[38px] w-full rounded-md border border-button-line bg-header px-2.5 py-2 text-fg disabled:text-muted aria-[invalid=true]:border-gate-bar max-sm:min-h-[46px] max-sm:text-[15px]";

// A small rounded status label.
export function Pill({ tone, title, children }: { tone: PillTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-sm leading-[18px] font-medium ${PILL_TONES[tone]}`}>
      {tone === "ok" && <span className="inline-block size-1.5 rounded-full bg-accent" />}
      {children}
    </span>
  );
}

// A boxed note inside a card or a dialog: info, error, success or warning.
export function Note({ tone, icon, role, children }: { tone: NoteTone; icon?: ReactNode; role?: "alert" | "status"; children: ReactNode }) {
  return (
    <div role={role} aria-live={role ? undefined : "polite"} className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[13px] ${NOTE_TONES[tone]}`}>
      {icon && <span className="mt-px shrink-0 text-[15px] leading-[1.2]">{icon}</span>}
      <div className="flex min-w-0 grow flex-col gap-0.5">{children}</div>
    </div>
  );
}

// The uppercase dim label above a column of a connection row.
export function ColumnLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs tracking-[.3px] text-dim uppercase">{children}</div>;
}

// The uppercase caption of a settings card.
export function SettingsCardTitle({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-sm font-medium tracking-[.3px] text-muted uppercase">{children}</h3>;
}

// The grey pulsing bar of a skeleton, sized by the caller.
export function Bar({ className }: { className: string }) {
  return <span className={`block animate-pulse rounded bg-[#1a1f2b] ${className}`} />;
}
