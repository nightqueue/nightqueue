import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";
import type { Job, JobMeta, JobStreamEnd, NarrationEvent, QueuePatch, QueueSnapshot, Timeline } from "./types";

export const QUEUE_KEY = ["queue"] as const;

// Parses the JSON data of one server-sent event, null when it is not JSON.
function parseData<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T;
  } catch {
    return null;
  }
}

// Applies one patch to a snapshot without mutating it: changed keys replaced, rows upserted, removed and reordered.
export function applyPatch(previous: QueueSnapshot, patch: QueuePatch): QueueSnapshot {
  const next: QueueSnapshot = { ...previous, ...patch.set };
  if (!patch.jobs) return next;
  const byId = new Map<number, Job>(previous.jobs.map((job) => [job.id, job]));
  for (const job of patch.jobs.upsert) byId.set(job.id, job);
  for (const id of patch.jobs.remove) byId.delete(id);
  next.jobs = patch.jobs.order.map((id) => byId.get(id)).filter((job): job is Job => job !== undefined);
  return next;
}

// Subscribes the page to `/events`: the snapshot and its patches land in the query cache; answers whether the last read failed.
export function useQueueStream(): { stale: boolean; error: string | null } {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const source = new EventSource("/events");
    source.addEventListener("snapshot", (event) => {
      const snapshot = parseData<QueueSnapshot>(event as MessageEvent);
      if (!snapshot) return;
      queryClient.setQueryData(QUEUE_KEY, snapshot);
      setError(null);
    });
    source.addEventListener("patch", (event) => {
      const patch = parseData<QueuePatch>(event as MessageEvent);
      if (!patch) return;
      queryClient.setQueryData<QueueSnapshot>(QUEUE_KEY, (previous) => (previous ? applyPatch(previous, patch) : previous));
      setError(null);
    });
    source.addEventListener("error", (event) => {
      const data = parseData<{ message?: string }>(event as MessageEvent);
      setError(data?.message ?? "the event stream is reconnecting");
    });
    return () => source.close();
  }, [queryClient]);
  return { stale: error !== null, error };
}

// The last queue snapshot the stream delivered, undefined until the first one arrives.
export function useQueueSnapshot(): QueueSnapshot | undefined {
  const { data } = useQuery<QueueSnapshot>({ queryKey: QUEUE_KEY, queryFn: () => Promise.reject(new Error("the queue only comes from /events")), enabled: false, staleTime: Infinity });
  return data;
}

export interface JobStreamState {
  meta: JobMeta | null;
  events: NarrationEvent[];
  timeline: Timeline | null;
  files: string[];
  ended: JobStreamEnd | null;
  error: string | null;
}

type JobStreamAction =
  | { type: "reset" }
  | { type: "meta"; meta: JobMeta }
  | { type: "narration"; events: NarrationEvent[] }
  | { type: "timeline"; timeline: Timeline }
  | { type: "files"; files: string[] }
  | { type: "end"; ended: JobStreamEnd }
  | { type: "resume" }
  | { type: "error"; message: string };

const EMPTY_JOB_STREAM: JobStreamState = { meta: null, events: [], timeline: null, files: [], ended: null, error: null };

// Folds one job stream event into the state of the job screen.
function jobStreamReducer(state: JobStreamState, action: JobStreamAction): JobStreamState {
  switch (action.type) {
    case "reset":
      return EMPTY_JOB_STREAM;
    case "meta":
      return { ...EMPTY_JOB_STREAM, meta: action.meta };
    case "narration":
      return { ...state, events: [...state.events, ...action.events] };
    case "timeline":
      return { ...state, timeline: action.timeline };
    case "files":
      return { ...state, files: action.files };
    case "end":
      return { ...state, ended: action.ended };
    case "resume":
      return { ...state, ended: null, error: null };
    case "error":
      return { ...state, error: action.message };
  }
}

// The `end` event of a job stream, its `final` coerced to a boolean whatever the wire carried.
function streamEnd(data: Partial<JobStreamEnd>): JobStreamEnd {
  return { status: data.status ?? null, reason: data.reason ?? null, final: data.final === true };
}

// Subscribes to `/events?job=<ref>` once per job: run paths, narration of every attempt, timeline and files; it closes only on a final end.
export function useJobStream(ref: string): JobStreamState {
  const [state, dispatch] = useReducer(jobStreamReducer, EMPTY_JOB_STREAM);
  useEffect(() => {
    dispatch({ type: "reset" });
    const source = new EventSource(`/events?job=${encodeURIComponent(ref)}`);
    const on = <T,>(name: string, handle: (data: T) => void) =>
      source.addEventListener(name, (event) => {
        const data = parseData<T>(event as MessageEvent);
        if (data !== null) handle(data);
      });
    on<JobMeta>("meta", (meta) => dispatch({ type: "meta", meta }));
    on<NarrationEvent[]>("narration", (events) => dispatch({ type: "narration", events }));
    on<Timeline>("timeline", (timeline) => dispatch({ type: "timeline", timeline }));
    on<string[]>("files", (files) => dispatch({ type: "files", files }));
    on<Partial<JobStreamEnd>>("end", (data) => {
      const ended = streamEnd(data);
      dispatch({ type: "end", ended });
      if (ended.final) source.close();
    });
    on<unknown>("resume", () => dispatch({ type: "resume" }));
    source.addEventListener("error", () => dispatch({ type: "error", message: "the job stream is unavailable" }));
    return () => source.close();
  }, [ref]);
  return state;
}
