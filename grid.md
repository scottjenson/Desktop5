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

**Still open in Phase 2:** the vertical "stage lighting" gradient (brightest at top-center/bottom-center to anchor the menubar & dock, fading toward the flanks) — item 2 above, not yet built. Phase 3 (dynamic drag tension) not started.
