import type { ReactNode } from "react";
import { useEscape } from "../lib/useEscape";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

// A centred dialog over the dimmed page: a click on the overlay or Escape closes it.
export function Modal({ title, onClose, children, footer }: ModalProps) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,10,.55)] p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex w-full max-w-[440px] flex-col rounded-lg border border-line bg-surface text-[14px] leading-[1.45] shadow-[0_20px_60px_rgba(0,0,0,.5)]">
        <div className="border-b border-line px-5 py-3 font-semibold">{title}</div>
        <div className="flex flex-col gap-3 px-5 py-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}
