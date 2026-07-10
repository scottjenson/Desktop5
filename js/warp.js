// Warp-curve math + edge/stash geometry: the stateless helpers shared by window
// dragging, drag rails, and parking. Everything here is a pure function of config
// dials — no scene or DOM state.

import {
  DESKTOP_W, SHRUNK_PX, MIN_SCALE, STASH_INNER_CX, STASH_OUTER_CX,
  WARP_DEADZONE, WARP_POWER, WARP_STRENGTH, DESKTOP_H,
} from './config.js';

// Window scale as a function of normalized horizontal position (xPos ∈ -1..1, 0 = centre).
// This is the exact analytical derivative of the background grid's warp curve
// (gridX = x + sign(x)·flankDist^power·strength): the window shrinks at precisely the
// rate the grid compresses. Dials live in config.js and are shared with the shader,
// so the two physics can never drift. Width-independent — every window shrinks to the
// same factor at a given x (≈1/9 at the screen edge with the default dials).
export function getWindowScale(xPos) {
  const flankDist = Math.max(0, Math.abs(xPos) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  const innerDeriv = 1 / (1 - WARP_DEADZONE);
  const derivative = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH * innerDeriv;
  return Math.max(MIN_SCALE, 1 / (1 + derivative));
}

// The GRID's local scale at a normalized x — same curve as getWindowScale but UNCLAMPED.
// The shader's gridYcoord = centerY / localScale uses this exact (un-floored) value, so the
// drag band must too, or it would drift from the lines once the window hits MIN_SCALE.
export function gridLocalScale(xPos) {
  const flankDist = Math.max(0, Math.abs(xPos) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  const innerDeriv = 1 / (1 - WARP_DEADZONE);
  const derivative = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH * innerDeriv;
  return 1 / (1 + derivative);
}

// Forward warp f(xs): PHYSICAL normalized x → LOGICAL normalized x. Closed form —
// the same curve the grid shader draws and the morph vertex shader inverts with
// Newton; the forward direction needs no iteration.
export function warpForward(xsNorm) {
  const flankDist = Math.max(0, Math.abs(xsNorm) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  return xsNorm + Math.sign(xsNorm) * Math.pow(flankDist, WARP_POWER) * WARP_STRENGTH;
}

// Newton inverse of warpForward (mirrors the morph vertex shader): LOGICAL
// normalized x → PHYSICAL normalized x. 4 iterations = sub-pixel on this smooth
// monotonic curve.
export function warpInverse(xwNorm) {
  let xs = xwNorm;
  for (let i = 0; i < 4; i++) {
    const flankDist = Math.max(0, Math.abs(xs) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
    const deriv = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH / (1 - WARP_DEADZONE);
    xs -= (warpForward(xs) - xwNorm) / (1 + deriv);
  }
  return xs;
}

// Physical ↔ logical desktop px (x only) — px-space wrappers around warpForward/
// warpInverse. Flat-window drags keep the grab offset constant in LOGICAL space:
// getWindowScale is 1/f′ of this same curve, so a constant logical offset renders
// as a physical offset that shrinks in proportion to the window, keeping the
// grabbed point under the cursor (a fixed physical offset makes the cursor race
// ahead of / lag behind the window as it shrinks).
export function physToLogicalX(px) {
  return (warpForward((px - DESKTOP_W / 2) / (DESKTOP_W / 2)) + 1) * (DESKTOP_W / 2);
}
export function logicalToPhysX(lx) {
  return (warpInverse(lx / (DESKTOP_W / 2) - 1) + 1) * (DESKTOP_W / 2);
}

// Physical cursor (desktop px) → LOGICAL desktop px, for dragging MORPHED windows.
// The raycaster returns physical coords but a morphed mesh's position is logical —
// the gap documented in plans/vertex-warp-experiment.md ("runs away" drag). Y per
// shape mode: 0 (faithful) pulls Y toward the screen equator by localScale, so
// divide it back out at the cursor's x; 1 (creased) pivots on the window's own
// centerline, so the window CENTER needs no Y correction.
export function cursorToLogical(cxPhys, cyPhys, morphMode) {
  const xsNorm = (cxPhys - DESKTOP_W / 2) / (DESKTOP_W / 2);
  const cx = (warpForward(xsNorm) + 1) * (DESKTOP_W / 2);
  let cy = cyPhys;
  if (morphMode === 0) {
    cy = DESKTOP_H / 2 - (DESKTOP_H / 2 - cyPhys) / gridLocalScale(xsNorm);
  }
  return { cx, cy };
}

// Edge zones: icon-sized positions at the far left and right (shift-drag snap target).
const _iW = SHRUNK_PX + 90; // edge zone width (~200px)

export const EDGE_ZONES = [
  { left: 0,               width: _iW }, // left edge
  { left: DESKTOP_W - _iW, width: _iW }, // right edge
];

// Snap position for the edge zones (icon-sized, shift-drag release).
export function snapToEdge(isLeft, info) {
  const iconScale = SHRUNK_PX / info.w;
  return isLeft
    ? { cx: SHRUNK_PX / 2,             scale: iconScale }
    : { cx: DESKTOP_W - SHRUNK_PX / 2, scale: iconScale };
}

// Stash columns: two per side (inner ≈0.62, outer ≈0.22 — positions in config.js).
// Scale is WARP-DERIVED — getWindowScale at the column's x — so every parked window
// sits exactly on the drag-shrink curve and re-grabbing it causes no scale jump.
export function stashColumn(isLeft, inner) {
  const px = inner ? STASH_INNER_CX : STASH_OUTER_CX;
  const cx = isLeft ? px : DESKTOP_W - px;
  return { cx, scale: getWindowScale((cx - DESKTOP_W / 2) / (DESKTOP_W / 2)) };
}
