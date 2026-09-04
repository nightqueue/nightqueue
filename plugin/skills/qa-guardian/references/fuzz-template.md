# Fuzz template — robustness test (Layer 1: input/logic)

Property-based testing with **fast-check**. It generates hundreds of random
inputs and proves the target function **never raises an unhandled error** and
always returns a safe shape. It is the cheap, deterministic layer of the
robustness test: it covers "typing garbage / absurd payload" without needing a
running app.

It runs inside the test runner the project already has (vitest/jest).
fast-check is just a library used inside a normal test — it does not require a
separate runner.

## When to generate one

Generate a fuzz test for every changed function that **takes external data and
interprets it**: parsers, normalizers (e.g. money in a comma-decimal locale,
"12,50"), validators, reducers, API response deserializers, form input
mappers. Do not generate fuzz for a trivial pure function with no external
input.

## Convention

- Name: `<module>.fuzz.test.ts` (or `.spec.ts`, following the project's
  pattern), next to the code or in `__fuzz__/`.
- **Always a fixed seed** (`{ seed, numRuns }`) → reproducible failure.
- `numRuns`: 300–1000. Start at 500.
- Install fast-check as a devDependency with the project's package manager
  (`pnpm add -D fast-check` / `yarn add -D fast-check` / `npm i -D fast-check`).

## Failure rule (what counts as a break)

The test FAILS if the function:

1. Raises an unhandled exception with random input.
2. Returns a shape outside the contract (e.g. `NaN`, `undefined` where
   `number | null` was promised).
3. Corrupts/mutates the input.

Approval = every wrong input becomes a handled error, a fallback or a safe value.

## Reusable helper

```ts
// test-utils/fuzz.ts
import fc from 'fast-check';

// runs the property with a fixed seed; fails with the minimized input in the log
export function fuzz<T>(arb: fc.Arbitrary<T>, prop: (v: T) => void, seed = 42) {
  fc.assert(fc.property(arb, prop), { seed, numRuns: 500 });
}

// garbage a chaotic user would type: empty, spaces, emoji, control, huge, locale
export const garbage = fc.oneof(
  fc.string(),
  fc.constantFrom('', '   ', '\n', '\t', '0', '-0', 'NaN', 'undefined', 'null'),
  fc.constantFrom('12,50', '1.234,56', '€ 1.234,56', '1e999', '٤٢', '😀🔥'),
  fc.string({ minLength: 5000, maxLength: 10000 }),
  fc.unicodeString(),
);
```

## Example — locale-aware money parser

```ts
import { fuzz, garbage } from '../test-utils/fuzz';
import { parseMoney } from '../src/parseMoney';

test('parseMoney never throws and never returns NaN', () => {
  fuzz(garbage, (input) => {
    const r = parseMoney(input);                 // must not throw
    if (r !== null) {
      expect(typeof r).toBe('number');
      expect(Number.isNaN(r)).toBe(false);       // contract: number | null
    }
  });
});
```

## Example — API response deserializer

```ts
import fc from 'fast-check';
import { fuzz } from '../test-utils/fuzz';
import { mapUser } from '../src/mapUser';

// payload with missing fields, swapped types and absurd values
const payload = fc.record({
  id: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)),
  name: fc.oneof(fc.string(), fc.constant(null)),
  balance: fc.oneof(fc.double(), fc.string(), fc.constant(undefined)),
}, { requiredKeys: [] });

test('mapUser tolerates a corrupted payload', () => {
  fuzz(payload, (p) => {
    expect(() => mapUser(p as any)).not.toThrow();
  });
});
```

## If the project is not TS/JS

- Python → **Hypothesis** (`@given`, `pytest`).
- Go → native fuzzing (`func FuzzX(f *testing.F)`, `go test -fuzz`).
- Rust → `proptest` or `cargo fuzz`.

Same principle: random input, the function never breaks, fixed seed.
