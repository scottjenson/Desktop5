// Scene setup: one static chrome plane + one textured mesh per window.
//
// Two kinds of canvas, deliberately separated:
//   • #gl                  — the visible WebGL output and the only event surface
//   • #sources .src        — hidden <canvas layoutsubtree> texture sources
// HTMLTexture's `onpaint` is a single slot per canvas, so each window needs its
// own source canvas to get an independent, live-updating texture.

import * as THREE from 'three';
import { DESKTOP_W, DESKTOP_H, FOV, CAMERA_Z, Z_STEP, MENUBAR_H, DOCK_CLEARANCE, GRID_CELL_PX, WARP_DEADZONE, WARP_POWER, WARP_STRENGTH, RENDER_SUPERSAMPLE, GRID_LINE_CORE_PX, GRID_LINE_GLOW_PX, GRID_GLOW_STRENGTH, GRID_EDGE_FADE_START, GRID_INTENSITY, HIGHLIGHT_GAIN, HIGHLIGHT_THICKNESS, MORPH_SEGMENTS_X } from './config.js';
import { initWindows } from './windows.js';

// ── CSS custom properties (derived from config.js) ────────
const r = document.documentElement.style;
r.setProperty('--menubar-h', MENUBAR_H + 'px');
r.setProperty('--menu-shift', DESKTOP_W * 0.25 + 'px');
r.setProperty('--snap-top', MENUBAR_H + 'px');
r.setProperty('--snap-height', (DESKTOP_H - MENUBAR_H - DOCK_CLEARANCE) + 'px');

// ── Renderer / scene / camera ─────────────────────────────
const gl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true });
renderer.setSize(DESKTOP_W, DESKTOP_H, false); // fixed buffer; CSS handled below
// Fixed supersample, deliberately NOT tied to devicePixelRatio: a projector reports
// dpr 1 and would quarter the buffer, under-resolving the dense grid flanks. We render
// large (DESKTOP × RENDER_SUPERSAMPLE) and let CSS downscale → projector-proof crispness.
renderer.setPixelRatio(RENDER_SUPERSAMPLE);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const scene = new THREE.Scene();
scene.background = null; // shader plane handles the background

// Camera aspect is locked to the desktop ratio, so the texture is never stretched.
const camera = new THREE.PerspectiveCamera(FOV, DESKTOP_W / DESKTOP_H, 0.1, 100);
camera.position.z = CAMERA_Z;

// CSS-scale the canvas to fit the viewport → black bars top/bottom.
function fitCanvas() {
  const s = Math.min(window.innerWidth / DESKTOP_W, window.innerHeight / DESKTOP_H);
  gl.style.width = DESKTOP_W * s + 'px';
  gl.style.height = DESKTOP_H * s + 'px';
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// World dimensions of the full desktop at z = 0, and px→world scale.
const fovRad = THREE.MathUtils.degToRad(FOV);
const planeH = 2 * Math.tan(fovRad / 2) * CAMERA_Z;
const planeW = planeH * (DESKTOP_W / DESKTOP_H);
const S = planeH / DESKTOP_H; // world units per desktop px (uniform in x and y)

// ── Background grid shader ─────────────────────────────────
// Renders the UX Tension Grid as the desktop background.
// The grid's X coordinate is warped by an analytical power curve
//   gridX = x + sign(x)·flankDist^power·strength
// whose derivative (1 + derivative) sets the local density. The same `derivative`
// drives getWindowScale() in windows.js — so the grid compresses at exactly the rate
// windows shrink. The dials (u_deadZone/power/strength) come from config.js, the single
// shared source of truth. fwidth() keeps lines ~1.5 device-px regardless of density.
const _vertSrc = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const _fragSrc = /* glsl */`
  uniform float u_freqX;        // grid cells across full width  (DESKTOP_W / GRID_CELL_PX)
  uniform float u_freqY;        // grid cells across full height (DESKTOP_H / GRID_CELL_PX)
  uniform float u_deadZone;     // |x| (in -1..1) of the un-warped centre focus zone
  uniform float u_warpPower;    // 2.0 quadratic … 3.0 cubic
  uniform float u_warpStrength; // total spatial compression per flank
  uniform float u_coreWidth;    // crisp line core half-width (screen px)
  uniform float u_glowWidth;    // soft glow falloff radius (screen px)
  uniform float u_glowStrength; // glow halo brightness (0..1)
  uniform float u_edgeFadeStart;// |centerX| where the edge fade begins (→0 at the edge)
  uniform float u_gridIntensity;// global scale on core + glow (0.5 = half brightness)
  uniform float u_reveal;       // 0 = doors closed (plain blue), 1 = fully open (grid)
  uniform vec3  u_bgColor;
  uniform vec3  u_doorColor;    // plain backdrop shown before reveal
  uniform vec3  u_lineColor;    // crisp core colour (near-white)
  uniform vec3  u_glowColor;    // tinted halo colour (theme accent)
  // Drag Rails (Phase 3): inert until a drag fires (u_dragActive defaults 0 → 0×anything=0).
  uniform float u_dragActive;       // 0 = no drag, 1 = dragging (fade in/out driver)
  uniform vec2  u_dragBand;         // dragged window's vertical extent in gridYcoord (logical-Y) space: (top, bottom)
  uniform float u_highlightGain;    // extra brightness on highlighted horizontals
  uniform float u_highlightThickness; // core/glow width multiplier for highlighted horizontals
  varying vec2 vUv;

  void main() {
    // Normalized screen space, -1..1, centre at 0 (matches windows.js xPos).
    float centerX = (vUv.x - 0.5) * 2.0;
    float centerY = (vUv.y - 0.5) * 2.0;

    // 0 at the dead-zone boundary, 1 at the screen edge.
    float flankDist = max(0.0, abs(centerX) - u_deadZone) / (1.0 - u_deadZone);

    // X warp: push the coordinate outward by the power curve (integral of the density).
    float warp = pow(flankDist, u_warpPower) * u_warpStrength;
    float gridXcoord = centerX + sign(centerX) * warp;

    // Local scale = inverse of the warp's analytical derivative. Identical math to
    // getWindowScale() in windows.js, so window size and grid density stay locked.
    float innerDeriv = 1.0 / (1.0 - u_deadZone);
    float derivative = u_warpPower * pow(flankDist, max(0.0, u_warpPower - 1.0)) * u_warpStrength * innerDeriv;
    float localScale = 1.0 / (1.0 + derivative);

    // Y has no warp, so compress it by 1/localScale to keep cells perfectly square.
    float gridYcoord = centerY / localScale;

    // Continuous grid coordinates in cell units (·0.5 because centerX/Y span 2 units).
    // u_freqX/u_freqY carry the desktop aspect (DESKTOP_W/H ÷ cell), so cells stay square.
    vec2 gridUv = vec2(gridXcoord * u_freqX, gridYcoord * u_freqY) * 0.5;

    // Distance to the nearest grid line, in screen pixels (÷fwidth: cell-space → px).
    vec2 gridDist = abs(fract(gridUv - 0.5) - 0.5) / fwidth(gridUv);
    float line = min(gridDist.x, gridDist.y);

    // Drag Rails (Phase 3) — split out the HORIZONTAL-line distance so it can be boosted
    // independently. gridDist.y is distance to horizontal lines (gridUv.y → fract → lines).
    // The band test is in gridYcoord (logical-Y) space so the highlighted-line COUNT is
    // invariant across the warp (see plans/grid.md Phase 3). Inert in Stage 1: u_dragActive = 0.
    float hLine = gridDist.y;
    // Mask = 1 inside [bandLo, bandHi]; order-agnostic so JS can pass top/bottom either way.
    float bandLo = min(u_dragBand.x, u_dragBand.y);
    float bandHi = max(u_dragBand.x, u_dragBand.y);
    float bandMask = smoothstep(bandLo - 0.001, bandLo + 0.001, gridYcoord)
                   * smoothstep(bandHi + 0.001, bandHi - 0.001, gridYcoord);
    float bandBoost = bandMask * u_dragActive; // == 0 until a drag fires

    // Each line = a crisp near-white CORE + a soft tinted GLOW halo, both sized in px so
    // they stay consistent at any compression. The glow downscales gracefully on a
    // projector where a 1px core would flicker, and in the dense flanks the always-near
    // line keeps the glow lit → the compressed edges read as a luminous band, not aliasing.
    float core = 1.0 - smoothstep(0.0, u_coreWidth, line);
    float glow = exp(-line / u_glowWidth) * u_glowStrength;

    // Safety net: where cells compress past ~Nyquist, fade only the hard CORE (which
    // would alias). The soft glow stays, so dense flanks dissolve into light, not shimmer.
    float density = length(fwidth(gridUv));
    core *= 1.0 - smoothstep(0.35, 0.7, density);

    // Edge fade: ease the whole line intensity to 0 toward the left/right edges so the
    // bright, compressed flanks vignette out instead of dominating. Full through centre.
    float edgeFade = 1.0 - smoothstep(u_edgeFadeStart, 1.0, abs(centerX));
    core *= edgeFade;
    glow *= edgeFade;

    // Composite: additive tinted glow, crisp core on top.
    // u_gridIntensity dials down the entire grid by a global factor.
    vec3 col = u_bgColor;
    col += u_glowColor * glow * u_gridIntensity;
    col = mix(col, u_lineColor, core * u_gridIntensity);

    // ── Drag Rails (Phase 3) ──────────────────────────────────────────────
    // Highlight the HORIZONTAL lines inside the dragged window's vertical band:
    // a thicker, brighter core+glow layered ON TOP of the base grid. hLine and
    // bandBoost computed above; bandBoost == 0 unless a drag is active.
    // NOTE: intentionally NOT multiplied by edgeFade — the rails must stay lit in
    // the flank where edgeFade would vignette the base grid away (see plans/grid.md Phase 3).
    float hCore = 1.0 - smoothstep(0.0, u_coreWidth * u_highlightThickness, hLine);
    float hGlow = exp(-hLine / (u_glowWidth * u_highlightThickness)) * u_glowStrength;
    hCore *= 1.0 - smoothstep(0.35, 0.7, density); // share the base Moiré safety net
    float rail = bandBoost * u_highlightGain * u_gridIntensity;
    col += u_glowColor * hGlow * rail;
    col = mix(col, u_lineColor, clamp(hCore * rail, 0.0, 1.0));

    // Door reveal: two doors split left/right from centre as u_reveal goes 0→1.
    // Hard step closes the seam completely — smoothstep bleeds grid through at center.
    float doorT = step(u_reveal, abs(centerX));
    vec3 finalCol = mix(clamp(col, 0.0, 1.0), u_doorColor, doorT);

    gl_FragColor = vec4(finalCol, 1.0);
  }
`;

const bgMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(planeW, planeH),
  new THREE.ShaderMaterial({
    uniforms: {
      u_freqX:        { value: DESKTOP_W / GRID_CELL_PX },
      u_freqY:        { value: DESKTOP_H / GRID_CELL_PX },
      u_deadZone:     { value: WARP_DEADZONE },
      u_warpPower:    { value: WARP_POWER },
      u_warpStrength: { value: 0.0 },
      u_coreWidth:    { value: GRID_LINE_CORE_PX },
      u_glowWidth:    { value: GRID_LINE_GLOW_PX },
      u_glowStrength: { value: GRID_GLOW_STRENGTH },
      u_edgeFadeStart:{ value: GRID_EDGE_FADE_START },
      u_gridIntensity:{ value: GRID_INTENSITY },
      u_reveal:       { value: 0.0 },
      u_dragActive:   { value: 0.0 }, // Drag Rails (Phase 3) — 0 until a drag fires
      u_dragBand:     { value: new THREE.Vector2(0.0, 0.0) }, // (top, bottom) in gridYcoord space
      u_highlightGain:      { value: HIGHLIGHT_GAIN },
      u_highlightThickness: { value: HIGHLIGHT_THICKNESS },
      u_bgColor:      { value: new THREE.Color(0x0d1b3e) },
      u_doorColor:    { value: new THREE.Color(0xaaaadd) }, // macOS Monterey blue
      u_lineColor:    { value: new THREE.Color(0xe6eeff) }, // crisp cool-white core
      u_glowColor:    { value: new THREE.Color(0x0a84ff) }, // theme accent halo
    },
    vertexShader:   _vertSrc,
    fragmentShader: _fragSrc,
  })
);
bgMesh.position.z = -0.005;
scene.add(bgMesh);

function htmlTexture(el) {
  const t = new THREE.HTMLTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── Window Morph (demo) ───────────────────────────────────────────────────
// A MeshBasicMaterial whose vertex shader bends each window's vertices onto the
// background grid's warped columns, so a morphed window's content hugs the same
// compression curve as the grid lines behind it. Includes the Y-pull (trapezoid:
// the deeper-in-flank edge foreshortens more), which also drifts the window toward
// the screen equator on toggle (accepted — see plans/vertex-warp-experiment.md).
// Gated by u_warpBlend (0 = flat, pixel-identical to a plain quad).
//
// Math: the grid warps logical→physical via f(xs) = xs + sign(xs)·flankDist^p·strength.
// A vertex sits at logical world-X xw; we need the physical screen-X xs where f(xs)=xw.
// Newton-Raphson (4 iters, smooth monotonic f → sub-pixel) inverts it. The compiled
// shader is stashed on mat.userData.shader so setWarpBlend() can drive u_warpBlend.
function morphMaterial(el) {
  const mat = new THREE.MeshBasicMaterial({ map: htmlTexture(el), transparent: true, alphaTest: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.u_halfPlaneW   = { value: planeW / 2 };
    shader.uniforms.u_warpDeadzone = { value: WARP_DEADZONE };
    shader.uniforms.u_warpPower    = { value: WARP_POWER };
    shader.uniforms.u_warpStrength = { value: WARP_STRENGTH };
    shader.uniforms.u_warpBlend    = { value: mat.userData.pendingWarpBlend ?? 0.0 };

    shader.vertexShader = `
      uniform float u_halfPlaneW;
      uniform float u_warpDeadzone;
      uniform float u_warpPower;
      uniform float u_warpStrength;
      uniform float u_warpBlend;
    ` + shader.vertexShader;

    // Replace the standard projection with our warped one. <project_vertex> normally does:
    //   vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0); gl_Position = projectionMatrix * mvPosition;
    // We split modelView into model (to get world X for the warp) then view.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */`
        vec4 squashedWorld = modelMatrix * vec4(transformed, 1.0);
        float xw = squashedWorld.x / u_halfPlaneW;        // logical pos, -1..1

        float xs = xw;                                     // Newton initial guess
        for (int i = 0; i < 4; i++) {
          float flankDist  = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
          float warp       = sign(xs) * pow(flankDist, u_warpPower) * u_warpStrength;
          float innerDeriv = 1.0 / (1.0 - u_warpDeadzone);
          float deriv      = u_warpPower * pow(flankDist, max(0.0, u_warpPower - 1.0))
                             * u_warpStrength * innerDeriv;
          float error  = (xs + warp) - xw;
          float fPrime = 1.0 + deriv;
          xs = xs - error / fPrime;
        }

        // Blend flat (xw) ↔ warped (xs).
        float finalNorm = mix(xw, xs, u_warpBlend);
        squashedWorld.x = finalNorm * u_halfPlaneW;

        // Y pull (full original): scale each vertex's Y by the GRID's localScale at its
        // solved physical position xs, toward world Y=0. Because xs differs across the
        // window's width (left edge deeper in the flank → smaller localScale), the left
        // edge foreshortens more than the right → the trapezoid. Also drifts the window
        // toward the screen equator (accepted for the static toggle).
        float finalFlank = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
        float finalDeriv = u_warpPower * pow(finalFlank, max(0.0, u_warpPower - 1.0))
                           * u_warpStrength * (1.0 / (1.0 - u_warpDeadzone));
        float localScale = 1.0 / (1.0 + finalDeriv);
        float yScale = mix(1.0, localScale, u_warpBlend);
        squashedWorld.y *= yScale;

        vec4 mvPosition = viewMatrix * squashedWorld;
        gl_Position = projectionMatrix * mvPosition;
      `
    );
    mat.userData.shader = shader; // expose for u_warpBlend toggling
  };
  return mat;
}

// Set a window mesh's morph amount (0 = flat, 1 = fully warped). Tolerates the
// material not having compiled yet (onBeforeCompile runs lazily on first render).
function setWarpBlend(mesh, value) {
  const mat = mesh.material;
  mat.userData.pendingWarpBlend = value;
  if (mat.userData.shader) mat.userData.shader.uniforms.u_warpBlend.value = value;
}

// ── Menubar — own canvas/mesh so animation repaints only its small bitmap ──
const menubarSrc = document.getElementById('src-menubar');
menubarSrc.style.width = DESKTOP_W + 'px';
menubarSrc.style.height = MENUBAR_H + 'px';
const menubarChrome = menubarSrc.querySelector('#menubar-chrome');
menubarChrome.style.width = DESKTOP_W + 'px';
menubarChrome.style.height = MENUBAR_H + 'px';

const menubarMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(planeW, MENUBAR_H * S),
  new THREE.MeshBasicMaterial({ map: htmlTexture(menubarChrome), transparent: true, depthWrite: false })
);
menubarMesh.position.set(0, (DESKTOP_H / 2 - MENUBAR_H / 2) * S, 0.005);
menubarMesh.renderOrder = 1;
scene.add(menubarMesh);

// ── Static desktop chrome (wallpaper + dock + trash) ──
const chromeDom = document.getElementById('desktop-chrome');
chromeDom.style.width = DESKTOP_W + 'px';
chromeDom.style.height = DESKTOP_H + 'px';

const chrome = new THREE.Mesh(
  new THREE.PlaneGeometry(planeW, planeH),
  new THREE.MeshBasicMaterial({ map: htmlTexture(chromeDom), transparent: true })
);
chrome.position.z = 0;
scene.add(chrome);

// ── One textured plane per window ─────────────────────────
const sources = [...document.querySelectorAll('#sources .src[data-id]')];
const windowMeshes = [];

await Promise.all(sources.map(async (canvas, i) => {
  const id = canvas.dataset.id;
  const html = await fetch(`windows/${id}.html`).then((r) => r.text());
  canvas.innerHTML = html;

  const el = canvas.querySelector('.os-window');
  const w = canvas.width;
  const h = canvas.height;

  // Pin both the source canvas and the window to exact pixels so the subtree
  // lays out at exactly the bitmap size (no %-of-ambiguous-containing-block
  // squashing while the canvas is parked off-screen).
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';

  // Subdivided 40×1 so vertices can bend along the grid warp (Window Morph demo).
  // At u_warpBlend = 0 (default) this renders pixel-identical to a flat quad.
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w * S, h * S, MORPH_SEGMENTS_X, 1),
    // alphaTest discards the transparent rounded corners so they don't write
    // depth and punch holes through windows stacked behind them.
    // morphMaterial adds the gated vertex warp (u_warpBlend = 0 → flat).
    morphMaterial(el)
  );

  const x = Number(canvas.dataset.x);
  const y = Number(canvas.dataset.y);
  const z = (i + 1) * Z_STEP;

  const cx = Math.min(Math.max(x + w / 2, w / 2), DESKTOP_W - w / 2);
  const cy = Math.min(Math.max(y + h / 2, MENUBAR_H + h / 2), DESKTOP_H - DOCK_CLEARANCE - h / 2);

  mesh.position.set((cx - DESKTOP_W / 2) * S, (DESKTOP_H / 2 - cy) * S, z);

  const scrollEl = [...canvas.querySelectorAll('*')].find(el => {
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll';
  }) ?? null;

  // Music window: cache play button hit area and bar elements before layoutsubtree
  // hides the DOM after first paint.
  let playHitRect = null, playBtnEl = null, barEls = null;
  if (id === 'music') {
    const hitEl = canvas.querySelector('.music-play-hit');
    playBtnEl   = canvas.querySelector('.music-play-btn');
    barEls      = [...canvas.querySelectorAll('.music-bar')];
    if (hitEl) {
      const cr = canvas.getBoundingClientRect();
      const hr = hitEl.getBoundingClientRect();
      playHitRect = { x: hr.left - cr.left, y: hr.top - cr.top, w: hr.width, h: hr.height };
    }
  }

  // Finder window: cache each file's hit rect + element ref so clicks can move the
  // .selected highlight. Same reason as above — layoutsubtree hides the DOM after
  // first paint, so the element refs and geometry must be captured here at init.
  let fileHits = null;
  if (id === 'finder') {
    const cr = canvas.getBoundingClientRect();
    fileHits = [...canvas.querySelectorAll('.finder-file')].map((fileEl) => {
      const hr = fileEl.getBoundingClientRect();
      return { el: fileEl, x: hr.left - cr.left, y: hr.top - cr.top, w: hr.width, h: hr.height };
    });
  }

  // Remember the original placement so the "4" key can reset the demo (see keydown below).
  const home = { x: mesh.position.x, y: mesh.position.y, z };

  windowMeshes.push({ mesh, w, h, id, canvas, scrollEl, playHitRect, playBtnEl, barEls, fileHits, home });
  scene.add(mesh);
}));

// ── Interaction ───────────────────────────────────────────
const windowsApi = initWindows({ gl, camera, windowMeshes, S, chromeSrc: document.getElementById('src-chrome'), menubarSrc, revealUniform: bgMesh.material.uniforms.u_reveal, warpUniform: bgMesh.material.uniforms.u_warpStrength, dragActiveUniform: bgMesh.material.uniforms.u_dragActive, dragBandUniform: bgMesh.material.uniforms.u_dragBand });

// Window Morph (demo): "0" toggles morph on the FRONTMOST window (highest z = last
// clicked/dragged). Toggle in the center for a static morph, or drag toward a flank to
// see the window deform along the grid columns (content becomes hard to read — that's
// the point being demonstrated). NB: a morphed window does NOT track the cursor while
// dragging (it "runs away" in the flank) — this is the known logical-vs-physical
// coordinate gap from the paused vertex-warp experiment, intentionally left unfixed;
// this mode is for demonstrating legibility, not for usable dragging. See plans/.
window.addEventListener('keydown', (e) => {
  if (e.key !== '0' || !windowMeshes.length) return;
  const front = windowMeshes.reduce((a, b) => (b.mesh.position.z > a.mesh.position.z ? b : a));
  const cur = front.mesh.material.userData.pendingWarpBlend ?? 0;
  setWarpBlend(front.mesh, cur > 0 ? 0 : 1);
});

// "4" resets every window to its original position/scale/morph/visibility so the demo
// can be re-run without reloading. Touches windows ONLY — the menubar and grid lines
// (their own meshes/uniforms) are left exactly as they are.
window.addEventListener('keydown', (e) => {
  if (e.key !== '4') return;
  for (const win of windowMeshes) {
    win.mesh.position.set(win.home.x, win.home.y, win.home.z);
    win.mesh.scale.set(1, 1, 1);
    win.mesh.visible = true;
    setWarpBlend(win.mesh, 0);
  }
  windowsApi.resetStack(); // restore stack order so the next click doesn't reshuffle z
});

// ── Render loop ───────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();
