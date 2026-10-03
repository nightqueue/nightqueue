import { showToast } from "./toast";

// Copies a text to the clipboard and says so in a toast; a refused copy is an error toast naming the text.
export async function copyText(text: string, what = "text"): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("the clipboard is unavailable on this page");
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${what}`, "success");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    showToast(`Could not copy ${what} (${reason}): ${text}`, "error");
  }
}
