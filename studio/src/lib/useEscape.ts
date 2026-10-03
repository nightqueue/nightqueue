import { useEffect } from "react";

// Calls `onEscape` when the Escape key is pressed while the calling component is mounted.
export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onEscape]);
}
