import type { ReactNode } from "react";
import { useEscape } from "../lib/useEscape";
import { Button } from "./ui";

interface SideDrawerProps {
  label: string;
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  widthClass?: string;
}

// The default footer of a side drawer: one ghost Close button.
function CloseFooter({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" onClick={onClose}>
      Close
    </Button>
  );
}

// A read-only right drawer with a header bar, a scrolling body and a footer bar; Esc or the backdrop closes it.
export function SideDrawer({ label, header, children, footer, onClose, widthClass = "sm:w-[480px]" }: SideDrawerProps) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-[rgba(5,7,10,.55)]" onMouseDown={onClose} aria-hidden="true" />
      <aside aria-label={label} className={`absolute top-0 right-0 bottom-0 flex w-full flex-col border-l border-line bg-surface text-[14px] leading-[1.45] text-fg shadow-[-20px_0_60px_rgba(0,0,0,.5)] ${widthClass}`}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">{header}</div>
        <div className="grow overflow-auto p-5">{children}</div>
        <div className="flex border-t border-line px-5 py-4">{footer ?? <CloseFooter onClose={onClose} />}</div>
      </aside>
    </div>
  );
}
