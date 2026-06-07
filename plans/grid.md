# Implementation Plan: Dynamic UX Tension Grid Shader

## 🤖 Context for the Coding Agent (Claude)
This document focuses exclusively on building a custom `THREE.ShaderMaterial` for the desktop background. The goal is to create a dynamic "UX Tension Grid." This background will visually map the spatial rules of the desktop: perfectly square in the center focus area, and compressing/warping near the left and right edges. 

The ultimate payoff is making this grid react dynamically when the user drags a window. We will build this in strictly separated phases to ensure the math is perfect before adding visual flair. Ask questions as needed to implement each phase in turn. Only ask questions for the phase you are working on. Do not move to Phase 2 until Phase 1 is confirmed.

---

## 📐 Phase 1: The Anamorphic Base Grid & Math Alignment  (✅ DONE)
**Objective:** Create the base grid and ensure the visual warping exactly matches the physical window scaling logic.

1.  **Define the Zones:** Split the screen `uv.x` into a Center Focus Column. The current prototype as a "centered menu bar" (tied to the "1" keyhandler) and a separate central area where all dragging is just a simple movement. When the user drags out of this central area, the windows starts to scale down. The first step is to unify the size of the centered menu bar with this central drag area. They much line up perfectly.
2.  **The Rule of Harmony (CRITICAL):** Look at the JavaScript function that physically scales down the 3D window meshes as they are dragged into the Parking Flanks. 
    * If the window scaling uses a linear reduction, the shader must use a linear warp.
    * If the window scaling uses an easing curve (like `pow(dist, 2.0)`), the fragment shader **must use that exact same mathematical curve** to compress the X-coordinates in the flanks. The grid lines must pinch together at the exact same rate the window shrinks.
3.  **Draw the Grid:** Use `fract()` or `mod()` on the warped UVs to draw a basic 2D grid. Use high-contrast black/white lines just for this phase to verify the math.

---

## 🎨 Phase 2: Aesthetics, Colors & Stage Lighting  (✅ DONE — except the vertical stage-lighting gradient, item 2)
**Objective:** Make the grid look like a premium, subtle OS background.

1.  **Subtlety & Anti-Aliasing:** * Base the grid color on a uniform (derived from our CSS theme).
    * The grid lines must be thin and stand out. We'll like tweak this value and eventually go with a more subtle color but start out with enough contrast so we easily see that grid. 
    * Use `smoothstep()` around the grid line calculations to prevent pixelated aliasing, especially where the lines densely compress in the flanks.
2.  **Stage Lighting (The Focus Column):**
    * Add a soft vertical gradient. It should be brightest at the top-center (anchoring the menu bar) and bottom-center (anchoring the dock).
    * Smoothly fade this lighting out as the `uv.x` approaches the Parking Flanks. Use a `screen` or `add` blend mode.

---

## ✨ Phase 3: The Big Payoff (Dynamic Dragging & Tension)
**Objective:** The grid must react locally to the window being dragged, reinforcing the feeling of physical UI tension.

### Technical Setup:
In the JS `requestAnimationFrame` loop, you must pass two new uniforms to the `ShaderMaterial` whenever a window is being dragged:
* `u_dragPos` (vec2): The current position of the dragged window, **normalized to UV space (0.0 to 1.0)**.
* `u_dragActive` (float): 1.0 if dragging, 0.0 if not.

### Exploration A: The Tension Spotlight
When dragging, create a soft glowing radius around `u_dragPos`.
* Calculate `float dist = distance(uv, u_dragPos);`
* Use this distance to subtly increase the opacity/brightness of the grid lines directly under and around the dragged window. As the window shrinks in the flank, the grid beneath it lights up, making it feel like it's pushing into the compressed space.

### Exploration B: Localized "Squeezing" (Grid Density)
Instead of just global warping, make the grid lines denser (smaller grid squares) locally under the window as it gets dragged into the edge.
* Pass a `u_dragIntensity` uniform that increases as the window gets closer to the screen bezel.
* In the fragment shader, multiply the grid's scale factor (the number inside the `fract()` function) based on the distance to `u_dragPos` and the `u_dragIntensity`. 
* **The Effect:** The user drags the window toward the edge, and the grid specifically underneath the window pinches and multiplies, visibly reacting to the "weight" and "squeeze" of the window parking itself.

---

## 🧠 Learnings — Phases 1 & 2 (built & confirmed on-screen)

Hard-won notes from actually shipping the grid. All shader code lives inline in `js/main.js` (`_fragSrc`); all dials live in `js/config.js`.

**1. Harmony = analytical derivative, NOT numerical integration.**
The grid warps X with a power curve, and the window scale is the *exact analytical derivative* of that curve — no integration loop in the shader.
* Grid warp: `gridX = centerX + sign(centerX) · flankDist^WARP_POWER · WARP_STRENGTH`
* Window scale / grid density: `localScale = 1 / (1 + derivative)`, where `derivative = WARP_POWER · flankDist^(WARP_POWER−1) · WARP_STRENGTH · innerDeriv` and `innerDeriv = 1/(1−WARP_DEADZONE)`.
The shader uses `1/localScale` to set grid density; `getWindowScale()` in `windows.js` uses `localScale` directly. Same formula, so grid compression and window shrink are locked by construction.

**2. Single source of truth for the dials (they MUST NOT drift).**
`WARP_DEADZONE`, `WARP_POWER`, `WARP_STRENGTH` live only in `config.js`, imported by **both** the shader uniforms (`main.js`) and `getWindowScale()` (`windows.js`). Change one number, both the grid and the window physics move together. Don't hardcode them in the shader.

**3. Work in normalized −1..1 screen space, not vUv −0.5..0.5.**
`centerX = (vUv.x − 0.5) · 2.0`. The `flankDist` formula divides by `(1 − deadZone)` and only reaches 1.0 at `|centerX| = 1` (the screen edge). Using −0.5..0.5 silently caps `flankDist` at ~0.375 and the warp never completes. JS `getWindowScale(xPos)` uses the same −1..1 convention (`cxToNorm`).

**4. Aspect ratio = per-axis frequencies, NEVER `window.innerWidth/innerHeight`.**
`u_freqX = DESKTOP_W/GRID_CELL_PX`, `u_freqY = DESKTOP_H/GRID_CELL_PX` keep cells square in **desktop** space. The desktop is a fixed 3440×1440 letterboxed through a locked-aspect camera, so browser-window aspect is wrong — it distorts cells and reshapes them on every resize.

**5. Dead zone = 0.5 unifies everything.** Center 50% (1720px) stays orthogonal, matching `PLATEAU_FRAC`, the centered-menubar shift, and the snap "center zones." `GRID_CELL_PX = 86` → exactly 40 columns across 3440px (clean subdivision). NB: integer-px alignment is moot because the canvas is CSS-letterbox-scaled — desktop-px never map 1:1 to device-px.

**6. Use cubic (WARP_POWER = 3), not quadratic, for a kink-free bend.**
Quadratic has a constant nonzero 2nd derivative at the boundary → a visible corner where horizontal lines cross into the flank. Cubic gives `w''(0)=0` → C²-smooth bend. `WARP_STRENGTH = 1.33` compensates so the edge `localScale ≈ 1/9` (matches the old power-2 feel: `3·1.33·2·innerDeriv ≈ 8`).

**7. Anti-aliasing = analytical pixel-distance filter, not naive `fract`+`smoothstep`.**
`gridDist = abs(fract(gridUv − 0.5) − 0.5) / fwidth(gridUv)` measures distance to the nearest line **in screen pixels**, giving constant-width lines at any compression. This is what finally killed the Moiré in the dense flanks; `step()`/plain `smoothstep` on the raw fract aliased badly.

**8. Glow lines beat both 1px lines and bloom (Phase 2 line look).**
Each line = a crisp near-white **core** (`1 − smoothstep(0, coreWidth, line)`) + a soft analytic **glow** halo (`exp(−line/glowWidth)·glowStrength`), composited additively on the dark bg, all in the *same* fragment shader. No `EffectComposer`/`UnrealBloomPass` needed (would add a second pass + a build-ish layer to a no-build project). The glow also downsamples far more gracefully on a low-res projector than a 1px line, and turns dense flanks into a luminous wash instead of shimmer.
* Dials: `GRID_LINE_CORE_PX=1.5`, `GRID_LINE_GLOW_PX=6.0`, `GRID_GLOW_STRENGTH=0.5`; colors `u_lineColor=#e6eeff`, `u_glowColor=#0a84ff` (theme accent).

**9. Moiré fade hits the CORE only, not the glow.**
`core *= 1 − smoothstep(0.35, 0.7, density)` where `density = length(fwidth(gridUv))`. Past ~Nyquist the hard cores (which alias) fade out, but the soft glow persists — so compressed flanks dissolve into light rather than crawling.

**10. Edge vignette fade tames the bright flanks.**
The glow staying lit made the compressed edges read *too* bright. `edgeFade = 1 − smoothstep(GRID_EDGE_FADE_START, 1.0, abs(centerX))` (default 0.65) eases both core and glow to 0 toward the L/R edges. Full strength through the center, vignettes out at the periphery.

**11. ⭐ The root "scaling issue": supersample, decoupled from `devicePixelRatio`.**
This was the thing being fought the whole time. Grid crispness depends on draw-buffer pixels, and `setPixelRatio(min(devicePixelRatio, 2))` ties that to the **display** — a projector reports `dpr = 1`, which *quarters* the buffer (6880×2880 → 3440×1440) and under-resolves the dense flanks. **Fix:** `renderer.setPixelRatio(RENDER_SUPERSAMPLE)` with a **fixed** factor (currently 2). The canvas is CSS-fit to the viewport regardless, so we render large and let the browser **downscale = supersampling** → projector-proof. Rule: **the WebGL draw buffer is independent of the display; for a fixed-resolution stage like a projector, set it explicitly and supersample rather than mirroring `devicePixelRatio`.** Bump to 2.5–3 for more crispness if the GPU holds 60fps.

**Still open in Phase 2:** the vertical "stage lighting" gradient (brightest at top-center/bottom-center to anchor the menubar & dock, fading toward the flanks) — item 2 above, not yet built.

---

## ✨ Phase 3 — Drag Rails (✅ BUILT & tuned)

This is the agreed, scoped version of Phase 3. It supersedes the earlier "Tension Spotlight / Squeezing" sketches above (Exploration A/B) — we chose a narrower, cleaner effect. **Built in 2 stages (inert shader scaffold, then wiring + visible highlight); confirmed on-screen and dialed in.** The spec below is preserved as the design rationale; see "As-built notes" at the end for what actually shipped and the two by-eye decisions we made.

### The effect (what we're building)
While a window is being dragged, the **horizontal grid lines that fall within the window's vertical span brighten** — the window appears to ride a pair of rails. Everything else (vertical lines, the rest of the grid) stays as-is. The highlight fades in on mousedown and out on mouseup.

Locked decisions (from discussion):
* **Horizontal lines only** — not vertical, not a radial spotlight. Reads as "rails the window slides along."
* **Only during drag** — transient, driven by a `u_dragActive` 0→1 fade. Grid is plain at rest.
* **Constant brightness** — NO edge-tension/flank-intensify. Pure positional feedback.
* **Selection = strictly inside the band, to START.** We expect to A/B this against "nearest enclosing pair" (the two rails just outside top/bottom). Strictly-inside guarantees the count never flickers; nearest-pair looks more like framing rails but can flicker ±1 as a line crosses the window edge. Build strictly-inside first, eyeball it, switch if needed.

### The invariant that makes this work (KEY INSIGHT)
**The number of highlighted horizontal lines never changes — and we don't have to enforce it; the existing warp math guarantees it, IF we express the band in the right coordinate space.**

Why: the shader draws horizontal lines against `gridYcoord = centerY / localScale` (`js/main.js`, the `gridYcoord` line). `localScale` is the X-warp's analytical derivative — the same factor that shrinks windows in the flank (the "Rule of Harmony", Learning #1 above). So in the flank both the window AND the horizontal cells pinch by the same `localScale`. A window covering N logical cells covers N everywhere. The count is invariant **by construction** as long as the band is defined in **`gridYcoord` (logical grid space), NOT `centerY` (screen space).**

The trap: if the band were tested in screen `centerY` (a fixed screen height), the pinched-together flank lines would let the band capture *more* lines as the window moves outward → count creeps up. Testing in `gridYcoord` makes the band stretch/pinch in lockstep with the lines → count fixed.

### Coordinate mechanics (the part we scrutinized)
Two separable facts, do not conflate them:
1. **Vertical INPUT is trivial and identical everywhere.** The warp is purely horizontal. Input Y is a plain linear map (`centerY = (vUv.y-0.5)*2.0`) — no Y-warp, no vertical dead zone, no Newton inverse on Y. A vertical drag in the flank is computed exactly like one in the center.
2. **Vertical line SPACING is the warp's job and the shader already does it** via `centerY / localScale`. This is the only flank wrinkle.

So the JS sends the band as logical-Y: `gridY = centerY / localScale`, reusing the **single center-sampled `localScale` the drag loop already computes** (`getWindowScale(cxToNorm(cx))` in `js/windows.js`, ~L225). The drag loop already knows the window's `cy` and scaled half-height (`info.h*scale`, ~L228-231), so top/bottom in desktop-px are in hand; convert to `centerY` (linear), then divide by `localScale`. **No new physics, no new source of truth** — same `localScale` that drives the window's own size that frame (satisfies Learning #2).

**Recompute the band EVERY mousemove frame, not just on vertical movement.** Horizontal drag into the flank changes `localScale`, which re-scales logical Y, so the band shifts in `gridYcoord` even with no vertical motion. This does NOT change the count (count is in logical cells) — it keeps the band hugging the pinching window. Both axes handled by recomputing two floats per frame.

### Known approximation + its escalation path (build simple first)
The window uses ONE center-sampled `localScale`, so it scales uniformly. But the grid behind it keeps compressing continuously across the window's width, so a single horizontal line actually **bows/tilts across a wide window in the flank** (different screen-Y at left vs right edge). A flat band from one `localScale` is:
* **Exact in the center zone** (localScale = 1, no bow) — where most dragging happens.
* **Approximate in the flank** — may clip a line at one end of the band near the edges.

**Plan:** build the single-`localScale` version first and LOOK at it. If flank bowing reads badly, the fix stays in the fragment shader (not JS): send the band in **`centerY` (screen) space** and let the shader do `centerY/localScale` **per-fragment** using the `localScale` it already computes (`js/main.js` localScale line). Then the band bows in lockstep with the lines and strictly-inside is exact across the full width. Keep this in back pocket; don't build it unless needed.

(This whole effect avoids what sank the vertex-warp experiment — see `vertex-warp-experiment.md`. That was the HARD direction: an X-axis inverse mapping (Newton-Raphson) to place window vertices onto warped columns, and it warped window *content* → unreadable. Drag Rails is the EASY direction: read the known window position *into* grid space via a forward `/localScale`, touching only the background shader + a 2-float uniform. No geometry, no inverse, no readability cost.)

### How to highlight a line (the visual treatment)
Three levers, agreed: **brighter, higher opacity, slightly thicker.** Notes:
* **Brighter** = scale up the additive glow + core-mix contribution (`js/main.js` ~L136-137) by a gain. Most effective lever, one multiply.
* **Higher opacity** = SAME operation here. Background is opaque, grid composites additively, so there is no separate alpha to push — fold "opacity" into the brightness gain. (Don't go hunting for an alpha channel; there isn't one.)
* **Slightly thicker** = use a larger `u_coreWidth`/`u_glowWidth` (`js/main.js` ~L119-120) for the highlighted horizontals. AA is the analytical pixel-distance filter (Learning #7), so a wider core stays crisp — no aliasing. This is the lever that sells "rails" vs. mere flicker.

### Implementation outline
**Structural prerequisite (the one non-cosmetic change):** stop collapsing H/V on `float line = min(gridDist.x, gridDist.y)` (`js/main.js` ~L113). `gridDist.x` = distance to vertical lines, `gridDist.y` = distance to **horizontal** lines. Keep the base `line` for the normal grid, and ADDITIONALLY compute a horizontal-only contribution (`hLine = gridDist.y`) with the thicker widths, boosted when inside the band. The highlight layers *on top of* the untouched base grid (additional strength, never a replacement).

**Shader (`js/main.js` `_fragSrc`):**
* New uniforms: `u_dragActive` (float 0→1, fade) and `u_dragBand` (vec2 = logical-Y top/bottom in `gridYcoord` space).
* `bandMask = smoothstep-softened step(top ≤ gridYcoord ≤ bottom)`.
* `bandBoost = bandMask * u_dragActive * HIGHLIGHT_GAIN`.
* Compute a separate horizontal core+glow with `GRID_LINE_CORE_PX * HIGHLIGHT_THICKNESS` widths; add it scaled by `bandBoost`.
* **Fade interaction (decide deliberately):** the existing Moiré core-fade (~L125) and edge vignette (~L129-131) should keep applying to the BASE grid, but the band-boosted horizontals should be **exempt from the edge vignette** — otherwise the rails fade out in the flank exactly where you want them. (In the center zone neither fade is active, so this only matters in the flank.)

**Uniforms wiring (`js/windows.js`):** the channel already exists — `initWindows` is handed `warpUniform: bgMesh.material.uniforms.u_warpStrength` (`js/main.js` ~L282). Pass the two new uniform handles the same way. Then:
* mousedown: tween `u_dragActive` 0→1 (~150ms).
* mousemove (~L202-271, already has cy/scale/info.h/localScale): compute band, write `u_dragBand`.
* mouseup (~L437): tween `u_dragActive` 1→0 (~250ms).
* Drive the fade through the EXISTING animation engine (~L273+), not a fresh timer (one-engine consistency, cf. Learning #8).
* **Scope:** direct titlebar drag only. Do NOT add rails to the shift-drag park/stash animations — those are their own distinct feedback; rails there would muddy them.

**Config (`js/config.js`) — per Learning #2, no magic numbers in shader:** `HIGHLIGHT_GAIN`, `HIGHLIGHT_THICKNESS`, fade durations.

### Build order
1. Split H/V in the shader; add `u_dragActive` + `u_dragBand` uniforms (inert).
2. Wire the drag loop to write the band (single center-sampled `localScale`) + fade `u_dragActive`.
3. Add the highlight treatment (brighter + thicker), strictly-inside selection, vignette-exempt.
4. **LOOK at it.** Decide: (a) strictly-inside vs nearest-enclosing-pair; (b) whether flank bowing needs the per-fragment escalation. Both are small, known follow-ups.

Cost: a few ALU ops on an already-cheap full-screen shader + two floats per drag frame. No new passes, no geometry, fully reversible.

---

### As-built notes (what actually shipped, + decisions made by eye)

Built in 2 stages and confirmed on-screen. Worked essentially first try. Files & key locations:

* **`js/config.js`** — dials: `HIGHLIGHT_GAIN = 1.6`, `HIGHLIGHT_THICKNESS = 2.2` (started 1.8, bumped to 2.2 for more "rail" presence in the center; edges absorbed it fine, not too heavy), `HIGHLIGHT_FADE_IN_MS = 150`, `HIGHLIGHT_FADE_OUT_MS = 250`.
* **`js/main.js`** — shader uniforms `u_dragActive`, `u_dragBand` (vec2, gridYcoord space), `u_highlightGain`, `u_highlightThickness`. H/V split keeps base `line = min(gridDist.x, gridDist.y)` textually untouched; adds `hLine = gridDist.y`, an **order-agnostic** band mask (`min/max` of the two band components, so JS can pass top/bottom either way), and a separate thicker/brighter horizontal core+glow layered on top of the base composite, **exempt from `edgeFade`**. Uniforms exposed to `initWindows` via `dragActiveUniform` / `dragBandUniform` (same channel as the existing `warpUniform`).
* **`js/windows.js`** — `gridLocalScale(xPos)` = the **UNCLAMPED** warp scale (twin of `getWindowScale` but without the `MIN_SCALE` floor) because the band must track the grid's true `gridYcoord`, not the clamped window. `writeDragBand(cx,cy,scale,info)` converts window top/bottom px → centerY (`1 - 2·y/DESKTOP_H`) → gridYcoord (`÷ gridLocalScale`). `fadeDragActive(target,ms)` = a dedicated rAF cubic-ease loop for the uniform (the mesh `animateTo` engine lerps transforms, not uniforms). Wired at mousedown (write band + fade in), mousemove (rewrite band every frame), mouseup (fade out). Scope: **direct titlebar drag only** — not added to shift-drag park/stash.

**Decision 1 — selection: kept STRICTLY-INSIDE.** Never needed to try nearest-enclosing-pair; strictly-inside reads fine.

**Decision 2 — flank bowing: NOT needed.** Single center-sampled `localScale` looked good; never escalated to the per-fragment shader version. (That escalation path is still documented above if a future change makes the bowing visible.)

**Observed & ACCEPTED quirks (intentionally left as-is):**

1. **Highlighted-line count GROWS at the far edges** (we predicted it would stay constant). Cause: `getWindowScale` is clamped to `MIN_SCALE = 0.20` but `gridLocalScale` (the band) is unclamped. Once the window hits the size floor it stops shrinking, but the grid keeps compressing, so a frozen-height window covers more lines toward the bezel. Count IS rock-steady from center through the mid zones (where the two scales are equal); it only grows past the floor. **User likes it** — reads as the window bunching into compressed space. Left alone. (If ever unwanted: swap the band to use `getWindowScale` instead of `gridLocalScale` — but then the band drifts off the true grid spacing past the floor.)
2. **Rails read stronger at the edges than in the center.** Cause: the rails are `edgeFade`-exempt, so in the flank they sit at full strength against a base grid that's vignetting to black → high contrast; in the center they compete with a fully-lit base grid → smaller proportional jump. Plus pinched flank lines' glow halos overlap into a luminous bar. **User likes the strong edges** and explicitly did NOT want them dimmed. Left alone. (If ever unwanted: partially re-apply edgeFade to the rails via a `mix(floor, 1.0, edgeFade)` with a tunable floor.)

Both quirks are contrast/where-the-window-can't-shrink artifacts, not bugs — judged good by eye and kept.
