// Scene setup: one static chrome plane + one textured mesh per window.
//
// Two kinds of canvas, deliberately separated:
//   • #gl                  — the visible WebGL output and the only event surface
//   • #sources .src        — hidden <canvas layoutsubtree> texture sources
// HTMLTexture's `onpaint` is a single slot per canvas, so each window needs its
// own source canvas to get an independent, live-updating texture.

import * as THREE from 'three';
import { DESKTOP_W, DESKTOP_H, FOV, CAMERA_Z, Z_STEP, MENUBAR_H, DOCK_CLEARANCE, GRID_CELL_PX, WARP_DEADZONE, WARP_POWER, WARP_STRENGTH, RENDER_SUPERSAMPLE, GRID_LINE_CORE_PX, GRID_LINE_GLOW_PX, GRID_GLOW_STRENGTH, GRID_EDGE_FADE_START } from './config.js';
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
  uniform vec3  u_bgColor;
  uniform vec3  u_lineColor;    // crisp core colour (near-white)
  uniform vec3  u_glowColor;    // tinted halo colour (theme accent)
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

    // Composite on the dark background: additive tinted glow, crisp core on top.
    vec3 col = u_bgColor;
    col += u_glowColor * glow;
    col = mix(col, u_lineColor, core);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
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
      u_warpStrength: { value: WARP_STRENGTH },
      u_coreWidth:    { value: GRID_LINE_CORE_PX },
      u_glowWidth:    { value: GRID_LINE_GLOW_PX },
      u_glowStrength: { value: GRID_GLOW_STRENGTH },
      u_edgeFadeStart:{ value: GRID_EDGE_FADE_START },
      u_bgColor:      { value: new THREE.Color(0x0d1b3e) },
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

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w * S, h * S),
    // alphaTest discards the transparent rounded corners so they don't write
    // depth and punch holes through windows stacked behind them.
    new THREE.MeshBasicMaterial({ map: htmlTexture(el), transparent: true, alphaTest: 0.5 })
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

  windowMeshes.push({ mesh, w, h, id, canvas, scrollEl });
  scene.add(mesh);
}));

// ── Interaction ───────────────────────────────────────────
initWindows({ gl, camera, windowMeshes, S, chromeSrc: document.getElementById('src-chrome'), menubarSrc });

// ── Render loop ───────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();
