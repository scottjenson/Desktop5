// Shared constants for the desktop prototype.

// Internal desktop resolution (ultrawide-ish). The WebGL canvas renders at this
// size and is CSS-scaled to fit the viewport, producing black bars top/bottom.
export const DESKTOP_W = 3440;
export const DESKTOP_H = 1440;

// Chrome dimensions (desktop px)
export const TITLEBAR_H     = 30; // draggable strip at top of each window
export const MENUBAR_H      = 39; // min margin when clamping a window
export const DOCK_CLEARANCE = 120; // keep windows above the dock

// Camera / depth
export const FOV      = 45;
export const CAMERA_Z = 6;
export const Z_STEP   = 0.01; // world-z gap between stacked / focused windows

// Render supersample. The WebGL draw buffer = DESKTOP size × this factor, fixed and
// DELIBERATELY decoupled from the display's devicePixelRatio: projectors report dpr 1
// and would otherwise quarter the buffer, under-resolving the dense grid flanks. We
// render large and let CSS downscale (supersampling) so quality is projector-proof.
// Bump to 2.5–3 for more crispness if the GPU holds 60fps; drop to 1.5 if it stutters.
export const RENDER_SUPERSAMPLE = 2;

// Dynamic drag-shrink: a central plateau stays full-size; a window shrinks
// toward the edges so it can be "placed back" in space (scale, not real z).
export const PLATEAU_FRAC    = 0.5;  // central fraction used for zone layout & snap positions
export const SHRUNK_PX       = 110;  // ~icon target width (px) for a window at the edge

// ── UX Tension Warp dials (SHARED by the grid shader AND window scaling) ──
// The background grid's X coordinate is warped by a power curve; the window scale
// is the analytical derivative of that same curve, so the grid compresses at exactly
// the rate windows shrink. These three values MUST stay identical in both places —
// they are the single source of truth, imported by both main.js and windows.js.
export const WARP_DEADZONE   = 0.5;  // |x| (normalized -1..1): center 50% (1720px) stays orthogonal; 25% flanks warp
export const WARP_POWER      = 3.0;  // cubic: w''(0)=0 → C²-smooth bend at the dead-zone boundary (no kink)
export const WARP_STRENGTH   = 1.33; // compensates the cubic so edge localScale ≈ 1/9 (3·1.33·2·innerDeriv ≈ 8)
export const SNAP_ZONE_STEP    = 100;  // px of horizontal movement to trigger edge zone highlight
export const SHAKE_MIN_TRAVEL  = 20;   // min px between reversals to count (filters jitter)
export const SHAKE_WINDOW_MS   = 500;  // rolling time window for reversal timestamps
export const SHAKE_COUNT       = 4;    // number of reversals to trigger parkAll
export const MID_SCALE       = 0.5;  // scale for mid-zone parked windows (zones 1 and 4)
export const MIN_SCALE       = 0.20; // minimum scale during live drag (edge floor)
export const GRID_CELL_PX    = 86;   // baseline grid cell size: 3440/86 = exactly 40 columns across the desktop

// ── Grid line look (Phase 2 aesthetics; all widths in screen px) ──
// Each line = a crisp near-white CORE + a soft tinted GLOW halo. Sizing in pixels (via
// the /fwidth distance) keeps the look consistent at any compression, and the soft glow
// survives projector downscaling far better than a 1px line. Venue-tweakable.
export const GRID_LINE_CORE_PX = 1.5; // core half-width: crisp center of each line
export const GRID_LINE_GLOW_PX = 6.0; // glow falloff radius around each line
export const GRID_GLOW_STRENGTH = 0.5; // 0..1 brightness of the glow halo
export const GRID_EDGE_FADE_START = 0.65; // |x| (normalized -1..1) where lines begin fading; 0 at the very edge
export const GRID_INTENSITY    = 0.5;  // global multiplier on core + glow (1.0 = full, 0.5 = half)
