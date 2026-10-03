import { useState } from "react";
import { Card } from "./Card";

const PREVIEW_CHARS = 320;

// The operator note card: the note the job was queued with, cut with a `show more` when long; absent without a note.
export function NoteCard({ note }: { note: string | null }) {
  const [whole, setWhole] = useState(false);
  const text = note?.trim() ?? "";
  if (!text) return null;
  const long = text.length > PREVIEW_CHARS;
  return (
    <Card label="operator note" title="Operator note">
      <p className="m-0 text-[13px] break-words whitespace-pre-wrap text-note">{long && !whole ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text}</p>
      {long && (
        <button type="button" className="self-start border-0 bg-transparent p-0 text-sm text-link hover:underline" onClick={() => setWhole(!whole)}>
          {whole ? "show less" : "show more"}
        </button>
      )}
    </Card>
  );
}
