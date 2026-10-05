import { type ReactNode, useState } from "react";
import { useLaunchTerminal } from "../lib/terminals";
import type { TerminalRequest } from "../lib/types";
import { Button, type ButtonSize, type ButtonVariant } from "./ui";

interface TerminalLaunchButtonProps {
  request: TerminalRequest | null;
  blockedReason: string | null;
  title?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}

// A button that opens a terminal for its request, disabled with the reason as tooltip when it cannot, and busy while the studio answers.
export function TerminalLaunchButton({ request, blockedReason, title, size, variant, className, children }: TerminalLaunchButtonProps) {
  const launch = useLaunchTerminal();
  const [busy, setBusy] = useState(false);
  const blocked = blockedReason ?? (request ? null : "nothing to open");
  const onClick = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await launch(request);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span title={blocked ?? title} className={`inline-flex ${className ?? ""}`}>
      <Button size={size} variant={variant} disabled={blocked !== null || busy} onClick={() => void onClick()} className="w-full">
        {busy ? "Opening…" : children}
      </Button>
    </span>
  );
}
