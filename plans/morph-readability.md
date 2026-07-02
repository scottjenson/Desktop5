# Morph Readability Exploration (Pass 1 / Pass 2 plan)

## Status: EXPLORATION COMPLETE (2026-07-02). Final state in code: `-` key TOGGLES
two modes — 0 faithful (curved) ↔ 1 creased centered-Y (readable fold). All other
variants (chord, X-only, rectangle, rigid-ink D) were tested, rejected, and REMOVED
from code; their math is recorded below (never committed to git).
Pass 1 (A+B) VERIFIED by Scott — "clear improvement, text far more readable".

### C findings (Scott, 2026-07-02)
* **Faithful (curved)** and **chord trapezoid** are both worth considering; rectangle
  wasn't called out.
* Faithful's win is *gradual onset*: only the part of the window inside the flank
  deforms; the rest stays orthogonal — feels like "rolling off" the center section.
* Chord's win is readability, but it has an **unnatural whole-window shift the moment
  the leading edge first leaves the orthogonal center** — inherent to the chord:
  linearizing corner-to-corner drags the still-in-dead-zone portion into the
  interpolation (lsL < 1 tilts the entire top edge, even the part that "shouldn't
  have started morphing yet").
* → Proposed variant: **hinged chord** — identity (orthogonal) for the portion of the
  window inside the dead zone, straight chord only for the flank portion, creased at
  the dead-zone boundary. Gradual onset like faithful + flat readable ink like chord.
  Crease softens over ~1 mesh segment (hinge falls between vertex columns) — likely
  desirable. IMPLEMENTED as mode 2 (rectangle moved to mode 3; `-` cycles all four).
  Hinges clamp to the window span, so fully-in-flank degenerates to plain chord and
  fully-in-center to identity; content mapping needs no fragment change (piecewise-
  linear placement ⇒ plain vMapUv is exact per piece).
* **TESTED (Scott, screenshots): hinged SOLVES the whole-window slant, but its folded
  text is ENTIRELY unreadable — worse than faithful.** Diagnosis: the Y-pull toward
  the world equator, concentrated into the fold. Each text baseline at world y = c
  maps to slope ∝ c·(ls_edge − 1)/foldWidth — a VERTICAL SHEAR (glyph verticals stay
  vertical while baselines tilt ⇒ skewed, broken-looking letters) that (a) fans —
  lines far from the screen equator tilt more than lines near it — and (b) turns on
  at full strength right at the crease, where glyphs are still full-size (the chord's
  uniform X keeps fold glyphs large, unlike faithful's C²-smooth onset where shear
  and shrink grow together from zero). Readability lesson: text tolerates X
  compression far better than Y shear. → Fix: kill the Y shear in the fold —
  (2a) X-only fold (lines stay horizontal; folded part keeps full height; corners
  lock to grid columns in X but not to the converging horizontals) or (2b) Y-scale
  about the WINDOW centerline (shear ∝ distance from window center ≤ h/2 instead of
  distance to equator — much gentler, keeps a convergence look).
* **Both IMPLEMENTED, replacing the failed equator-sheared crease.** `-` cycle is now:
  0 faithful → 1 chord → 2 creased X-only → 3 creased centered-Y → 4 rectangle.
  Mechanically: modes 2/3 share the hinged X chord; Y now scales about a per-mode
  pivot (`yPivot` 0 = equator for 0/1/4, window centerline for 3; mode 2 leaves Y
  alone). Awaiting Scott's perceptual verdict on 2 vs 3 (no convergence vs
  approximate convergence in the fold).
* **BUG found via Scott's screenshot (still-mangled fold text, mode 3): per-segment
  RIPPLE, not just shear.** Plain `vMapUv` across the converging (trapezoid) quads is
  only affine per triangle; the fold concentrates the scale change into few segments
  over a tall window ⇒ tens of px of per-quad mismatch ⇒ zigzag kinks at every
  segment boundary. (The full-width chord hides it — ~1.5% scale change per segment;
  the earlier plan-note dismissing the trapezoid artifact was wrong for folds.)
  **Fixed:** modes 1/3 now get an exact per-pixel PIECEWISE inverse in the fragment
  shader (fold description passed as varyings `v_foldW/X/S`; same closed-form
  philosophy as Pass 1). Modes 2/4 keep plain vMapUv — their quads stay rectangles,
  which IS exact. Mode 3 is now a fair test: any remaining artifact is true
  convergence shear, not sampling. Mode 2 (X-only) geometrically cannot shear or
  ripple — if it ever looks mangled, that's a new bug, not a design property.
Read alongside `plans/vertex-warp-experiment.md`.
* C: `u_morphMode` per-window uniform (0 faithful / 1 chord / 2 rectangle), cycled by
  the `-` key on the frontmost window, console-logged. Vertex shader factored the
  Newton solver into GLSL functions (same math) to also solve the WINDOW EDGES:
  variants keep all four corners on the grid curve and straighten between them.
  Straight-edge requirement: variant Y-scale linear in PHYSICAL x (xsFinal linear in
  tx AND yScale linear in tx). Fragment: per-pixel warp UV only for mode 0 —
  chord/rect place vertices linearly so plain vMapUv is exact there. "4" resets modes.
* A: per-pixel fragment mapping is live in `morphMaterial` (main.js) — vertex position
  math untouched (silhouette pixel-identical); fragment shader replaces
  `#include <map_fragment>` with the closed-form forward warp; new uniforms
  `u_geomHalfW/H`, varyings `v_phys`/`v_winExt`.
* B: `WINDOW_SUPERSAMPLE` dial in config.js (default 1 = exact legacy path; try 2).
  Bitmap enlarged + CSS `zoom` on `.os-window`; `info.w/h` and all mesh/clamp math
  stay in design (desktop) px; music/finder hit rects are measured zoomed then ÷SS.

## Goal (perception exploration, NOT a fix)
Revisit the "0"-key window morph to see how rendering/shape choices affect *human
perception* of warped windows, informing how the demo talks about this. Deep-flank
text (localScale ≈ 1/9) will never be readable — accepted. The question is how the
morph *feels* in the readable 1–3× compression band, and which variables matter.

**Hard constraint from Scott: the faithful morph's silhouette is sacred.** The
window shape hugging the background grid lines (including the curved-edge trapezoid
from the differential Y-pull) is the core visual illusion. Pass 1 must be
pixel-identical in silhouette; shape changes are opt-in variants only.

## Why morphed text dies — four separable causes
1. **Information limit** (irreducible): 1/9 scale at the bezel. Out of scope.
2. **Anisotropic distortion** (the morph-specific killer): X compresses more than Y,
   and *differentially across the window*. Text survives miniaturization (uniform
   shrink is readable well below 50%) far better than aspect-ratio smearing.
3. **Sliver faceting**: 40 vertex segments ⇒ content is grid-exact only at the 41
   vertex columns, linearly interpolated between ⇒ sampling-rate jumps at 40 seams.
4. **Filtering**: `HTMLTexture` has no mipmaps ⇒ bilinear-only minification aliases
   strokes at 2–6× compression (hurts plain parked windows too, not just morph).

## Key discoveries (don't re-derive)
* **The fragment direction is closed-form.** Vertices need Newton-Raphson
  (logical→physical). A *fragment* knows its physical x and needs the logical one —
  that's the FORWARD warp `f(xs) = xs + sign(xs)·flankDist^p·strength`, one analytic
  evaluation, no iteration. Per-pixel content mapping is exact AND cheaper than the
  sliver approximation.
* **Mipmaps are blocked in three r184.** The `texElementImage2D` upload path in
  `WebGLTextures` HARDCODES `TEXTURE_MIN_FILTER = LINEAR` after every upload and
  never calls `generateMipmap`. Setting `texture.generateMipmaps = true` is stomped.
  Don't patch three internals; the fallback is 2× source rasterization (below).
* **The trapezoid IS the grid-hugging.** The grid's horizontal lines curve toward
  the equator in the flanks (`gridYcoord = centerY / localScale(x)`); the window's
  top/bottom edges follow them only because the Y-pull is per-vertex (differential).
  Uniform per-window Y-scale ⇒ rectangle whose edges cut straight across the curved
  grid lines ⇒ breaks the illusion. (Original "option C" was wrong for this reason.)
* **Chord-trapezoid variant (Scott's insight, promising):** evaluate Y-scale at the
  window's left and right edges and lerp linearly between ⇒ straight-but-slanted
  top/bottom edges whose FOUR CORNERS still land exactly on the grid curve. Edges
  become chords of the curve. Window reads as rigid card leaning into the funnel
  instead of silk. May be a perceptual improvement — that's the experiment.

## The plan — strict order: A+B → C → D
Order rationale: (1) A+B builds the fragment-mapping machinery everything else is a
dial on; (2) one perceptual variable per step — A+B changes rendering quality only
(shape frozen), C changes shape only, D changes ink behavior only; (3) certain win
first, hypotheses judged against the best baseline.

### Pass 1 = A + B (silhouette frozen, pure quality)
* **A — per-pixel content mapping.** Keep the vertex shader's position math
  byte-identical (Newton X + differential Y-pull). Add a varying carrying the
  POST-warp world x (exact at every fragment since positions interpolate exactly).
  In the fragment shader (patch `#include <map_fragment>` via the existing
  `onBeforeCompile`): `xs = v_worldX / u_halfPlaneW; xw = f(xs);
  u = (xw − xwL) / (xwR − xwL)`, with `xwL/xwR` (logical window extent) computed
  per-vertex from `modelMatrix` (origin = window center) + geometry half-width.
  Blend against plain `vMapUv.x` by `u_warpBlend`. Subdivision becomes unnecessary
  for content (`MORPH_SEGMENTS_X` can drop; keep enough segments for the curved
  silhouette edges, which are still vertex-approximated).
* **B — 2× source rasterization dial.** New config constant (e.g.
  `WINDOW_SUPERSAMPLE = 1`, try 2): double the source-canvas bitmap and lay out the
  DOM at 2× (CSS `zoom`), mesh geometry unchanged. ~One mipmap octave of quality in
  the 1–3× band. ⚠️ Plumbing hazard: `info.w/h` currently means BOTH bitmap px and
  desktop px; supersampling splits those (uv→px hit rects like `playHitRect`,
  `fileHits` are in bitmap space; drag clamps are in desktop space). Gate behind the
  config dial, default 1, so it's a pure A/B and easily abandoned.

### C — shape-variant cycling (opt-in, after Pass 1)
A Y-mode uniform in the same vertex shader, ~2 lines per mode:
1. **curved** (faithful, default) — per-vertex localScale (today's shape)
2. **chord trapezoid** — lerp(localScale(xL), localScale(xR)) across the window
3. **rectangle** — localScale(center) uniform
Content mapping unchanged from Pass 1. Aspect-preserving content INSIDE the
unchanged silhouette (content crops at the deeper edge) can be a further dial here —
it's a mild preview of D.

### Pass 2 = D — rigid ink, warped frame — TESTED and REJECTED (Scott, 2026-07-02)
**Verdict: "the central 85% of the window is a flat rectangle and the outside frame
around this rectangle morphs" — read as a picture-frame effect, not the intended
outline-only illusion. Not an interesting direction / would take too long to tune.
REMOVED from code** (with chord, X-only, and rectangle modes) when the `-` key was
simplified to a 2-mode toggle: **0 faithful ↔ 1 creased centered-Y** — the two
survivors of the exploration. Removed variants' math, for reconstruction if ever
needed (none of this was committed to git):
* chord: `xs = mix(xsL, xsR, tx); yScale = mix(lsL, lsR, tx)` (tx linear in logical
  x across the window), equator pivot.
* creased X-only: fold placement as kept mode 1, but `yScale = 1` (no Y change).
* rectangle: `xs = mix(xsL, xsR, tx); yScale = ls(newton(center))`, equator pivot.
* rigid ink (D): faithful silhouette; ink uniformly scaled to the SHALLOW edge's ls,
  anchored there (frame ⊆ ink ⇒ crop-only, no holes); frame band
  `1 − smoothstep(bandIn, bandOut, distToEdge)` in faithful uW/vW coords selected
  warped vs rigid mapping (band dials were MORPH_FRAME_BAND_IN/OUT_PX, removed).

Original D concept notes (pre-test), kept for the record:
Reuses Pass 1's dual-UV machinery: warped UV and rigid UV, mixed by a
distance-from-window-edge band mask ⇒ border/titlebar hugs the grid, interior
content stays proportioned, cropping under the bent edge (paper curls over the
text: space deforms, information doesn't).
Key design resolution (the plan had left this open): rigid ink can't both stay
unsheared AND fill a converging frame, so the ink is uniformly scaled to the
window's SHALLOW edge's localScale and ANCHORED there — frame and ink coincide
exactly at that edge, and since frame width/height ≤ ink size everywhere
(|y|·ls(x) ≤ |y|·sA, monotone ls), the frame is a subset of the ink: **no holes,
no smears, crop-only**, proven for all window positions incl. straddling the
equator. Frame band: `MORPH_FRAME_BAND_IN/OUT_PX` (config) smoothstepped on
distance-to-edge in the frame's faithful uW/vW coordinates — inside BAND_IN the
faithful mapping (titlebar/border bend with the sheet), outside BAND_OUT fully
rigid. Silhouette = faithful mode's, byte-identical (vertex stage shares the
mode-0 branch).

### Demo wiring
* `0` unchanged: morph on/off, frontmost window.
* New key `-` (Scott's choice — adjacent to `0`, easy to remember): cycles variant —
  faithful → chord → rectangle → rigid-ink (D).
* All modes must call `invalidate()` on change (on-demand render loop, Learning #12).

### Effort
Pass 1 ≈ one focused session (supersample plumbing is the careful part; shader work
is contained in `morphMaterial`). C ≈ an hour on top. D ≈ a further short session.

### Morphed dragging — Phase 1 FIXED (2026-07-02, windows.js)
Scott's symptoms: (1) morphed windows stopped ~¾ of the way to the edge (the
logical clamp is an invisible wall — logical edge renders at f⁻¹(1) ≈ 0.78 of the
physical half-width); (2) scale accelerated past the dead zone (DOUBLE compression:
the warp shrinks geometry AND the flat pipeline's getWindowScale was still applied
on top — two implementations of the same physics multiplying).
Fix, when the dragged window is morphed (`pendingWarpBlend > 0`):
* cursor physical→logical via `cursorToLogical()` (closed-form forward warp;
  Y correction per mode: 0 divides the equator pull back out, 1 is identity for
  the window center — its pivot is the window's own centerline);
* `mesh.scale` frozen at grab value — the warp does ALL the compressing;
* clamp expanded to logical overscroll `(DESKTOP_W/2)·(2+WARP_STRENGTH) − halfW`.
Two follow-up bugs found by Scott's first test, both fixed:
* **Giant drag-rail band**: writeDragBand divided by ls at the OVERSCROLLED logical
  cx (ls → 0.004 ⇒ band spans hundreds of screens ⇒ every line highlighted thick).
  Real insight: a faithful-morphed window converges WITH the grid, so its band is
  simply its logical extent (no ls division — that division is flat-window physics);
  creased mode scales only the center term by 1/ls at the PHYSICAL center
  (via new JS `warpInverse`, the Newton mirror of the shader).
* **Window blinks out ~80% to the bezel**: frustum culling uses the bbox at the
  LOGICAL position, blind to vertex-shader displacement; overscroll puts it outside
  the frustum. Fix: `mesh.frustumCulled = false` on window meshes (main.js).
Known remaining gaps (Phase 2, not done): raycaster hit-testing still targets the
un-morphed quad (re-grab a deep-parked morphed window at its logical position);
no Y overscroll (mode 0 can't quite reach top/bottom edges deep in a flank);
toggling `0` off at a flank position jumps (scale was frozen, warp vanishes) —
same accepted-roughness class as before, `4` resets.
