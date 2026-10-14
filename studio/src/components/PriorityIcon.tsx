const PRIORITY_NAMES: Record<number, string> = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

const BAR_HEIGHTS = [4, 8, 12];

// The bars filled for a priority: Low 1, Medium 2, High 3, anything else 0.
function filledBars(priority: number): number {
  return priority >= 2 && priority <= 4 ? 5 - priority : 0;
}

// The priority name shown in the tooltip and read by screen readers.
export function priorityName(priority: number): string {
  return PRIORITY_NAMES[priority] ?? PRIORITY_NAMES[0];
}

// Three signal bars, the filled ones bright, or three grey dashes when no bar is filled.
function PriorityBars({ filled }: { filled: number }) {
  if (filled === 0) {
    return (
      <>
        {BAR_HEIGHTS.map((_, index) => (
          <rect key={index} x={index * 5} y={7} width={3} height={2} rx={0.5} className="fill-dim" />
        ))}
      </>
    );
  }
  return (
    <>
      {BAR_HEIGHTS.map((height, index) => (
        <rect key={index} x={index * 5} y={14 - height} width={3} height={height} rx={0.5} className={index < filled ? "fill-fg" : "fill-dim"} />
      ))}
    </>
  );
}

// An orange rounded square holding an exclamation mark.
function UrgentIcon({ name }: { name: string }) {
  return (
    <svg width={14} height={16} viewBox="0 0 14 16" role="img" aria-label={name} className="shrink-0">
      <title>{name}</title>
      <rect x={0} y={1} width={14} height={14} rx={3} className="fill-orange-500" />
      <rect x={6.1} y={4} width={1.8} height={5.5} rx={0.9} className="fill-bg" />
      <circle cx={7} cy={11.7} r={1} className="fill-bg" />
    </svg>
  );
}

// The priority of an issue as an icon only: bars for Low to High, an orange exclamation for Urgent, grey dashes for none.
export function PriorityIcon({ priority }: { priority: number }) {
  const name = priorityName(priority);
  if (priority === 1) return <UrgentIcon name={name} />;
  return (
    <svg width={13} height={16} viewBox="0 -1 13 16" role="img" aria-label={name} className="shrink-0">
      <title>{name}</title>
      <PriorityBars filled={filledBars(priority)} />
    </svg>
  );
}
