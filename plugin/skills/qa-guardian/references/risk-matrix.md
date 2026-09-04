# Risk scenario matrix

Checklist to exhaust the data possibilities that cause bugs. Tick only the ones
applicable to the target code.

## A. API data (server response)

- `null` / `undefined` response where the code expects an object.
- Optional field missing but accessed as mandatory (`data.user.name`).
- Empty array treated as if it always had items (`list[0]`, `.map` without fallback).
- Array where an object was expected (or the other way around).
- Type diverging from the contract (string where a number is expected, `"true"` vs `true`).
- Number as a string ("12.50") used in a calculation.
- **Comma as the decimal separator (comma-decimal locales): "12,50" used in a
  numeric operation. ALWAYS turn the comma into a dot before any calculation —
  normalize `"12,50"` → `12.50` and convert to number. `Number("12,50")` and
  `parseFloat("12,50")` return `NaN` or truncate. Consider the thousands
  separator too ("1.234,56") and currency ("€ 1.234,56"): strip symbols and
  thousands separators, swap the comma for a dot, then convert.**
- Dates in an unexpected format / timezone / `Invalid Date`.
- Enum/status with a new value not covered by the `switch`.
- Pagination: inconsistent total, null cursor, last page.
- HTTP errors (4xx/5xx) with no handling; error body shaped differently from the success one.
- Timeout / network down / aborted request.
- 200 response but with an error payload embedded in it.
- Encoding / special characters / emojis breaking the parsing.
- Very large values (overflow, float precision, `BigInt`).
- Race condition: responses out of order, stale state set after unmount.
- Duplicate data or repeated keys in lists (React key).

## B. User input

- Empty field / only spaces / whitespace.
- String where a number is expected and the other way around.
- Negative values, zero, maximum/minimum, range boundaries.
- Very long text (database limit, broken layout).
- Special characters, HTML/script (XSS), quotes, line breaks.
- Injection (SQL/NoSQL/command) in fields sent to the backend.
- Double submission (double click) / request spam.
- Upload: empty file, wrong type, size exceeded, malicious name.
- Pasting formatted data (currency symbols, %, comma vs dot as decimal separator).
- **Number typed with a comma ("12,50", "1.234,56") — comma-decimal locales.
  Fixed rule: always normalize the comma to a dot before operating
  numerically. Validate the result against `NaN` after the conversion.**
- Locale: decimal separator, date format per region.
- Navigation: back/forward, reload in the middle of the flow, deep link without state.

## C. State and UI (React)

- Loading with no skeleton (project rule: skeleton is mandatory).
- Error state with no error UI.
- Empty state not handled.
- `useEffect` without cleanup causing a memory leak / set after unmount.
- Hook dependencies incomplete or excessive.
- Infinite re-render caused by an unstable reference.
- Access to a null `ref.current`.

## D. Logic and boundaries

- Division by zero / modulo by zero.
- Off-by-one in loops and slices.
- Inverted boolean condition or incomplete case coverage.
- Accidental mutation of state/props.
- Floating point comparison by equality.
- Concurrency: multiple writes to the same resource.

## E. Robustness test (chaos / unpredictable use)

Premise: imagine chaotic, unpredictable use — someone in front of the system,
reading nothing, pressing everything. The system **can never hang, break or
enter an inconsistent state**. Every wrong input needs protection or graceful
handling (validation, fallback, clear message, state preserved). For every
changed flow/screen/endpoint, simulate it mentally and record what happens:

- Random clicks anywhere on the screen, including areas with no action.
- Clicking the same button many times in fast succession (click spam).
- Clicking buttons/actions before loading finishes (state not ready).
- Pressing Enter/keys on empty fields or with random focus.
- Typing garbage: random text where a number is expected, emoji, control
  characters, a giant pasted string, spaces, line breaks.
- Submitting a form with nothing filled in / with only some of the fields.
- Submitting random data in an impossible order (skipping steps, going back midway).
- Reloading, going back/forward in the browser and opening deep links mid-flow.
- Dragging, resizing, closing and reopening in the middle of an operation.
- For APIs: payload with missing fields, swapped types, absurd values, empty
  body, malformed JSON — the API answers with a handled error, never goes down.

Approval rule: if any random action takes the system down, corrupts state or
raises an unhandled error, it is severity **high**. The target is: invalid
input always has protection or is handled with a safe message/state.
