import { errorText } from "../../lib/actions";
import { Button } from "../ui";
import { Note } from "./bits";

interface SettingsErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

// The error state of Settings › Integrations: what failed, that nothing changed, and how to retry.
export function SettingsError({ error, retrying, onRetry }: SettingsErrorProps) {
  return (
    <section role="alert" className="flex flex-col items-start gap-4 rounded-lg border border-line bg-surface px-6 py-7 max-sm:px-4">
      <div className="w-full">
        <Note tone="err" icon="⚠">
          <div className="font-semibold text-red">Couldn't read the integrations</div>
          <div>
            Studio couldn't reach the runtime at <span className="font-mono">{window.location.host}</span> ({errorText(error)}). Nothing was changed — connections and destinations stay as they were.
          </div>
        </Note>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={retrying} onClick={onRetry} className="max-sm:min-h-11">
          {retrying ? "Trying…" : "Try again"}
        </Button>
        <Button variant="ghost" disabled title="the Doctor screen lands in S3" className="max-sm:min-h-11">
          Open Doctor
        </Button>
      </div>
      <div className="text-sm text-dim">
        Usually the runtime is stopped. In a terminal: <span className="font-mono">nightqueue studio</span> or <span className="font-mono">nightqueue doctor</span>.
      </div>
    </section>
  );
}
