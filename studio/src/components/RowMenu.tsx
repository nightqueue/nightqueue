import { Link } from "@tanstack/react-router";
import { GitMerge, RotateCcw, Terminal, X, type LucideIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { canCancel, canClose, canRetry, hasLog, hasSession, rawLogUrl, sessionCommand } from "../lib/actions";
import { copyText } from "../lib/clipboard";
import { jobRef } from "../lib/queue";
import type { Job } from "../lib/types";
import { useEscape } from "../lib/useEscape";
import { ActionIcon } from "./StatusIcon";

export type RowMenuPick = "retry" | "cancel" | "close";

interface RowMenuProps {
  job: Job;
  anchor: HTMLElement;
  onPick: (pick: RowMenuPick, job: Job) => void;
  onClose: () => void;
}

const MENU_WIDTH = 220;

const ITEM_CLASS = "block w-full rounded px-3 py-1.5 text-left text-fg no-underline hover:bg-row-line hover:text-fg hover:no-underline disabled:cursor-not-allowed disabled:text-dim disabled:hover:bg-transparent";

// Where the menu opens: under its anchor, right-aligned to it, kept inside the viewport.
function menuPosition(anchor: HTMLElement): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
  return { top: rect.bottom + 4, left: Math.max(8, left) };
}

// Closes the menu on a click outside it, and on a scroll or resize of the page (a scroll inside the menu is ignored).
function useDismiss(menuRef: RefObject<HTMLDivElement | null>, anchor: HTMLElement, onClose: () => void) {
  useEscape(onClose);
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [menuRef, anchor, onClose]);
}

// One button entry of the menu, with its optional icon, disabled when the tool would refuse it.
function MenuButton({ enabled, onClick, icon, children }: { enabled: boolean; onClick: () => void; icon?: LucideIcon; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={ITEM_CLASS} disabled={!enabled} onClick={onClick}>
      <span className="flex items-center gap-2">
        {icon && <ActionIcon icon={icon} />}
        {children}
      </span>
    </button>
  );
}

// The `⋯` menu of a row: open, retry, cancel, close, copy the session command and the raw log, each enabled by the tools' own rules.
export function RowMenu({ job, anchor, onPick, onClose }: RowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => menuPosition(anchor));
  useLayoutEffect(() => setPosition(menuPosition(anchor)), [anchor]);
  useDismiss(menuRef, anchor, onClose);
  const pick = (choice: RowMenuPick) => {
    onClose();
    onPick(choice, job);
  };
  const copySession = () => {
    onClose();
    void copyText(sessionCommand(job), "the session command");
  };
  return (
    <div ref={menuRef} role="menu" aria-label={`actions for ${jobRef(job.id)}`} style={{ top: position.top, left: position.left, width: MENU_WIDTH }} className="fixed z-30 flex flex-col rounded-md border border-line bg-surface p-1 text-[13px] shadow-[0_12px_40px_rgba(0,0,0,.5)]">
      <Link to="/jobs/$ref" params={{ ref: jobRef(job.id) }} role="menuitem" className={ITEM_CLASS} onClick={onClose}>
        Open {jobRef(job.id)}
      </Link>
      <MenuButton enabled={canRetry(job)} icon={RotateCcw} onClick={() => pick("retry")}>
        Retry…
      </MenuButton>
      <MenuButton enabled={canClose(job)} icon={GitMerge} onClick={() => pick("close")}>
        Close (merge the PR)
      </MenuButton>
      <MenuButton enabled={hasSession(job)} icon={Terminal} onClick={copySession}>
        Copy session cmd
      </MenuButton>
      {hasLog(job) ? (
        <a href={rawLogUrl(job)} target="_blank" rel="noreferrer" role="menuitem" className={ITEM_CLASS} onClick={onClose}>
          Raw log ↗
        </a>
      ) : (
        <MenuButton enabled={false} onClick={onClose}>
          Raw log
        </MenuButton>
      )}
      <div className="my-1 h-px bg-line" aria-hidden="true" />
      <MenuButton enabled={canCancel(job)} onClick={() => pick("cancel")}>
        <span className={`flex items-center gap-2 ${canCancel(job) ? "text-red" : ""}`}>
          <ActionIcon icon={X} />
          {job.status === "running" ? "Cancel and stop runner…" : "Cancel…"}
        </span>
      </MenuButton>
    </div>
  );
}
