import type { ReactNode } from "react";
import { Button } from "../../ui";

const STEPS = ["Pick a git repository on this computer.", "Name it and give it a short key: refs read KEY-12.", "Queue jobs for it from the Queue page or the operator."];

// The empty state of Settings › Projects & orgs: what a project is, three steps, the add button and the CLI way; the default org card follows it.
export function ProjectsEmpty({ onAdd, children }: { onAdd: () => void; children: ReactNode }) {
  return (
    <>
      <section className="flex flex-col items-start gap-4 rounded-lg border border-line bg-surface px-6 py-7 max-sm:px-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[16px] font-semibold">No project yet</h2>
          <p className="m-0 text-[13px] text-muted">A project is a git repository nightqueue works in. Every job, lesson and memory belongs to one, inside an org.</p>
        </div>
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-[#d6dae3]">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Button variant="primary" className="max-sm:min-h-11 max-sm:w-full" onClick={onAdd}>
          + Add project
        </Button>
        <div className="text-sm text-dim">
          Or, inside the repository: <span className="font-mono">nightqueue init</span>
        </div>
      </section>
      {children}
    </>
  );
}
