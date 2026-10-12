import { useSyncExternalStore } from "react";

const LIVE_SECTIONS = [
  { hash: "#integrations", label: "Integrations" },
  { hash: "#projects", label: "Projects & orgs" },
];

const LATER_SECTIONS = ["Runners", "Appearance"];

const DEFAULT_HASH = "#integrations";

// Subscribes to the location hash.
function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

// The live section the location hash names, Integrations by default.
function currentHash(): string {
  return LIVE_SECTIONS.some((section) => section.hash === window.location.hash) ? window.location.hash : DEFAULT_HASH;
}

// The section the location hash names, following it as it changes.
function useCurrentSection(): string {
  return useSyncExternalStore(subscribeHash, currentHash, () => DEFAULT_HASH);
}

// The sections of Settings: a sticky left column on a desktop, a chip row on a phone; the current one follows the hash.
export function SettingsSections() {
  const current = useCurrentSection();
  const columnClass = (hash: string) => `block rounded-md px-2.5 py-2 text-[13px] ${hash === current ? "bg-row-line text-fg" : "text-muted hover:text-fg"}`;
  const chipClass = (hash: string) => `inline-flex min-h-[44px] items-center rounded-full border px-3 text-sm whitespace-nowrap ${hash === current ? "border-button-line bg-row-line text-fg" : "border-line text-muted"}`;
  return (
    <>
      <aside aria-label="settings sections" className="sticky top-[72px] row-span-2 flex flex-col gap-0.5 max-lg:hidden">
        <div className="px-2.5 pb-2 text-xs tracking-[.3px] text-dim uppercase">Settings</div>
        {LIVE_SECTIONS.map((section) => (
          <a key={section.hash} href={section.hash} aria-current={section.hash === current ? "page" : undefined} className={columnClass(section.hash)}>
            {section.label}
          </a>
        ))}
        {LATER_SECTIONS.map((label) => (
          <span key={label} aria-disabled="true" className="block cursor-default rounded-md px-2.5 py-2 text-[13px] text-dim">
            {label}
          </span>
        ))}
        <div className="px-2.5 pt-2.5 text-xs text-dim">Other sections land in the next deliveries.</div>
      </aside>
      <nav aria-label="sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        {LIVE_SECTIONS.map((section) => (
          <a key={section.hash} href={section.hash} aria-current={section.hash === current ? "page" : undefined} className={chipClass(section.hash)}>
            {section.label}
          </a>
        ))}
        {LATER_SECTIONS.map((label) => (
          <span key={label} aria-disabled="true" className="inline-flex min-h-[34px] items-center rounded-full border border-line px-3 text-sm whitespace-nowrap text-dim">
            {label}
          </span>
        ))}
      </nav>
    </>
  );
}
