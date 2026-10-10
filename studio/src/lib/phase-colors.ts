export type PhaseRole = "triager" | "explore" | "architect" | "coder" | "qa-guardian" | "verifier" | "system";

export const PHASE_HEX: Record<PhaseRole, string> = {
  triager: "#3987e5",
  explore: "#d95926",
  architect: "#199e70",
  coder: "#c98500",
  "qa-guardian": "#d55181",
  verifier: "#9085e9",
  system: "#4b5568",
};

const AGENT_ROLES = new Set<string>(["triager", "explore", "architect", "coder", "qa-guardian", "verifier"]);

// The colour role of a routing agent, normalised to kebab-case; any slot without an agent is `system`.
export function phaseRole(agent: string | null | undefined): PhaseRole {
  if (typeof agent !== "string") return "system";
  const kebab = agent
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  return AGENT_ROLES.has(kebab) ? (kebab as PhaseRole) : "system";
}

// The CSS variable of an agent's colour, the one every track and share bar paints with.
export function phaseVar(agent: string | null | undefined): string {
  return `var(--ph-${phaseRole(agent)})`;
}

// The hex of an agent's colour.
export function phaseHex(agent: string | null | undefined): string {
  return PHASE_HEX[phaseRole(agent)];
}
