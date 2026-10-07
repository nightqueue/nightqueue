export const DEFAULT_WIDTH = 560;
export const MIN_WIDTH = 320;
export const MAX_SHARE = 0.7;

// Bounds a dock width between the minimum and 70 % of the viewport, never wider than the viewport; a non-finite value falls back to the default.
export function clampDockWidth(width: number, viewport: number): number {
  const max = Math.min(viewport, Math.max(MIN_WIDTH, Math.round(viewport * MAX_SHARE)));
  const value = Number.isFinite(width) ? width : DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(value), MIN_WIDTH), max);
}
