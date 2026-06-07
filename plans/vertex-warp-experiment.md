# Vertex Warp Experiment: Windows Following the Grid

## Status: Resurrected as a DEMO toggle (not a usable drag mode)

The experiment succeeded technically — windows physically deform to follow the background grid's spatial compression curves. The Newton-Raphson inverse mapping locks vertices to grid lines with sub-pixel accuracy. However, the content distortion (text, buttons, UI elements warping with the mesh) made windows too hard to read in practice. The effect is striking as an animation but breaks usability for stationary reading. **That readability problem is exactly why it stays a demo, not the real drag model** — the toggle exists to *show an audience why we rejected morphing*.

### What's wired up NOW (re-implemented; supersedes the old "How to Revert/Reconstruct" below)
Re-added cleanly, gated so it's free when off:
* **All window meshes are subdivided** `PlaneGeometry(w,h, MORPH_SEGMENTS_X, 1)` (`MORPH_SEGMENTS_X = 40`, config.js). At `u_warpBlend = 0` this renders pixel-identical to a flat quad.
* **`morphMaterial(el)`** (js/main.js) — a `MeshBasicMaterial` with an `onBeforeCompile` vertex warp: Newton-Raphson inverse (4 iters) places each vertex's X on the grid's warped column, **plus the full Y-pull** (`squashedWorld.y *= localScale` toward world Y=0) which produces the trapezoid (left edge shorter than right in the left flank) AND drifts the window toward the screen equator. Gated by `u_warpBlend` (0 = flat). Per-window uniform, so flat and morphed windows coexist freely (each mesh owns its material).
* **`setWarpBlend(mesh, value)`** (js/main.js) — tolerant of lazy `onBeforeCompile` (stores `pendingWarpBlend`, read as the initial uniform value on compile).
* **Trigger:** the **"0" key** toggles morph on the frontmost window. No animation (snaps).

### Two ACCEPTED roughnesses (intentionally NOT fixed — do not "fix" thinking they're bugs)
1. **Vertical jump on toggle.** The Y-pull is toward world Y=0, so toggling a window vertically shifts it toward the screen midline. Accepted for a static toggle.
2. **Morphed dragging "runs away" from the cursor** and stops short in the flank. The morph is computed in the vertex shader from `mesh.position` every frame, so it *tracks* a drag automatically and morphs live (a nice unplanned win for demoing) — BUT the flat drag logic doesn't know the window is displaced by the warp, so the grabbed point drifts off the cursor, worsening toward the edge. **This is the exact logical-vs-physical coordinate gap that the `screenToLogicalCoords` machinery below was built to solve.** Deliberately left unfixed: this mode is for *demonstrating legibility*, not usable dragging. If it ever needs to be usable, the fix is the coordinate mapping documented below.

The "How to Revert / Reconstruct" and bug-history sections below are kept as the original record and the recipe for the *usable* (cursor-accurate) version — they predate this demo resurrection and the codebase has since moved (e.g. Drag Rails). Treat them as reference, not current state.

---

## What We Built

### 1. Subdivided Window Geometry (`js/main.js`)
Changed `PlaneGeometry(w*S, h*S)` → `PlaneGeometry(w*S, h*S, 40, 1)`.  
40 horizontal segments give the mesh enough vertices to bend smoothly across the warp boundary. 1 vertical segment is sufficient since vertical curvature is handled analytically at each vertex.

### 2. Vertex Shader Injection via `onBeforeCompile` (`js/main.js`)
`MeshBasicMaterial` supports `material.onBeforeCompile` — a hook that receives Three.js's compiled shader before it's sent to the GPU. We add custom uniforms and replace `#include <project_vertex>` with our own projection logic. This works with `HTMLTexture` and doesn't require switching to `ShaderMaterial`.

Pattern:
```js
mat.onBeforeCompile = (shader) => {
  shader.uniforms.u_halfPlaneW   = { value: planeW / 2 };  // world-unit half-width
  shader.uniforms.u_warpDeadzone = { value: WARP_DEADZONE };
  shader.uniforms.u_warpPower    = { value: WARP_POWER };
  shader.uniforms.u_warpStrength = { value: WARP_STRENGTH };

  shader.vertexShader = `
    uniform float u_halfPlaneW;
    uniform float u_warpDeadzone;
    uniform float u_warpPower;
    uniform float u_warpStrength;
  ` + shader.vertexShader;

  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    ` ... custom GLSL ... `
  );
};
```

### 3. Newton-Raphson Inverse Mapping (the core math)

The background grid's fragment shader warps X via a forward mapping:
```
f(xs) = xs + sign(xs) · pow(flankDist(xs), power) · strength
```
where `xs` is the physical screen position (−1..1) and `f(xs)` is the logical grid coordinate.

Grid lines are drawn at positions where `f(xs) · freqX` is an integer.

**The problem:** a window mesh placed at logical world X = `xw` has vertices that need to appear at the physical screen positions where the grid's logical coordinate equals `xw`. This requires solving the inverse: find `xs` such that `f(xs) = xw`.

**The solution:** Newton-Raphson with 4 iterations (sub-pixel convergence on this smooth monotonic function):

```glsl
// worldPos = modelMatrix * transformed (bakes in park-animation mesh.scale)
vec4 squashedWorld = modelMatrix * vec4(transformed, 1.0);
float xw = squashedWorld.x / u_halfPlaneW;  // logical position, -1..1

float xs = xw;  // initial guess
for (int i = 0; i < 4; i++) {
  float flankDist = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
  float warp      = sign(xs) * pow(flankDist, u_warpPower) * u_warpStrength;
  float innerDeriv = 1.0 / (1.0 - u_warpDeadzone);
  float deriv     = u_warpPower * pow(flankDist, max(0.0, u_warpPower - 1.0))
                    * u_warpStrength * innerDeriv;
  float error  = (xs + warp) - xw;
  float fPrime = 1.0 + deriv;
  xs = xs - error / fPrime;
}

// Place vertex at its physically correct screen position
squashedWorld.x = xs * u_halfPlaneW;
```

### 4. Global Y Pull Toward the Screen Equator

After solving for `xs`, recompute `localScale` at that physical position and pull all Y coordinates toward world Y=0:

```glsl
float finalFlank = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
float finalDeriv = u_warpPower * pow(finalFlank, max(0.0, u_warpPower - 1.0))
                   * u_warpStrength * (1.0 / (1.0 - u_warpDeadzone));
float localScale = 1.0 / (1.0 + finalDeriv);

squashedWorld.y *= localScale;  // pull toward Y=0 (screen equator)

vec4 mvPosition = viewMatrix * squashedWorld;
gl_Position = projectionMatrix * mvPosition;
```

The `squashedWorld.y *= localScale` is a **global** pull (toward world Y=0, not the mesh center). This causes two intentional effects:
- **Center drift**: a window in the upper flank sinks toward the screen midline
- **Tilt**: left vertices are deeper in the flank than right vertices → different localScale → the top edge becomes diagonal

Both effects make the window appear to roll down the inside of the grid's curved funnel, matching the grid lines that curve toward Y=0 in the flanks.

### 5. Genie-Effect Content Distortion (intentional)

Because UVs are fixed to model space but vertex X positions are non-uniformly compressed via Newton mapping, the window's texture content (text, buttons, UI) distorts non-uniformly — the right side of a window in the right flank compresses more than the left side. This is the intended "paper bending" effect: the content warps with the mesh geometry like ink on a bending sheet. It's visually striking but makes text hard to read, which is why this experiment is paused.

### 6. Park Animation Compounds Correctly

`mesh.scale` (set by park-all animations to 0.5) is baked into `modelMatrix`, which is applied before the Newton solver evaluates `worldPos.x`. So park-scale and flank-scale multiply: 0.5 park × 0.5 flank = 0.25 total. No special handling needed.

---

## Key Bugs Caught Along the Way

### World Units vs Pixel Units (`u_halfPlaneW`)
**Wrong:** `worldPosition.x / (DESKTOP_W / 2)` — mixes Three.js world units with desktop pixel units.  
**Right:** `worldPosition.x / u_halfPlaneW` where `u_halfPlaneW = planeW / 2` in world units.

`planeW` is computed in `main.js`:
```js
const fovRad = THREE.MathUtils.degToRad(FOV);
const planeH = 2 * Math.tan(fovRad / 2) * CAMERA_Z;
const planeW = planeH * (DESKTOP_W / DESKTOP_H);
// u_halfPlaneW = planeW / 2
```

### Logical Overscroll for Drag Bounds (`js/windows.js`)
At physical screen edge `xs = 1.0`, the logical coordinate is `xw = 1 + WARP_STRENGTH` (with our values, 2.33). The drag clamp must allow the window center to travel to `DESKTOP_W/2 * (2 + WARP_STRENGTH)` ≈ 5730px (far off the logical desktop) so the compressed visual edge can reach the physical bezel. The old clamp `[halfW, DESKTOP_W − halfW]` created an invisible wall.

```js
const maxCx = DESKTOP_W / 2 * (2 + WARP_STRENGTH) - halfW;
const minCx = DESKTOP_W - maxCx;
cx = Math.min(Math.max(cx, minCx), maxCx);
```

### Physical vs Logical Cursor Coordinates (`screenToLogicalCoords`)
The Three.js raycaster returns **physical** world coordinates (where the ray actually hits in 3D space). But window positions are **logical** coordinates (before Newton compression). Using raycaster cursor positions directly caused the window to lag behind the cursor in the flanks.

Fix: `screenToLogicalCoords(clientX, clientY)` applies the same forward warp `f(xs)` to convert physical cursor position → logical coordinate. Also divides Y by `localScale` since the vertex shader compresses Y by that factor.

```js
function screenToLogicalCoords(clientX, clientY) {
  const rect = gl.getBoundingClientRect();  // NOT window.innerWidth — handles letterboxing
  const normX = ((clientX - rect.left) / rect.width)  * 2 - 1;
  const normY = -((clientY - rect.top)  / rect.height) * 2 + 1;

  const flankDist = Math.max(0, (Math.abs(normX) - WARP_DEADZONE)) / (1 - WARP_DEADZONE);
  const warp = Math.sign(normX) * Math.pow(flankDist, WARP_POWER) * WARP_STRENGTH;
  const logicalNormX = normX + warp;

  const innerDeriv = 1 / (1 - WARP_DEADZONE);
  const derivative  = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1))
                      * WARP_STRENGTH * innerDeriv;
  const localScale  = 1 / (1 + derivative);
  const logicalNormY = normY / localScale;

  return {
    cx: logicalNormX * (DESKTOP_W / 2) + DESKTOP_W / 2,
    cy: DESKTOP_H / 2 * (1 - logicalNormY),
  };
}
```

**Letterboxing note:** always use `gl.getBoundingClientRect()`, not `window.innerWidth`. On monitors wider than `3440/1440 * screenHeight`, the canvas has horizontal black bars and `window.innerWidth` diverges from the canvas width.

### Object Space vs World Space (early wrong attempt)
An early attempt scaled `transformed.x *= localScale` and `transformed.y *= localScale` in model space (toward the mesh center). This created a "straight wedge" — the window uniformly shrunk regardless of which grid line each vertex should align to. The Newton solver fixes this by positioning each vertex independently at its correct physical grid position.

---

## How to Revert (Back to Flat Windows)

In `js/main.js`:
1. Change `new THREE.PlaneGeometry(w * S, h * S, 40, 1)` back to `new THREE.PlaneGeometry(w * S, h * S)`
2. Remove the entire `mat.onBeforeCompile = (shader) => { ... };` block
3. Change `const mat = new THREE.MeshBasicMaterial(...)` back to inline: `new THREE.MeshBasicMaterial({ map: htmlTexture(el), transparent: true, alphaTest: 0.5 })`

In `js/windows.js`:
1. The `screenToLogicalCoords` function, `getWindowScale`, expanded drag bounds, and `cxToNorm` can all stay — they don't hurt flat windows. Or remove them for cleanliness.

---

## How to Reconstruct (Re-enable the Warp)

The code is already in place. The changes above just need to be applied in reverse.

For a softer version that reduces the readability impact:
- **Reduce `WARP_STRENGTH`** in `config.js` to limit how extreme the flank compression is
- **Only warp X, not Y**: remove `squashedWorld.y *= localScale` — this eliminates the center drift and tilt, leaving only the horizontal trapezoid. Much more readable; the window stays at its vertical position and only compresses horizontally
- **Add a lerp/blend factor** uniform (e.g., `u_warpBlend 0..1`) and mix between the original and warped vertex positions: `squashedWorld.x = mix(originalWorld.x, xs * u_halfPlaneW, u_warpBlend)`. Animate this during drag/park transitions so the warp is a transient effect rather than always-on
- **Only warp during drag**: set `u_warpBlend = 1.0` when `drag` is active, lerp back to 0 on mouseup

---

## Files Changed

| File | What Changed |
|------|-------------|
| `js/main.js` | Geometry subdivided 40×1; `mat.onBeforeCompile` injects Newton-Raphson vertex warp with `u_halfPlaneW`, `u_warpDeadzone/power/strength` uniforms |
| `js/windows.js` | `screenToLogicalCoords()` replaces raycaster cursor position; drag bounds expanded to `DESKTOP_W/2 * (2+WARP_STRENGTH)`; `dragPlane`/`hit` removed; `getWindowScale` kept for clamping only |
| `js/config.js` | No changes needed — `WARP_DEADZONE`, `WARP_POWER`, `WARP_STRENGTH` already shared |
