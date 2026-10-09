import { lastTestLabel } from "../../lib/integrations";
import type { LastTest } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { Pill } from "./bits";

// The Last test pill of a connection, its failure reason under it unless `compact`.
export function LastTestPill({ lastTest, compact = false }: { lastTest: LastTest | null; compact?: boolean }) {
  const now = useNow(30_000);
  const label = lastTestLabel(lastTest, now);
  return (
    <>
      <Pill tone={label.tone} title={lastTest?.at ?? undefined}>
        {label.text}
      </Pill>
      {!compact && label.tone === "err" && lastTest?.reason && <div className="text-sm text-red">{lastTest.reason}</div>}
    </>
  );
}
