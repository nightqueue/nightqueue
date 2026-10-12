import { MoreHorizontal } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { orgActions } from "../../../lib/projects";
import type { OrgRow } from "../../../lib/types";
import { useEscape } from "../../../lib/useEscape";

export type OrgAction = "rename" | "key" | "default" | "remove";

interface OrgActionsMenuProps {
  org: OrgRow;
  onPick: (action: OrgAction, org: OrgRow) => void;
}

const ITEM_CLASS = "flex w-full flex-col items-start rounded px-3 py-2 text-left text-fg hover:bg-row-line disabled:cursor-not-allowed disabled:text-dim disabled:hover:bg-transparent max-sm:min-h-11";

// One entry of the menu, with the reason it is disabled under its label.
function MenuItem({ disabled = false, reason, onClick, children }: { disabled?: boolean; reason?: string | null; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={ITEM_CLASS} disabled={disabled} onClick={onClick}>
      <span>{children}</span>
      {disabled && reason && <span className="text-xs text-dim">{reason}</span>}
    </button>
  );
}

// Closes the menu on Escape and on a click outside it.
function useDismiss(rootRef: RefObject<HTMLDivElement | null>, open: boolean, close: () => void) {
  useEscape(close);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) close();
    };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [rootRef, open, close]);
}

// The "Org actions" menu of an org card: a dropdown on a desktop, a bottom sheet behind `⋯` on a phone.
export function OrgActionsMenu({ org, onPick }: OrgActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);
  const allowed = orgActions(org);
  const pick = (action: OrgAction) => {
    close();
    onPick(action, org);
  };
  return (
    <div ref={rootRef} className="relative ml-auto">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`actions for org ${org.name}`} onClick={() => setOpen(!open)} className="inline-flex min-h-[30px] items-center gap-1 rounded-md border border-button-line bg-button px-2.5 text-sm text-fg hover:bg-[#1c2230] max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center">
        <span className="max-sm:hidden">Org actions</span>
        <MoreHorizontal size={16} aria-hidden="true" className="sm:hidden" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30 bg-[rgba(5,7,12,.6)] sm:hidden" aria-hidden="true" onMouseDown={close} />
          <div role="menu" aria-label={`org ${org.name}`} className="absolute top-full right-0 z-30 mt-1 flex w-[230px] flex-col rounded-md border border-line bg-surface p-1 text-[13px] text-fg shadow-[0_12px_40px_rgba(0,0,0,.5)] max-sm:fixed max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:w-full max-sm:rounded-b-none max-sm:p-3 max-sm:pb-6 max-sm:text-[15px]">
            <div className="px-3 pt-1 pb-2 text-xs text-dim sm:hidden">Org {org.name}</div>
            <MenuItem onClick={() => pick("rename")}>Rename…</MenuItem>
            <MenuItem onClick={() => pick("key")}>Change key…</MenuItem>
            <MenuItem disabled={allowed.setDefault.disabled} reason="it is already the default org" onClick={() => pick("default")}>
              Set as default…
            </MenuItem>
            <div className="my-1 h-px bg-line" aria-hidden="true" />
            <MenuItem disabled={allowed.remove.disabled} reason={allowed.remove.reason} onClick={() => pick("remove")}>
              <span className={allowed.remove.disabled ? "" : "text-red"}>Remove</span>
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}
