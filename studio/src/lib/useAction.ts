import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { errorText } from "./actions";
import { showToast } from "./toast";

// Wraps one action in a mutation: a second call with the same key is ignored while the first runs, and a failure is an error toast.
export function useAction<T>(run: (input: T) => Promise<void>, keyOf: (input: T) => string): (input: T) => void {
  const inFlight = useRef(new Set<string>());
  const { mutateAsync } = useMutation({ mutationFn: run });
  return useCallback(
    (input: T) => {
      const key = keyOf(input);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      mutateAsync(input)
        .catch((err: unknown) => showToast(errorText(err), "error"))
        .finally(() => inFlight.current.delete(key));
    },
    [mutateAsync, keyOf],
  );
}
