const LATER_SECTIONS = ["Projects & orgs", "Runners", "Appearance"];

// The sections of Settings: a sticky left column on a desktop, a chip row on a phone; only Integrations exists yet.
export function SettingsSections() {
  return (
    <>
      <aside aria-label="settings sections" className="sticky top-[72px] flex flex-col gap-0.5 max-lg:hidden">
        <div className="px-2.5 pb-2 text-xs tracking-[.3px] text-dim uppercase">Settings</div>
        <a href="#integrations" aria-current="page" className="block rounded-md bg-row-line px-2.5 py-2 text-[13px] text-fg">
          Integrations
        </a>
        {LATER_SECTIONS.map((label) => (
          <span key={label} aria-disabled="true" className="block cursor-default rounded-md px-2.5 py-2 text-[13px] text-dim">
            {label}
          </span>
        ))}
        <div className="px-2.5 pt-2.5 text-xs text-dim">Other sections land in the next deliveries.</div>
      </aside>
      <nav aria-label="sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        <a href="#integrations" aria-current="page" className="inline-flex min-h-[34px] items-center rounded-full border border-button-line bg-row-line px-3 text-sm whitespace-nowrap text-fg">
          Integrations
        </a>
        {LATER_SECTIONS.map((label) => (
          <span key={label} aria-disabled="true" className="inline-flex min-h-[34px] items-center rounded-full border border-line px-3 text-sm whitespace-nowrap text-dim">
            {label}
          </span>
        ))}
      </nav>
    </>
  );
}
