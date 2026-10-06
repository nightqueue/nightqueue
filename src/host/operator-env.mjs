export const OPERATOR_SESSION_KEYS = ["NIGHTQUEUE_MODE", "NIGHTQUEUE_PROJECT", "NIGHTQUEUE_OPERATOR_PID"];

// A copy of an environment without the variables that mark an operator session, so no child inherits them.
export function withoutOperatorSession(env) {
  const copy = { ...(env ?? {}) };
  for (const key of OPERATOR_SESSION_KEYS) delete copy[key];
  return copy;
}
