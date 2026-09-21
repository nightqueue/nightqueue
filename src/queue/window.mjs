// Matches a wall-clock time written exactly `HH:MM`, two digits each; `9:05` is refused on purpose.
const CLOCK_PATTERN = /^([0-9]{2}):([0-9]{2})$/;

// Parses a wall-clock time written `HH:MM` (00-23 : 00-59), or null when it is not exactly that shape.
export function parseWallClock(text) {
  const match = CLOCK_PATTERN.exec(text ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// The instant of a clock time on the same local calendar day as the reference instant.
function atClock(clock, referenceMs) {
  const date = new Date(referenceMs);
  date.setHours(clock.hour, clock.minute, 0, 0);
  return date.getTime();
}

// The instant a clock time falls at once its calendar day is shifted by the given number of days; a local `setDate`
// (never fixed millisecond arithmetic) is what keeps the wall-clock time correct across a DST change.
function shiftDay(ms, deltaDays) {
  const date = new Date(ms);
  date.setDate(date.getDate() + deltaDays);
  return date.getTime();
}

// The most recent occurrence of a clock time at or before the reference instant.
function occurrenceAtOrBefore(clock, referenceMs) {
  const candidate = atClock(clock, referenceMs);
  return candidate > referenceMs ? shiftDay(candidate, -1) : candidate;
}

// The next occurrence of a clock time at or after the reference instant.
function occurrenceAtOrAfter(clock, referenceMs) {
  const candidate = atClock(clock, referenceMs);
  return candidate < referenceMs ? shiftDay(candidate, 1) : candidate;
}

// The next occurrence of a clock time strictly after the reference instant.
function occurrenceAfter(clock, referenceMs) {
  const candidate = atClock(clock, referenceMs);
  return candidate <= referenceMs ? shiftDay(candidate, 1) : candidate;
}

// Resolves `--from`/`--until` (local wall-clock `HH:MM`, `from` optional) into the absolute instants a watch window
// runs between, computed once against `nowMs`. `from` defaults to now; otherwise it is the next occurrence of that
// time, UNLESS now already falls inside the window that occurrence's most recent past instance would open - then
// `from` is now itself. `until` is always the first occurrence of that time after the resolved `from`.
export function resolveWindow({ from = null, until, nowMs = Date.now() }) {
  const untilClock = parseWallClock(until);
  if (!untilClock) throw new Error(`invalid \`until\` clock: ${until}`);
  if (from === null) return { fromMs: nowMs, untilMs: occurrenceAfter(untilClock, nowMs) };
  const fromClock = parseWallClock(from);
  if (!fromClock) throw new Error(`invalid \`from\` clock: ${from}`);
  const pastFrom = occurrenceAtOrBefore(fromClock, nowMs);
  const untilCandidate = occurrenceAfter(untilClock, pastFrom);
  if (nowMs >= pastFrom && nowMs < untilCandidate) return { fromMs: nowMs, untilMs: untilCandidate };
  const fromMs = occurrenceAtOrAfter(fromClock, nowMs);
  return { fromMs, untilMs: occurrenceAfter(untilClock, fromMs) };
}

// Where `nowMs` falls against a resolved window: before it opened, inside it, or past its `until` (exclusive, the instant it closes).
export function windowPhase({ fromMs, untilMs, nowMs = Date.now() }) {
  if (nowMs < fromMs) return "before";
  if (nowMs >= untilMs) return "after";
  return "inside";
}
