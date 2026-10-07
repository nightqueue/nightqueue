import { useState } from "react";

export interface Toggles {
  isOpen: (key: string, fallback: boolean) => boolean;
  set: (key: string, open: boolean) => void;
  reset: () => void;
}

// Open/closed overrides by key: a key the user never toggled answers its fallback.
export function useToggles(): Toggles {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  return {
    isOpen: (key, fallback) => overrides[key] ?? fallback,
    set: (key, open) => setOverrides((previous) => ({ ...previous, [key]: open })),
    reset: () => setOverrides({}),
  };
}
