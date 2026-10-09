import { ArrowLeft, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEscape } from "../../lib/useEscape";

export type DialogWidth = "narrow" | "medium" | "wide";

export type PhoneLayout = "sheet" | "full";

interface SettingsDialogProps {
  title: ReactNode;
  label: string;
  width: DialogWidth;
  phone: PhoneLayout;
  alert?: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
  footer: ReactNode;
}

const WIDTHS: Record<DialogWidth, string> = { narrow: "sm:max-w-[520px]", medium: "sm:max-w-[560px]", wide: "sm:max-w-[640px]" };

const OVERLAY_PHONE: Record<PhoneLayout, string> = { sheet: "max-sm:items-end", full: "max-sm:items-stretch" };

const PANEL_PHONE: Record<PhoneLayout, string> = {
  sheet: "max-sm:max-h-[92vh] max-sm:rounded-t-[14px] max-sm:border-x-0 max-sm:border-b-0",
  full: "max-sm:min-h-full max-sm:border-0",
};

// The ✕ that closes a dialog; on a phone full screen it becomes a back arrow on the left.
function CloseButton({ onClose, phone }: { onClose: () => void; phone: PhoneLayout }) {
  const hideOnPhone = phone === "full" ? "max-sm:hidden" : "";
  return (
    <button type="button" aria-label="close" onClick={onClose} className={`ml-auto inline-flex min-h-[30px] items-center rounded-md px-2 text-muted hover:bg-button hover:text-fg max-sm:min-h-10 ${hideOnPhone}`}>
      <X size={16} aria-hidden="true" />
    </button>
  );
}

// The back arrow of a full-screen phone dialog.
function BackButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="back" onClick={onClose} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-muted hover:text-fg sm:hidden">
      <ArrowLeft size={20} aria-hidden="true" />
    </button>
  );
}

// A settings dialog: centred at its width on a desktop, a bottom sheet or a full screen on a phone; Escape or the overlay closes it.
export function SettingsDialog({ title, label, width, phone, alert = false, onClose, onSubmit, children, footer }: SettingsDialogProps) {
  useEscape(onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };
  const border = alert ? "border-gate-line" : "border-button-line";
  const panelClass = `flex w-full flex-col border bg-surface text-[14px] leading-[1.45] shadow-[0_24px_64px_rgba(0,0,0,.6)] sm:rounded-[10px] ${border} ${WIDTHS[width]} ${PANEL_PHONE[phone]}`;
  const content = (
    <>
      {phone === "sheet" && (
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <span className="h-1 w-9 rounded-sm bg-button-line" />
        </div>
      )}
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-4 max-sm:px-4 max-sm:py-3">
        {phone === "full" && <BackButton onClose={onClose} />}
        <h2 className="m-0 flex min-w-0 items-center gap-2 text-[16px] font-semibold">{title}</h2>
        <CloseButton onClose={onClose} phone={phone} />
      </div>
      <div className="flex grow flex-col gap-4 overflow-y-auto px-5 py-4 max-sm:px-4">{children}</div>
      <div className={`flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4 max-sm:pb-5 ${phone === "full" ? "max-sm:sticky max-sm:bottom-0" : ""}`}>{footer}</div>
    </>
  );
  const common = { role: alert ? "alertdialog" : "dialog", "aria-modal": true, "aria-label": label, className: panelClass } as const;
  return (
    <div className={`fixed inset-0 z-40 flex justify-center overflow-y-auto bg-[rgba(5,7,12,.74)] sm:items-start sm:px-4 sm:pt-14 sm:pb-10 ${OVERLAY_PHONE[phone]}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {onSubmit ? (
        <form {...common} onSubmit={submit}>
          {content}
        </form>
      ) : (
        <div {...common}>{content}</div>
      )}
    </div>
  );
}
