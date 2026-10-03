import { prNumber } from "../lib/format";

const PR_COLORS: Record<string, string> = {
  open: "bg-pr-open text-white",
  merged: "bg-pr-merged text-white",
};

const NEUTRAL = "bg-row-line text-fg";

// The Octicon git-pull-request glyph.
function PullRequestIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

// The PR cell: a badge with the PR number coloured open or merged, neutral for any other state, `-` with no PR.
export function PrBadge({ url, state }: { url: string | null; state?: string | null }) {
  const number = prNumber(url);
  if (!url || number === null) return <span className="text-dim">-</span>;
  const color = PR_COLORS[state ?? ""] ?? NEUTRAL;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`pull request #${number} ${state ?? "unknown"}`}
      className={`inline-flex items-center gap-[5px] rounded-full px-2 py-0.5 text-sm leading-[18px] font-medium whitespace-nowrap hover:brightness-115 ${color}`}
    >
      <PullRequestIcon />#{number}
    </a>
  );
}
