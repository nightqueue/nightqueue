import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from "lucide-react";
import { prNumber } from "../lib/format";
import { ActionIcon } from "./StatusIcon";

const PR_VISUALS: Record<string, { Icon: LucideIcon; color: string }> = {
  open: { Icon: GitPullRequest, color: "bg-pr-open text-white" },
  merged: { Icon: GitMerge, color: "bg-pr-merged text-white" },
  closed: { Icon: GitPullRequestClosed, color: "bg-pr-closed text-white" },
  draft: { Icon: GitPullRequestDraft, color: "bg-pr-draft text-white" },
};

const NEUTRAL = { Icon: GitPullRequest, color: "bg-row-line text-fg" };

// The PR cell: a badge with the PR icon and number in GitHub's colour for its state, neutral for any other, `-` with no PR.
export function PrBadge({ url, state }: { url: string | null; state?: string | null }) {
  const number = prNumber(url);
  if (!url || number === null) return <span className="text-dim">-</span>;
  const { Icon, color } = PR_VISUALS[state ?? ""] ?? NEUTRAL;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`pull request #${number} ${state ?? "unknown"}`}
      className={`inline-flex items-center gap-[5px] rounded-full px-2 py-0.5 text-sm leading-[18px] font-medium whitespace-nowrap hover:brightness-115 ${color}`}
    >
      <ActionIcon icon={Icon} />#{number}
    </a>
  );
}
