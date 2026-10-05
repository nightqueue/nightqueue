import type { TerminalInfo } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

interface CloseTerminalDialogProps {
  terminal: TerminalInfo;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

// Asks before ending a live terminal, since closing its tab ends its claude process.
export function CloseTerminalDialog({ terminal, onConfirm, onClose }: CloseTerminalDialogProps) {
  return (
    <ConfirmDialog title={`Close ${terminal.label}?`} confirmLabel="Close terminal" onConfirm={onConfirm} onClose={onClose}>
      Close {terminal.label}? Its claude process is ended. Hide the dock instead to keep it running.
    </ConfirmDialog>
  );
}
