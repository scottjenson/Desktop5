# Implementation Plan: Dynamic UX Tension Grid Shader

## 🤖 Context for the Coding Agent (Claude)
This document focuses exclusively on building a custom `THREE.ShaderMaterial` for the desktop background. The goal is to create a dynamic "UX Tension Grid." This background will visually map the spatial rules of the desktop: perfectly square in the center focus area, and compressing/warping near the left and right edges. 

The ultimate payoff is making this grid react dynamically when the user drags a window. We will build this in strictly separated phases to ensure the math is perfect before adding visual flair. Ask questions as needed to implement each phase in turn. Only ask questions for the phase you are working on. Do not move to Phase 2 until Phase 1 is confirmed.

---

## 📐 Phase 1: The Anamorphic Base Grid & Math Alignment
**Objective:** Create the base grid and ensure the visual warping exactly matches the physical window scaling logic.

1.  **Define the Zones:** Split the screen `uv.x` into a Center Focus Column. The current prototype as a "centered menu bar" (tied to the "1" keyhandler) and a separate central area where all dragging is just a simple movement. When the user drags out of this central area, the windows starts to scale down. The first step is to unify the size of the centered menu bar with this central drag area. They much line up perfectly.
2.  **The Rule of Harmony (CRITICAL):** Look at the JavaScript function that physically scales down the 3D window meshes as they are dragged into the Parking Flanks. 
    * If the window scaling uses a linear reduction, the shader must use a linear warp.
    * If the window scaling uses an easing curve (like `pow(dist, 2.0)`), the fragment shader **must use that exact same mathematical curve** to compress the X-coordinates in the flanks. The grid lines must pinch together at the exact same rate the window shrinks.
3.  **Draw the Grid:** Use `fract()` or `mod()` on the warped UVs to draw a basic 2D grid. Use high-contrast black/white lines just for this phase to verify the math.

---

## 🎨 Phase 2: Aesthetics, Colors & Stage Lighting
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
