import { useState } from "react";
import { errorText } from "../lib/actions";
import { useCloseTerminal } from "../lib/terminals";
import { showToast } from "../lib/toast";
import type { TerminalInfo } from "../lib/types";
import { CloseTerminalDialog } from "./CloseTerminalDialog";

interface TerminalCloseButtonProps {
  terminal: TerminalInfo;
  onClosed?: () => void;
  className?: string;
}

// The × of a terminal: a live one asks first and is ended, an exited one only loses its tab.
export function TerminalCloseButton({ terminal, onClosed, className = "" }: TerminalCloseButtonProps) {
  const closeTerminal = useCloseTerminal();
  const [confirming, setConfirming] = useState(false);
  const close = async () => {
    await closeTerminal(terminal.id);
    onClosed?.();
  };
  const onClick = () => {
    if (!terminal.exited) {
      setConfirming(true);
      return;
    }
    close().catch((err: unknown) => showToast(errorText(err), "error"));
  };
  return (
    <>
      <button type="button" aria-label={`Close ${terminal.label}`} title={`Close ${terminal.label}`} onClick={onClick} className={`rounded px-1 text-dim hover:bg-row-line hover:text-fg ${className}`}>
        ×
      </button>
      {confirming && <CloseTerminalDialog terminal={terminal} onConfirm={close} onClose={() => setConfirming(false)} />}
    </>
  );
}
