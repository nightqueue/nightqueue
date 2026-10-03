import type { ReactNode } from "react";

interface CardProps {
  label: string;
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

// The uppercase caption every job card is titled with.
export function CardTitle({ children, className = "text-muted" }: { children: ReactNode; className?: string }) {
  return <h3 className={`m-0 text-sm font-medium tracking-[.3px] uppercase ${className}`}>{children}</h3>;
}

// A side card of the job screen: a caption, an optional note beside it, then its content.
export function Card({ label, title, aside, className = "", children }: CardProps) {
  return (
    <section aria-label={label} className={`flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3.5 ${className}`}>
      <div className="flex items-baseline gap-2">
        <CardTitle>{title}</CardTitle>
        {aside && <span className="text-xs text-dim">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// A two-column key/value list, keys muted.
export function KeyValues({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted">{key}</dt>
          <dd className="m-0 min-w-0 font-mono text-sm break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// The muted sentence a card shows when it has nothing yet.
export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[13px] text-muted">{children}</p>;
}
