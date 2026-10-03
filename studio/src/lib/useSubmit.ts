import { useMutation } from "@tanstack/react-query";
import { errorText } from "./actions";
import { showToast } from "./toast";

// A form submission as a mutation: `onDone` runs after it succeeds, a failure is an error toast and keeps the form open.
export function useSubmit<T>(run: (input: T) => Promise<void>, onDone: () => void) {
  return useMutation({ mutationFn: run, onSuccess: onDone, onError: (err: unknown) => showToast(errorText(err), "error") });
}
