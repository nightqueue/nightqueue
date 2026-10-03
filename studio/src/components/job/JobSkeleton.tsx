// One grey bar of a skeleton, sized by the caller.
function Bar({ className }: { className: string }) {
  return <span className={`block animate-pulse rounded bg-row-line ${className}`} />;
}

// The loading state of the job screen: a header, the phase track and the two columns, shaped like the real ones.
export function JobSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="loading the job">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <Bar className="h-6 w-16" />
          <Bar className="h-6 w-64" />
          <Bar className="h-5 w-16 rounded-full" />
          <Bar className="h-6 w-14 rounded-full" />
        </div>
        <Bar className="h-3 w-3/5" />
        <Bar className="h-3 w-2/5" />
      </div>
      <Bar className="h-20 w-full rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Bar className="h-[420px] rounded-lg" />
        <div className="flex flex-col gap-4">
          <Bar className="h-24 rounded-lg" />
          <Bar className="h-20 rounded-lg" />
          <Bar className="h-36 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
