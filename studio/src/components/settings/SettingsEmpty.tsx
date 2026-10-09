import { Link2 } from "lucide-react";
import { Button } from "../ui";

const STEPS = [
  { title: "Create the webhook in Discord", text: "In the channel that will get the notices: Channel settings › Integrations › Webhooks." },
  { title: "Paste the URL here", text: "Name the connection and pick the org. The URL is tested before it is saved and never shown again." },
  { title: "Link the projects", text: "Choose which projects of the org notify that channel when a job closes." },
];

// One numbered step of the explainer.
function Step({ index, title, text }: { index: number; title: string; text: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-button-line text-sm text-muted">{index}</span>
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted">{text}</div>
      </div>
    </div>
  );
}

// The empty state of Settings › Integrations: why a connection matters, three steps, and the add button.
export function SettingsEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <section aria-label="no connections" className="flex flex-col items-center gap-4.5 rounded-lg border border-line bg-surface px-8 py-10 text-center max-sm:px-4">
      <Link2 size={44} strokeWidth={1.6} className="text-dim" aria-hidden="true" />
      <div className="flex max-w-[520px] flex-col gap-1.5">
        <div className="text-[16px] font-semibold">No connections yet</div>
        <div className="text-[13px] text-muted">Without a connection, jobs close in silence: no channel gets the “job closed” notice. Start with a Discord webhook — it takes a minute.</div>
      </div>
      <div className="mt-1.5 grid w-full max-w-[760px] grid-cols-3 gap-4 text-left max-sm:grid-cols-1">
        {STEPS.map((step, index) => (
          <Step key={step.title} index={index + 1} title={step.title} text={step.text} />
        ))}
      </div>
      <Button variant="primary" className="mt-1.5 max-sm:min-h-11" onClick={onAdd}>
        Add Discord webhook
      </Button>
      <div className="text-sm text-dim">
        GitHub and Linear are set up from the CLI for now: <span className="font-mono">nightqueue connection add &lt;name&gt; --type github</span>
      </div>
    </section>
  );
}
