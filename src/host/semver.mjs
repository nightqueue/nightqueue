const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// Splits a version into its three numbers and its prerelease identifiers, or null when the text is not a semver.
export function parseVersion(text) {
  const match = typeof text === "string" ? SEMVER.exec(text.trim()) : null;
  if (!match) return null;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split(".") : [] };
}

// Orders two strings the way semver orders alphanumeric identifiers.
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Orders two prerelease identifiers: numbers among themselves, and a number always below anything alphanumeric.
function compareIdentifier(a, b) {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return compareText(a, b);
}

// Orders two prerelease lists, where a version with no prerelease is above the same version with one.
function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const order = compareIdentifier(a[i], b[i]);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

// Orders two version strings as -1, 0 or 1, and answers null when either side is not a semver.
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < left.numbers.length; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return Math.sign(left.numbers[i] - right.numbers[i]);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

// Tells whether the published version is really above the installed one; a version this comparator cannot read is never newer.
export function isNewerVersion(latest, current) {
  return compareVersions(latest, current) === 1;
}
