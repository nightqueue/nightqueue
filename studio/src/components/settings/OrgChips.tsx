import { useEffect, useRef, useState } from "react";
import { isDiscord, typeLabel } from "../../lib/integrations";
import type { ConnectionRow } from "../../lib/types";

interface OrgChipsProps {
  row: ConnectionRow;
  remaining: string[];
  onAllow: (org: string) => void;
  onRemove: (org: string) => void;
}

const CHIP_CLASS = "inline-flex min-h-[26px] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm max-lg:min-h-8";

// One allowed org: a static chip, or with an `×` that removes the org from a Discord connection.
function OrgChip({ org, onRemove }: { org: string; onRemove?: () => void }) {
  return (
    <span className={`${CHIP_CLASS} border-button-line bg-row-line text-fg`}>
      {org}
      {onRemove && (
        <button type="button" aria-label={`remove from org ${org}`} onClick={onRemove} className="px-0.5 text-[14px] leading-none text-dim hover:text-red">
          ×
        </button>
      )}
    </span>
  );
}

// Closes an open popover when a click lands outside of it or Escape is pressed.
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

// The `+ org` chip: a popover with the orgs the connection is not allowed for yet.
function AddOrgChip({ remaining, onAllow }: { remaining: string[]; onAllow: (org: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  if (!remaining.length) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="allow for another org" aria-expanded={open} onClick={() => setOpen(!open)} className={`${CHIP_CLASS} border-line text-muted hover:text-fg`}>
        + org
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-30 mt-1 flex min-w-40 flex-col rounded-md border border-button-line bg-surface py-1 shadow-lg">
          {remaining.map((org) => (
            <button
              key={org}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAllow(org);
              }}
              className="px-3 py-1.5 text-left text-[13px] text-fg hover:bg-row-line max-lg:min-h-11"
            >
              allow for <span className="font-mono">{org}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The allowed orgs of a connection: editable chips for Discord, the runtime's read-only truth for the other types.
export function OrgChips({ row, remaining, onAllow, onRemove }: OrgChipsProps) {
  if (row.scope === "home") return <div className="pt-1 text-sm text-muted">{`all — a ${typeLabel(row.type)} key covers the whole home`}</div>;
  const discord = isDiscord(row);
  if (!discord && !row.orgs.length) return <div className="pt-1 text-sm text-muted">no org</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.orgs.map((org) => (
        <OrgChip key={org} org={org} onRemove={discord ? () => onRemove(org) : undefined} />
      ))}
      {discord && row.present && <AddOrgChip remaining={remaining} onAllow={onAllow} />}
    </div>
  );
}
