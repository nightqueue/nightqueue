import { copyText } from "../lib/clipboard";
import { dismissTerminalFallback, useTerminalFallback } from "../lib/terminalUnavailable";
import { Modal } from "./Modal";
import { Button } from "./ui";

// The dialog an entry point opens when the studio cannot embed a terminal: the reason, and the command to copy and run by hand.
export function TerminalUnavailable() {
  const fallback = useTerminalFallback();
  if (!fallback) return null;
  return (
    <Modal
      title="Terminal unavailable"
      onClose={dismissTerminalFallback}
      footer={
        <>
          <Button variant="ghost" onClick={dismissTerminalFallback}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void copyText(fallback.command, "the command")}>
            Copy command
          </Button>
        </>
      }
    >
      <p className="m-0 text-muted">terminal unavailable: {fallback.reason}</p>
      <p className="m-0 text-muted">Run it in your own terminal instead:</p>
      <code className="rounded-md border border-button-line bg-bg px-2 py-1.5 font-mono text-sm break-all text-fg">{fallback.command}</code>
    </Modal>
  );
}
