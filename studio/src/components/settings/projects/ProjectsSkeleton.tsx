import { Bar } from "../bits";
import { ROW_GRID } from "./ProjectRow";

const ROWS = [
  { name: "w-[110px]", path: "w-[220px]", integrations: "w-[150px]" },
  { name: "w-[90px]", path: "w-[180px]", integrations: "w-[120px]" },
  { name: "w-[130px]", path: "w-[240px]", integrations: "w-[100px]" },
];

// One skeleton project row on the grid of the real rows.
function SkeletonRow({ shape }: { shape: (typeof ROWS)[number] }) {
  return (
    <div className={`${ROW_GRID} border-t border-line p-4`}>
      <div className="flex items-center gap-2">
        <Bar className={`h-4 ${shape.name}`} />
        <Bar className="h-4 w-10 rounded-full" />
      </div>
      <div className="flex flex-col gap-2">
        <Bar className={`h-3.5 ${shape.path}`} />
        <Bar className="h-3 w-[110px]" />
      </div>
      <div className="flex flex-col gap-2">
        <Bar className={`h-3 ${shape.integrations}`} />
        <Bar className="h-3 w-[90px]" />
      </div>
      <Bar className="h-[30px] w-[120px] max-lg:w-full" />
    </div>
  );
}

// One skeleton org card: its header and three project rows.
function SkeletonOrg() {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-3 px-4 py-3">
        <Bar className="h-4 w-[90px]" />
        <Bar className="h-4 w-10 rounded-full" />
        <Bar className="h-3 w-[160px] max-sm:hidden" />
        <Bar className="ml-auto h-[30px] w-[100px]" />
      </div>
      {ROWS.map((shape, index) => (
        <SkeletonRow key={index} shape={shape} />
      ))}
    </section>
  );
}

// The loading state of Settings › Projects & orgs: filter chips and two org cards shaped like the real ones.
export function ProjectsSkeleton() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="loading projects and orgs">
      <div className="flex gap-2">
        <Bar className="h-7 w-[70px] rounded-full" />
        <Bar className="h-7 w-[110px] rounded-full" />
        <Bar className="h-7 w-[80px] rounded-full" />
      </div>
      <SkeletonOrg />
      <SkeletonOrg />
    </div>
  );
}
