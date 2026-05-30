# System Context & Architecture: 3D HTML-in-Canvas Window Manager

## 🤖 Agent Initialization Instructions
**To the Coding Agent (Claude):** Read this document fully before generating any code for this project. It is the architectural blueprint **and** a record of what we learned building the baseline. The original version of this doc made a naive "single canvas" assumption; the **Current Architecture** and **Learnings** sections below supersede it. Follow them.

The product is a web prototype that renders standard HTML/CSS application windows **inside** a WebGL 3D scene using Chrome's experimental HTML-in-canvas API, so windows can be spatially manipulated (depth, dragging) while remaining real DOM.

**Important product correction:** windows are **flat** — they translate and recede in depth, but they do **not** rotate or tilt. Ignore any earlier "VisionOS tilt / `rotation.x/y`" framing.

---
## 🛠 Technology Stack & Constraints

* **3D library:** Vanilla Three.js, **`r184+` strictly required** (first version with `HTMLTexture`). Loaded via importmap from CDN.
* **Frameworks:** **NONE.** No React/Vue/R3F, no drei `<Html>`. Vanilla JS modules only.
* **Core feature:** Chrome **HTML-in-canvas** via the `layoutsubtree` canvas attribute + `THREE.HTMLTexture`.
* **Styling:** Plain CSS (Flexbox, variables, `border-radius`) on DOM nodes hosted inside source canvases.
* **No build step.** ES modules + `fetch()` of window fragments ⇒ the project **must be served over HTTP** (a local server). `file://` breaks both module imports and fragment fetches.

---
## ⚙️ Environment Prerequisites (Crucial Context)
Highly experimental API. The user runs **Chrome Canary (Chromium 146+)** with `chrome://flags/#canvas-draw-element` enabled. No fallbacks for other browsers are needed. Assume `layoutsubtree` and the canvas `paint`/`requestPaint` mechanism work.

---
## 🏗 Current Architecture (supersedes the old "single canvas" model)

### Canvas topology — the key correction
We do **not** put all windows in one canvas. There are **two kinds** of canvas:

* **One visible WebGL canvas** (`#gl`) — the Three.js render target and the **only pointer-event surface**. It composites the whole scene. It has **no** `layoutsubtree`.
* **N hidden `<canvas layoutsubtree>` source canvases** (parked off-screen) — one for the desktop **chrome**, and **one per window**. Each rasterizes its DOM subtree into its own `HTMLTexture`.

**Why one source canvas per window (do not "simplify" this):** `THREE.HTMLTexture` wires repaints via `parent.onpaint = …`, where `parent` is the element's host canvas. `onpaint` is a **single-slot property** (last writer wins). Multiple windows sharing one canvas ⇒ only one gets a live, updating texture. Independent, live per-window textures therefore require **independent source canvases**, which is also what enables real per-window mesh depth.

```
#gl                         ← visible WebGL output, all input lands here
#sources (off-screen)
  <canvas layoutsubtree> #desktop-chrome  → HTMLTexture → chrome plane (z=0)
  <canvas layoutsubtree> .os-window finder → HTMLTexture → finder mesh
  <canvas layoutsubtree> .os-window obsidian → … etc (one per window)
```

`HTMLTexture(element)` requires `element.parentNode` to be the `layoutsubtree` canvas (the thing exposing `requestPaint`). Off-screen source canvases (`left:-99999px`) **still rasterize** — validated.

### File structure
```
index.html      #gl output canvas + hidden #sources (chrome inline + one <canvas> per window)
css/base.css    reset, :root vars, #gl letterbox positioning, #sources off-screen parking
css/desktop.css chrome: wallpaper, menubar, dock, trash + SHARED window frame (.os-window, titlebar)
css/windows.css per-window INTERNAL styles only (no size/position)
js/config.js    constants: DESKTOP_W/H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, FOV, CAMERA_Z, Z_STEP
js/main.js      scene/camera/renderer; discovers sources, builds texture+mesh per window; render loop
js/windows.js   raycaster focus + titlebar drag; bounded z-slot stacking
windows/*.html  the four window content fragments (finder, obsidian, browser, music)
```

### Coordinate model
* Internal desktop is **2560×1080**. The camera aspect is **locked** to `DESKTOP_W/DESKTOP_H` so the texture is never stretched.
* `#gl` is CSS-scaled to fit the viewport (`min` of width/height ratios); `body` is black ⇒ **letterbox bars top/bottom** on standard monitors. `renderer.setSize(DESKTOP_W, DESKTOP_H, false)` — the `false` keeps Three.js from touching CSS.
* `S = planeH / DESKTOP_H` is world-units-per-desktop-px (uniform). A window at desktop px `(x,y,w,h)` → plane geometry `(w*S × h*S)`, centered at `((cx−1280)*S, (540−cy)*S)`.

### Interaction (`js/windows.js`)
* All input is on `#gl`. `Raycaster.setFromCamera(ndc)` → `intersectObjects(windowMeshes)`; **closest hit = topmost** (true 3D z-order, no z-index bookkeeping).
* **Drag:** if the hit `uv` is within the top `TITLEBAR_H` px, project the ray onto the window's z-plane and move the mesh so the grabbed point tracks the cursor. Clamp the window **center** in desktop-px space (inside menubar/dock margins).
* **In-window interactivity is NOT done yet** (Phase B): routing `uv` → window-local px → `elementFromPoint` → synthetic events so buttons/tabs/hover work.

### Depth & stacking
* Chrome plane at `z=0`. Windows occupy **fixed z-slots by stack rank**: `z = (rank+1) * Z_STEP`. Focus moves the clicked window to the top of the stack and **restacks** — so z stays bounded (`≤ n*Z_STEP`). See Learning #3.
* Window material: `MeshBasicMaterial({ map, transparent:true, alphaTest:0.5 })`. `alphaTest` discards the transparent rounded corners so they don't write depth and punch holes through windows behind them.

---
## ➕ Adding a New Window (follow this; it encodes the learnings)
1. **Fragment:** create `windows/<name>.html` with a root `<div class="os-window" id="win-<name>">` containing a `.win-titlebar` (traffic lights + `.win-title`) and a `.win-body`. **Do not** set width/height/top/left/z-index.
2. **Styles:** add internal styles to `css/windows.css`, scoped with `#win-<name>`. For a dark titlebar, override `#win-<name> .win-titlebar`.
3. **Source canvas:** add one line under `#sources` in `index.html`:
   `<canvas class="src" data-id="<name>" data-x="<px>" data-y="<px>" layoutsubtree width="<w>" height="<h>"></canvas>`
   — `width/height` = window size; `data-x/data-y` = initial desktop-px top-left. Order in the DOM is back→front.
4. **That's it.** `main.js` auto-discovers `#sources .src[data-id]`, fetches the fragment, **pins exact px** (Learning #1), builds the texture + mesh, and registers it for raycasting. No JS edits required.

---
## 🧠 Learnings (hard-won; don't rediscover these)

**1. Scaling / Y-stretch — size source DOM in explicit px.**
Sizing the window with `width:100%;height:100%` against an **off-screen** source canvas made `%` resolve against an ambiguous containing block; the DOM laid out at the wrong size and got squashed into the bitmap (vertical stretch). **Fix:** pin both the source canvas CSS size **and** the `.os-window` to exact pixels equal to the canvas bitmap (`el.style.width = w+'px'`, etc.). Rule: **source DOM must be sized in explicit px matching its source-canvas bitmap.**

**2. Fuzziness — render at device resolution.**
A fixed `2560×1080` drawing buffer is **upscaled** on a retina display (more device pixels than buffer) ⇒ blurry text. **Fix:** `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`. If text is still soft, **supersample the source canvases** (rasterize at ~2× the window px) so the texture carries enough texels for its on-screen device size.

**3. Z-ordering growth — use bounded z-slots, never a running z.**
Bring-to-front via `topZ += Z_STEP; mesh.position.z = topZ` pushed the window monotonically **closer to the camera**, so under perspective each click made it visibly **grow** (cumulative). **Fix:** assign z by **stack rank** (`(rank+1)*Z_STEP`) and restack on focus; max z is bounded and re-focusing the front window is a no-op. Rule: **under a perspective camera, never stack with an ever-increasing z** — use bounded slots (or `renderOrder`).

**4. Don't fake depth with CSS on the window DOM.**
An earlier attempt receded windows with CSS `transform: scale()` + `opacity` inside one shared texture. It caused an always-partially-transparent bug and fought the single-mesh model. Depth must be **real `mesh.position.z`** per window.

**5. Letterboxing.** Keep `camera.aspect` constant at the desktop ratio and CSS-fit `#gl`; let `body` (black) provide the bars. Don't let `renderer.setSize` rewrite CSS (`updateStyle = false`).

**6. Deferred polish (known gaps).** Window drop-shadows clip at the source-canvas edge — removed for now; re-add by padding the source canvas around the window. Edge-recession depth (windows shrink as they near desktop edges) is intended but **deferred**; when added, do it as real `z`, with separate horizontal/vertical edge zones (a single width-based margin over-triggers vertically).

---
## 🚨 Anti-Patterns (DO NOT DO THESE)
1. **Do NOT** put all windows in one `layoutsubtree` canvas expecting independent live textures — `onpaint` is single-slot. One source canvas per window.
2. **Do NOT** fake per-window depth with CSS `transform`/`opacity`; use real `mesh.position.z` (Learning #4).
3. **Do NOT** stack windows with a monotonically increasing z (Learning #3).
4. **Do NOT** size source DOM with `%` (Learning #1).
5. **Do NOT** use `CSS3DRenderer`, R3F, or `html2canvas`. Render HTML *into* WebGL as a texture via `HTMLTexture`.
6. **Do NOT** forget `layoutsubtree` on source canvases, or the subtree won't rasterize.

---
## 📍 Status & Next Steps
* **Phase A — DONE (baseline, committed):** per-window source-canvas meshes; raycaster focus + titlebar drag; bounded z-slot stacking; letterboxed desktop; device-resolution (sharp) rendering; four windows (Finder, Obsidian, browser, music).
* **Phase B — NEXT:** in-window interactivity — map raycaster `uv` → window-local px → `document.elementFromPoint` → dispatch synthetic click/hover so buttons, tabs, and hover states work.
* **Polish (deferred):** edge-recession depth, window drop-shadows (source-canvas padding), focus animation.
* **Backlog (parked — not now):**
  * **Window resize / full-height / maximize.** Size currently lives in 3 coupled places (source-canvas bitmap, `.os-window` px, mesh geometry) + registry `info.w/h`. Before building: switch geometry to a **unit plane + `mesh.scale`**; add a single `setWindowSize(win,w,h)` that re-derives everything (bitmap → re-paint → DOM px → scale → recompute center & clamp, save a restore size); and **spike a runtime `layoutsubtree` canvas resize** first (unproven — content must re-layout, not just scale). Stacking/raycaster are unaffected by size.
  * **In-window interactivity (Phase B)** — `uv` → window-local px → on-screen-but-hidden source → `elementFromPoint` → synthetic events. Also the enabler for file-level dragging (below).
