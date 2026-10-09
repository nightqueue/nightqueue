import { Bar, SettingsCardTitle } from "./bits";

const ROW_SHAPES = [
  { name: "w-[90px]", type: "w-[130px]", target: "w-[170px]", chip: "w-[120px]", pill: "w-[90px]" },
  { name: "w-[110px]", type: "w-[130px]", target: "w-[150px]", chip: "w-[70px]", pill: "w-[110px]" },
  { name: "w-[120px]", type: "w-[100px]", target: "w-0", chip: "w-[160px]", pill: "w-[90px]" },
];

// One skeleton connection row on the five-column grid of the real rows.
function SkeletonRow({ shape }: { shape: (typeof ROW_SHAPES)[number] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,.9fr)_minmax(0,1.1fr)_minmax(0,1.25fr)_150px] items-start gap-4 border-t border-line p-4 first:border-t-0 max-lg:grid-cols-1 max-lg:gap-2.5">
      <div className="flex flex-col gap-2">
        <Bar className={`h-4 ${shape.name}`} />
        <Bar className={`h-3 ${shape.type}`} />
        <Bar className={`h-3 ${shape.target}`} />
      </div>
      <div className="flex flex-col gap-2 max-lg:hidden">
        <Bar className="h-2.5 w-20" />
        <Bar className={`h-[26px] rounded-full ${shape.chip}`} />
      </div>
      <div className="flex flex-col gap-2">
        <Bar className="h-2.5 w-[70px] max-lg:hidden" />
        <Bar className={`h-5 rounded-full ${shape.pill}`} />
      </div>
      <div className="flex flex-col gap-2 max-lg:hidden">
        <Bar className="h-2.5 w-[110px]" />
        <Bar className="h-3 w-full" />
        <Bar className="h-3 w-[70%]" />
      </div>
      <Bar className="h-[30px] w-[150px] max-lg:w-full" />
    </div>
  );
}

// The loading state of Settings › Integrations: the two cards with skeleton rows shaped like the real ones.
export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="loading integrations">
      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <SettingsCardTitle>Connections</SettingsCardTitle>
          <Bar className="h-3 w-[120px]" />
        </div>
        {ROW_SHAPES.map((shape, index) => (
          <SkeletonRow key={index} shape={shape} />
        ))}
      </section>
      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <SettingsCardTitle>Log destination per project</SettingsCardTitle>
          <Bar className="h-3 w-[180px]" />
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Bar key={index} className="h-[26px] w-full" />
          ))}
        </div>
      </section>
    </div>
  );
}
