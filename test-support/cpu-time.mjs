const PROBE_INTERVAL_MS = 10;

// Milliseconds of CPU the calling thread has run, blind to the time a loaded machine kept it off a core.
export function threadCpuMs() {
  const usage = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

// Measures, until the returned stop is called, the longest CPU run of this thread between two turns of a 10 ms timer.
export function loopStallProbe() {
  let last = threadCpuMs();
  let worst = 0;
  const timer = setInterval(() => {
    const now = threadCpuMs();
    worst = Math.max(worst, now - last);
    last = now;
  }, PROBE_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    return Math.max(worst, threadCpuMs() - last);
  };
}
