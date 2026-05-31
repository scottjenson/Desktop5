// Scene setup: one static chrome plane + one textured mesh per window.
//
// Two kinds of canvas, deliberately separated:
//   • #gl                  — the visible WebGL output and the only event surface
//   • #sources .src        — hidden <canvas layoutsubtree> texture sources
// HTMLTexture's `onpaint` is a single slot per canvas, so each window needs its
// own source canvas to get an independent, live-updating texture.

import * as THREE from 'three';
import { DESKTOP_W, DESKTOP_H, FOV, CAMERA_Z, Z_STEP, MENUBAR_H, DOCK_CLEARANCE } from './config.js';
import { initWindows } from './windows.js';

// ── Renderer / scene / camera ─────────────────────────────
const gl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true });
renderer.setSize(DESKTOP_W, DESKTOP_H, false); // fixed buffer; CSS handled below
// Render at device resolution so the fitted canvas isn't upscaled (clamped to 2×).
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

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

function htmlTexture(el) {
  const t = new THREE.HTMLTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── Menubar — own canvas/mesh so animation repaints only its 3440×26 bitmap ──
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
  new THREE.MeshBasicMaterial({ map: htmlTexture(chromeDom) })
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

  windowMeshes.push({ mesh, w, h, id });
  scene.add(mesh);
}));

// ── Interaction ───────────────────────────────────────────
initWindows({ gl, camera, windowMeshes, S, chromeSrc: document.getElementById('src-chrome'), menubarSrc });

// ── Render loop ───────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();
