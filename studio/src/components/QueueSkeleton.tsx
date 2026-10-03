const SKELETON_ROWS = 6;

// One grey bar of a skeleton, sized by the caller.
function Bar({ className }: { className: string }) {
  return <span className={`block animate-pulse rounded bg-row-line ${className}`} />;
}

// The loading state of the queue: a toolbar, a banner and table rows shaped like the real ones.
export function QueueSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="loading the queue">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Bar key={index} className="h-7 w-20 rounded-full" />
        ))}
      </div>
      <Bar className="h-16 w-full rounded-lg" />
      <div className="flex flex-col">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="flex items-center gap-4 border-b border-row-line px-3 py-3">
            <Bar className="h-3 w-10" />
            <Bar className="h-3 w-20" />
            <Bar className="hidden h-3 w-14 sm:block" />
            <Bar className="hidden h-3 w-12 sm:block" />
            <div className="flex grow flex-col gap-1.5">
              <Bar className="h-3 w-3/5" />
              <Bar className="h-3 w-2/5" />
            </div>
            <Bar className="h-5 w-12 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
