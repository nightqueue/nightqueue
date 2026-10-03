import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "run" | "danger";

export type ButtonSize = "md" | "sm";

const VARIANTS: Record<ButtonVariant, string> = {
  default: "border-button-line bg-button text-fg enabled:hover:bg-[#1c2230]",
  primary: "border-accent bg-accent text-bg enabled:hover:bg-accent-hover",
  ghost: "border-transparent bg-transparent text-muted enabled:hover:bg-button enabled:hover:text-fg",
  run: "border-run-line bg-button text-accent enabled:hover:bg-[#1c2230]",
  danger: "border-red-strong bg-button text-red enabled:hover:bg-[#2a1414]",
};

const SIZES: Record<ButtonSize, string> = {
  md: "min-h-9 px-3 py-2",
  sm: "min-h-7 px-2 py-1 text-sm",
};

// A button of the studio palette: default, primary (accent), ghost or run (accent outline).
export function Button({ variant = "default", size = "md", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1 rounded-md border font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
}

// A rounded filter chip, highlighted when it is the active one.
export function Chip({ on = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`min-h-7 rounded-full border px-2.5 py-1 text-sm whitespace-nowrap ${on ? "border-button-line bg-row-line text-fg" : "border-line bg-transparent text-muted hover:text-fg"}`}
      {...props}
    >
      {children}
    </button>
  );
}

// A static mode tag, shaped like an active chip.
export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex min-h-6 items-center rounded-full border border-button-line bg-row-line px-2 py-0.5 text-sm text-fg">{children}</span>;
}

// The mono key-like label the footers use for a command.
export function Kbd({ children }: { children: ReactNode }) {
  return <span className="rounded border border-button-line px-1 font-mono text-xs text-muted">{children}</span>;
}

interface SegmentedProps<T extends string> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

// A segmented control: one pressed button among a few equal choices.
export function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border border-button-line">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={`min-h-9 flex-1 border-0 px-3 py-1.5 whitespace-nowrap ${option.value === value ? "bg-row-line text-fg" : "bg-transparent text-muted hover:text-fg"}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const FIELD_CLASS ="min-h-8 rounded-md border border-button-line bg-button px-2 py-1 text-fg";
