# System Context & Architecture: 3D HTML-in-Canvas Window Manager

**To the coding agent (Claude):** Read this fully before generating code. It is both the architectural blueprint and a record of what we learned building it — the **Learnings** and **Anti-Patterns** sections are load-bearing; follow them.

The product is a web prototype that renders standard HTML/CSS application windows **inside** a WebGL 3D scene using Chrome's experimental HTML-in-canvas API, so windows can be spatially manipulated (depth, dragging) while remaining real DOM. Windows are **flat**: they translate and recede in depth, but never rotate or tilt.

**Planning & design docs live in `plans/`.** Read the relevant one before working on that subsystem:
* `plans/grid.md` — the desktop background "UX tension grid" shader (anamorphic warp, glow lines) and the **Drag Rails** feature (built). Read before touching the background shader or window-drag feedback.
* `plans/vertex-warp-experiment.md` — a PAUSED experiment (windows physically deforming to follow the grid). Read before any "warp the window mesh" idea — explains why it was abandoned (unreadable content).
* `plans/CODE_REVIEW.md` — a dated, point-in-time review of the prototype.

---
## 🛠 Technology Stack & Constraints

* **3D library:** Vanilla Three.js, **`r184+` strictly required** (first version with `HTMLTexture`). Loaded via importmap from CDN.
* **Frameworks:** **NONE.** No React/Vue/R3F, no drei `<Html>`. Vanilla JS modules only.
* **Core feature:** Chrome **HTML-in-canvas** via the `layoutsubtree` canvas attribute + `THREE.HTMLTexture`.
* **Styling:** Plain CSS (Flexbox, variables, `border-radius`) on DOM nodes hosted inside source canvases.
* **No build step.** ES modules + `fetch()` of window fragments ⇒ the project **must be served over HTTP**. `file://` breaks both module imports and fragment fetches.
* **Environment:** highly experimental API. The user runs **Chrome Canary (Chromium 146+)** with `chrome://flags/#canvas-draw-element` enabled. No other-browser fallbacks needed; assume `layoutsubtree` and `requestPaint` work.

---
## 🏗 Architecture

### Canvas topology — the key idea
There are **two kinds** of canvas:

* **One visible WebGL canvas** (`#gl`) — the Three.js render target and the **only pointer-event surface**. It composites the whole scene. No `layoutsubtree`.
* **N hidden `<canvas layoutsubtree>` source canvases** (parked off-screen at `left:-99999px`) — one for the desktop **chrome**, one for the **menubar**, and **one per window**. Each rasterizes its DOM subtree into its own `HTMLTexture`. Off-screen canvases still rasterize (validated).

**Why one source canvas per window (do not "simplify" this):** `THREE.HTMLTexture` wires repaints via `parent.onpaint`, where `parent` is the element's host canvas. `onpaint` is a **single-slot property** (last writer wins), so windows sharing one canvas ⇒ only one gets a live texture. Independent live textures require independent source canvases — which is also what enables real per-window mesh depth. `HTMLTexture(element)` requires `element.parentNode` to be the `layoutsubtree` canvas.

```
#gl                         ← visible WebGL output, all input lands here
#sources (off-screen)
  <canvas layoutsubtree> #desktop-chrome  → HTMLTexture → chrome plane (z=0)
  <canvas layoutsubtree> menubar          → HTMLTexture → menubar plane
  <canvas layoutsubtree> .os-window finder → HTMLTexture → finder mesh
  <canvas layoutsubtree> .os-window obsidian → … (one per window, DOM order = back→front)
```

### File structure
```
index.html      #gl output canvas + hidden #sources (chrome/menubar inline + one <canvas> per window)
css/base.css    reset, :root vars, #gl letterbox positioning, #sources off-screen parking
css/desktop.css chrome: wallpaper, menubar, dock, trash + SHARED window frame (.os-window, titlebar)
css/windows.css per-window INTERNAL styles only (no size/position)
js/config.js    constants: DESKTOP_W/H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, FOV, CAMERA_Z, Z_STEP,
                           PLATEAU_FRAC, SHRINK_FRAC, SHRUNK_PX, SNAP_ZONE_STEP
js/main.js      scene/camera/renderer; discovers sources, builds texture+mesh per window; render loop;
                caches scrollEl per window at init; "0" morph + "4" reset demo keys
js/windows.js   raycaster focus + titlebar drag; bounded z-slot stacking; 6-zone shift-drag;
                park-all animation engine; frontmost-window scroll routing; "1"/"2"/"3" demo keys
windows/*.html  five window fragments (finder, obsidian, browser, music, wordprocessor)
```

### Coordinate model
* Internal desktop is **3440×1440** (ultrawide). `camera.aspect` is **locked** to `DESKTOP_W/DESKTOP_H` so the texture is never stretched.
* `#gl` is CSS-scaled to fit the viewport (`min` of width/height ratios); `body` is black ⇒ **letterbox bars** on standard monitors. `renderer.setSize(DESKTOP_W, DESKTOP_H, false)` — the `false` keeps Three.js from touching CSS.
* `S = planeH / DESKTOP_H` is world-units-per-desktop-px (uniform). A window at desktop px `(x,y,w,h)` → plane geometry `(w*S × h*S)`, centered at `((cx−1720)*S, (720−cy)*S)`.

### Interaction (`js/windows.js`)
* All input is on `#gl`. `Raycaster.setFromCamera(ndc)` → `intersectObjects(windowMeshes)`; **closest hit = topmost** (true 3D z-order, no z-index bookkeeping).
* **Drag:** if the hit `uv` is within the top `TITLEBAR_H` px, project the ray onto the window's z-plane and move the mesh so the grabbed point tracks the cursor. Clamp the window **center** in desktop-px space (inside menubar/dock margins).

### Depth & stacking
* Chrome plane at `z=0`. Windows occupy **fixed z-slots by stack rank**: `z = (rank+1) * Z_STEP`. Focus moves the clicked window to the top and **restacks**, so z stays bounded (see Learning #3).
* Window material: `MeshBasicMaterial({ map, transparent:true, alphaTest:0.5 })`. `alphaTest` discards the transparent rounded corners so they don't write depth and punch holes through windows behind them.

---
## ➕ Adding a New Window
1. **Fragment:** create `windows/<name>.html` with root `<div class="os-window" id="win-<name>">` containing a `.win-titlebar` (traffic lights + `.win-title`) and a `.win-body`. **Do not** set width/height/top/left/z-index.
2. **Styles:** add internal styles to `css/windows.css`, scoped with `#win-<name>`. For a dark titlebar, override `#win-<name> .win-titlebar`.
3. **Source canvas:** add one line under `#sources` in `index.html`:
   `<canvas class="src" data-id="<name>" data-x="<px>" data-y="<px>" layoutsubtree width="<w>" height="<h>"></canvas>`
   — `width/height` = window size; `data-x/data-y` = initial desktop-px top-left; DOM order is back→front.
4. **That's it.** `main.js` auto-discovers `#sources .src[data-id]`, fetches the fragment, pins exact px (Learning #1), builds the texture + mesh, and registers it for raycasting. No JS edits required.

---
## 🧠 Learnings (hard-won; don't rediscover these)

**1. Scaling / Y-stretch — size source DOM in explicit px.**
Sizing a window `width:100%;height:100%` against an off-screen source canvas made `%` resolve against an ambiguous containing block ⇒ wrong layout, vertical squash. **Fix:** pin both the source-canvas CSS size and the `.os-window` to exact px equal to the canvas bitmap. **Rule: source DOM must be sized in explicit px matching its source-canvas bitmap.**

**2. Fuzziness — render at device resolution.**
A fixed drawing buffer is upscaled on retina ⇒ blurry text. **Fix:** `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`. If still soft, supersample the source canvases (rasterize ~2× the window px).

**3. Z-ordering growth — use bounded z-slots, never a running z.**
`topZ += Z_STEP` pushed windows monotonically toward the camera, so under perspective each click made them visibly grow. **Fix:** assign z by stack rank (`(rank+1)*Z_STEP`) and restack on focus. **Rule: under a perspective camera, never stack with an ever-increasing z** — use bounded slots (or `renderOrder`).

**4. Don't fake depth with CSS on the window DOM.**
Receding windows via CSS `transform: scale()` + `opacity` in one shared texture caused an always-partially-transparent bug and fought the single-mesh model. Depth must be **real `mesh.position.z`** per window.

**5. Letterboxing.** Keep `camera.aspect` constant at the desktop ratio and CSS-fit `#gl`; let `body` (black) provide the bars. Don't let `renderer.setSize` rewrite CSS (`updateStyle = false`).

**6. Deferred polish (known gaps).** Drop-shadows clip at the source-canvas edge (removed for now; re-add by padding the source canvas). Edge-recession depth (windows shrink near desktop edges) is deferred; when added, do it as real `z` with separate horizontal/vertical edge zones (a single width-based margin over-triggers vertically).

**7. Isolate high-frequency canvases — small canvas = cheap repaint.**
The menubar (3440×39) was originally inside the 3440×1440 chrome canvas; every CSS transition repainted 5M pixels at 60fps. Its own 90k-pixel canvas made animation free. **Rule: any element that animates / needs frequent `requestPaint` gets its own source canvas sized to just that element.**

**8. Park-all UX — clicking any window ends the park session.**
The shift-hold-1s park gesture moves all full-size windows to 50% mid-zones. A subsequent click/drag clears `parkedWindows` entirely on `mousedown`, so shift-release does not restore the others — the click signals "I'm done parking." **Rule: mousedown during park state = session over; clear `parkedWindows`, leave everything in place.**

**9. Cache scrollable DOM refs at init — `layoutsubtree` hides the DOM at runtime.**
After the first `onpaint`, Chrome moves source-canvas children into an internal tree; `canvas.querySelectorAll('*')` returns 0 at runtime. Scroll routing caches `scrollEl` refs in `main.js` at init (while the DOM is accessible) and stores them per `windowMeshes` entry; wheel events on `#gl` route `deltaY` to `top.scrollEl.scrollTop`. **Do not query source-canvas DOM after init.**

**10. `layoutsubtree` pointer-event hit-testing is broken under CSS transforms in Chrome Canary.**
We tried a "CSS proxy layer" — visible source canvases aligned to WebGL meshes via CSS transforms for native scroll/click/hover. Visual alignment worked, but hit regions did **not** follow the transform under any approach (`matrix3d` on the canvas, `left/top` inside a `scale()` parent, `position:fixed`, `CSS3DRenderer`). **Do not re-attempt.** The correct interactivity path is raycaster `uv` → window-local px → `elementFromPoint` → synthetic events.

**11. Color space — `MeshBasicMaterial` + `HTMLTexture` washes out unless output stays linear.**
Saturated colors crushed; near-black/near-white survived. Cause: Three.js r152+ defaults `outputColorSpace = SRGBColorSpace`, which gamma-encodes output, but `MeshBasicMaterial` is an unlit blit with no linearization counterpart, so the encode darkens everything. **Fix (one line): `renderer.outputColorSpace = THREE.LinearSRGBColorSpace;`** Textures keep `t.colorSpace = SRGBColorSpace` (still linearize on the way in); only the OUTPUT encode is disabled. The grid shader plane is unaffected (writes final colors directly). Diagnosis trick: temporarily un-park `#sources` (`left:0`) to view the raw rasterization directly. Porting the shader elsewhere: `THREE.Color` linearizes hex literals, so a raw-WebGL port must sRGB→linear convert colors itself.

---
## 🚨 Anti-Patterns (DO NOT) — each maps to a Learning above
1. **Don't** put all windows in one `layoutsubtree` canvas expecting independent live textures — `onpaint` is single-slot (Topology).
2. **Don't** fake per-window depth with CSS `transform`/`opacity` — use real `mesh.position.z` (Learning #4).
3. **Don't** stack windows with a monotonically increasing z (Learning #3).
4. **Don't** size source DOM with `%` (Learning #1).
5. **Don't** use R3F or `html2canvas`; render HTML *into* WebGL via `HTMLTexture`. `CSS3DRenderer` also fails for overlay hit-testing (Learning #10).
6. **Don't** attempt a "CSS proxy overlay" for native pointer events — hit regions don't follow CSS transforms in this Canary build (Learning #10).
7. **Don't** forget `layoutsubtree` on source canvases, or the subtree won't rasterize.

---
## 📍 Status

**Built:** per-window source-canvas meshes; raycaster focus + titlebar drag; bounded z-slot stacking; letterboxed ultrawide (3440×1440) desktop; device-resolution rendering; separate menubar canvas; 6-zone shift-drag with 100px ratchet; shift-click toggle full-size ↔ 50% mid-zone; shift-hold-1s park-all (cubic ease-out); frontmost-window scroll routing; five windows (finder, obsidian, browser, music, wordprocessor); UX tension grid shader + Drag Rails.

**Demo keys** (used to stage the live walkthrough):

| Key | File | Action |
|-----|------|--------|
| `0` | main.js | Toggle frontmost window's grid-following **morph** (resurrected vertex-warp experiment). Static in center; drag toward a flank to deform live — shows why morphing hurts legibility. A morphed window does not track the cursor while dragging (intentional). See `plans/vertex-warp-experiment.md`. |
| `1` | windows.js | Center the menubar into its pill (`translateX` animation). |
| `2` | windows.js | Reveal / animate the grid. |
| `3` | windows.js | Toggle all window meshes' `.visible` — clears the desktop before tab-switching to Demo 3. |
| `4` | main.js | Reset every window to original position/scale/morph/visibility (windows only — menubar & grid untouched). Cancels in-flight animations/drag and restores stack order via `windowsApi.resetStack()`. |

**Next — in-window interactivity (Phase B):** map raycaster `uv` → window-local px → `document.elementFromPoint` → dispatch synthetic click/hover so buttons, tabs, and hover states work. This is also the enabler for file-level dragging.

**Deferred polish:** edge-recession depth, window drop-shadows (source-canvas padding), focus animation.

**Backlog (parked):**
* **Startup `InvalidStateError` (texElementImage2D).** The render loop uploads `HTMLTexture` bitmaps before the first `onpaint`. Fix: delay `scene.add(mesh)` until a per-canvas first-paint `Promise` resolves. Harmless; self-corrects after first paint.
* **Window resize / full-height / maximize.** Size lives in 3 coupled places (source-canvas bitmap, `.os-window` px, mesh geometry) + registry `info.w/h`. Before building: switch geometry to a **unit plane + `mesh.scale`**; add one `setWindowSize(win,w,h)` that re-derives everything (bitmap → re-paint → DOM px → scale → recompute center & clamp, save restore size); and **spike a runtime `layoutsubtree` canvas resize** first (unproven — content must re-layout, not just scale). Stacking/raycaster are unaffected by size.
