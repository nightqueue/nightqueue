import type { ReactNode } from "react";
import { useSubmit } from "../lib/useSubmit";
import { Modal } from "./Modal";
import { Button } from "./ui";

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}

// Asks before a destructive action; the confirm button stays busy until the action answers.
export function ConfirmDialog({ title, confirmLabel, onConfirm, onClose, children }: ConfirmDialogProps) {
  const submit = useSubmit(onConfirm, onClose);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" disabled={submit.isPending} onClick={() => submit.mutate(undefined)}>
            {submit.isPending ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-muted">{children}</div>
    </Modal>
  );
}
