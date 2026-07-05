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

// Render supersample: minimum device-px density AND buffer cap. fitCanvas() sizes the
// draw buffer to displayed CSS px × max(devicePixelRatio, this) — so a dpr-1 projector
// still gets ≥2× supersampling on the dense grid flanks, while a retina laptop renders
// its native pixel count instead of a fixed DESKTOP×2 (which was 4× what it could show).
// Total buffer is capped at DESKTOP size × this factor (the old fixed-buffer ceiling).
export const RENDER_SUPERSAMPLE = 2;

// Dynamic drag-shrink: a central plateau stays full-size; a window shrinks
// toward the edges so it can be "placed back" in space (scale, not real z).
export const SHRUNK_PX       = 110;  // ~icon target width (px) for a window at the edge

// Stash columns (shake-to-stash / shift-click park): TWO per side, WARP-DERIVED —
// each column's scale is getWindowScale() at its x, so a parked window sits exactly
// on the drag-shrink curve (no scale jump when re-grabbed). Positions are hand-placed
// for lateral clearance with the widest window (760px) in both columns at once:
// edge zone (0–200) | outer col ≈0.22 (202–368) | inner col ≈0.62 (386–854) | plateau (860+).
// Inner sits as close to the plateau as the widest window allows (854 vs 860) to
// maximize its warp-derived zoom — 625+ would poke into the orthogonal area.
// Left-side px; the right side mirrors (DESKTOP_W − cx).
export const STASH_INNER_CX = 620; // recent windows park here (larger)
export const STASH_OUTER_CX = 285; // overflow parks here (smaller)

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
export const MIN_SCALE       = 0.20; // minimum scale during live drag (edge floor)
export const GRID_CELL_PX    = 86;   // baseline grid cell size: 3440/86 = exactly 40 columns across the desktop

// ── Grid line look (Phase 2 aesthetics; all widths in screen px) ──
// Each line = a crisp near-white CORE + a soft tinted GLOW halo. Sizing in pixels (via
// the /fwidth distance) keeps the look consistent at any compression, and the soft glow
// survives projector downscaling far better than a 1px line. Venue-tweakable.
export const GRID_LINE_CORE_PX = 1.5; // core half-width: crisp center of each line
export const GRID_LINE_GLOW_PX = 6.0; // glow falloff radius around each line
export const GRID_GLOW_STRENGTH = 0.5; // 0..1 brightness of the glow halo
export const GRID_EDGE_FADE_START = 0.65; // |x| (normalized -1..1) where lines begin fading toward the floor
export const GRID_EDGE_FADE_FLOOR = 0.35; // brightness the edge fade bottoms out at (NOT 0 — grid stays visible to the edge)
export const GRID_INTENSITY    = 0.5;  // global multiplier on core + glow (1.0 = full, 0.5 = half)

// Drag Rails (Phase 3): horizontal lines behind a dragged window brighten + thicken.
export const HIGHLIGHT_GAIN      = 1.6; // extra brightness/opacity on highlighted horizontals (additive multiplier)
export const HIGHLIGHT_THICKNESS = 2.2; // core/glow width multiplier for highlighted horizontals (thicker = more "rail")
export const HIGHLIGHT_FADE_IN_MS  = 150; // u_dragActive 0→1 on mousedown
export const HIGHLIGHT_FADE_OUT_MS = 250; // u_dragActive 1→0 on mouseup

// Window texture supersample (Pass 1 "B", plans/morph-readability.md): rasterize each
// window's DOM at this factor (CSS zoom + enlarged source bitmap; mesh size unchanged)
// so GPU minification during morph/park has more texels. three r184 hardcodes LINEAR
// filtering for HTMLTexture uploads (no mipmaps), so this is the only quality lever.
// 1 = off (exact legacy behavior). Costs ~SS² texture memory + repaint px. Try 2 and
// compare parked/morphed text; if full-size windows look softer, drop back to 1.
export const WINDOW_SUPERSAMPLE = 1;

// Window Morph (demo): subdivide window meshes so vertices can bend along the grid warp.
// At u_warpBlend = 0 a subdivided plane renders pixel-identical to a flat quad (~free).
export const MORPH_SEGMENTS_X = 40; // horizontal segments — enough to bend smoothly across the warp boundary
export const MORPH_FADE_MS    = 220; // u_warpBlend 0↔1 animation on toggle

// Exposé (hold "e"): pack all visible windows, non-overlapping, into ≈√n centered rows
// — the classic-Mac contrast demo. One uniform scale for every window (that's what
// makes it read as Exposé), derived from area so the cluster stays tight on the ultrawide.
export const EXPOSE_BOX_FRAC  = 0.65; // fraction of desktop width the cluster may occupy
export const EXPOSE_GAP_PX    = 40;   // spacing between windows (and between rows)
export const EXPOSE_MAX_SCALE = 0.6;  // scale ceiling so no window looks near-full-size
export const EXPOSE_FILL      = 0.55; // target fraction of the box area the windows fill

// Music compact mode: when the music window shrinks past this scale (≈ parking at the
// edge), swap to a stripped-down layout with one giant Play/Pause button. The button
// size is shared by the JS hit-rect and the CSS (#win-music.compact .music-play-btn),
// expressed in the music bitmap's own px (canvas is 680×480); keep the two in sync.
// Threshold is pinned between two deterministic neighbors: strictly ABOVE the live-drag
// MIN_SCALE floor (0.20 — a plain drag to the bezel rests exactly there, and must go
// compact) and strictly BELOW the outer stash column (≈0.219 — parked windows must
// keep the full layout). The margins are thin but both bounds are computed, not measured.
export const MUSIC_COMPACT_SCALE   = 0.21; // mesh.scale.x threshold to enter compact mode
export const MUSIC_COMPACT_BTN_PX  = 280; // giant play button size, centered in the 680×480 bitmap
