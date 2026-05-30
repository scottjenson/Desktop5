// Window interaction: raycaster-based focus + drag over per-window meshes.
//
// Each window is its own textured plane. We raycast from the WebGL canvas, so
// hit-testing and z-ordering happen in true 3D — no DOM-coordinate juggling.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
} from './config.js';

// windowMeshes: [{ mesh, w, h, id }]   S: world units per desktop px
export function initWindows({ gl, camera, windowMeshes, S }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const hit = new THREE.Vector3();

  const meshes = windowMeshes.map((w) => w.mesh);
  const infoOf = new Map(windowMeshes.map((w) => [w.mesh, w]));
  let drag = null;

  // Stacking order, back (0) → front. Each window sits in a fixed z-slot by rank,
  // so bringing one to front never pushes z past n*Z_STEP (no cumulative growth).
  const stack = [...windowMeshes];
  function restack() {
    stack.forEach((w, rank) => { w.mesh.position.z = (rank + 1) * Z_STEP; });
  }
  restack();

  function toNdc(e) {
    const r = gl.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  // desktop-px window center <-> world position on the window's z-plane
  const centerToWorld = (cx, cy) => ({ x: (cx - DESKTOP_W / 2) * S, y: (DESKTOP_H / 2 - cy) * S });
  const worldToCenter = (x, y) => ({ cx: x / S + DESKTOP_W / 2, cy: DESKTOP_H / 2 - y / S });

  gl.addEventListener('mousedown', (e) => {
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const mesh = hits[0].object;
    const info = infoOf.get(mesh);

    // Bring to front: move to the top of the stack and reassign fixed z-slots.
    const idx = stack.indexOf(info);
    if (idx !== -1) { stack.splice(idx, 1); stack.push(info); restack(); }

    // Only the titlebar strip initiates a drag. uv origin is bottom-left, so the
    // top edge is v=1; convert to a local pixel y within the window.
    const localY = (1 - hits[0].uv.y) * info.h;
    if (localY <= TITLEBAR_H) {
      dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), mesh.position);
      raycaster.ray.intersectPlane(dragPlane, hit);
      drag = { mesh, info, offX: mesh.position.x - hit.x, offY: mesh.position.y - hit.y };
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return;

    const { info } = drag;
    // Proposed world position, then clamp in desktop-px space.
    let { cx, cy } = worldToCenter(hit.x + drag.offX, hit.y + drag.offY);
    cx = Math.min(Math.max(cx, MENUBAR_H + info.w / 2), DESKTOP_W - info.w / 2);
    cy = Math.min(Math.max(cy, MENUBAR_H + info.h / 2), DESKTOP_H - DOCK_CLEARANCE - info.h / 2);

    const p = centerToWorld(cx, cy);
    drag.mesh.position.x = p.x;
    drag.mesh.position.y = p.y;
  });

  window.addEventListener('mouseup', () => { drag = null; });
}
