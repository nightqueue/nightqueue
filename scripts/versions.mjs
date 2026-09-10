const CHANGELOG_ENTRY = /^## (\d+\.\d+\.\d+) - \d{4}-\d{2}-\d{2}$/m;
const LICENSE_PARAMETER = /^Licensed Work:\s+nightshift (\S+)\s*$/m;

export const CHANGELOG_FORMAT = "## <version> - YYYY-MM-DD";
export const LICENSE_FORMAT = "Licensed Work:        nightshift <version>";

// Version of the top entry of the changelog, or null when no heading has the required shape.
export function changelogVersion(text) {
  return CHANGELOG_ENTRY.exec(String(text ?? ""))?.[1] ?? null;
}

// Version the license parameters declare as the licensed work, or null when the parameter has another shape.
export function licenseVersion(text) {
  return LICENSE_PARAMETER.exec(String(text ?? ""))?.[1] ?? null;
}

// Message of one source that does not agree with the manifest, or null when it does; a version that could not be read is always a disagreement.
function mismatch({ file, format, version, manifest }) {
  if (version === null) return `${file} declares no version; expected a line \`${format}\``;
  if (version !== manifest) return `${file} declares ${version}, package.json declares ${manifest}`;
  return null;
}

// Every source whose version does not match the one of the manifest, one message each, empty when the release is coherent.
export function versionMismatches({ manifest, changelog, license }) {
  return [
    mismatch({ file: "CHANGELOG.md", format: CHANGELOG_FORMAT, version: changelogVersion(changelog), manifest }),
    mismatch({ file: "LICENSE", format: LICENSE_FORMAT, version: licenseVersion(license), manifest }),
  ].filter((message) => message !== null);
}

// Escapes a value so it can sit literally inside a regular expression.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Body of the changelog entry of one version - the text between its `## <version>` heading and the next `## ` heading - or null when that version has no heading.
export function changelogSection(text, version) {
  if (typeof version !== "string" || !version) return null;
  const lines = String(text ?? "").split("\n");
  const heading = new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith("## "));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
}
