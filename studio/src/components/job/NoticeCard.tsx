import { noticeOf } from "../../lib/job";
import type { JobDetail } from "../../lib/types";
import { Card, CardEmpty } from "./Card";
import { Markdown } from "./Markdown";

// The notice card of a job not at a gate: its notice as safe markdown, or the sentence saying it comes at the end.
export function NoticeCard({ job }: { job: JobDetail }) {
  const notice = noticeOf(job);
  return (
    <Card label="notice" title="Notice">
      {notice ? <Markdown source={notice} className="max-h-[320px] overflow-auto pr-1" /> : <CardEmpty>None yet — the job writes it at the end.</CardEmpty>}
    </Card>
  );
}
