// Window interaction: raycaster-based focus + drag over per-window meshes.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
  PLATEAU_FRAC, SHRUNK_PX,
} from './config.js';

// Scale purely as a function of horizontal center position.
function scaleForCenterX(cx, info) {
  const half = (PLATEAU_FRAC * DESKTOP_W) / 2;
  const d = Math.abs(cx - DESKTOP_W / 2);
  if (d <= half) return 1;
  const t = Math.min((d - half) / (DESKTOP_W / 2 - half), 1);
  const ts = t * t * (3 - 2 * t); // smoothstep
  return 1 - ts * (1 - SHRUNK_PX / info.w);
}

export function initWindows({ gl, camera, windowMeshes, S }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const hit = new THREE.Vector3();

  const meshes = windowMeshes.map((w) => w.mesh);
  const infoOf = new Map(windowMeshes.map((w) => [w.mesh, w]));
  let drag = null;

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

  const centerToWorld = (cx, cy) => ({ x: (cx - DESKTOP_W / 2) * S, y: (DESKTOP_H / 2 - cy) * S });
  const worldToCenter = (x, y) => ({ cx: x / S + DESKTOP_W / 2, cy: DESKTOP_H / 2 - y / S });

  gl.addEventListener('mousedown', (e) => {
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const mesh = hits[0].object;
    const info = infoOf.get(mesh);

    const idx = stack.indexOf(info);
    if (idx !== -1) { stack.splice(idx, 1); stack.push(info); restack(); }

    const localY = (1 - hits[0].uv.y) * info.h;
    if (localY <= TITLEBAR_H) {
      dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), mesh.position);
      raycaster.ray.intersectPlane(dragPlane, hit);

      const { cx, cy } = worldToCenter(mesh.position.x, mesh.position.y);
      const cursorCx = worldToCenter(hit.x, 0).cx;
      const cursorCy = worldToCenter(0, hit.y).cy;
      const grabScale = mesh.scale.x || 1;
      const windowTopY = cy - (info.h * grabScale) / 2; // top edge in desktop px at grab time
      drag = {
        mesh, info,
        grabOffsetX: cx - cursorCx,     // cursor → window center x (constant)
        topOffsetY: windowTopY - cursorCy, // cursor → window TOP y (constant)
      };
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return;

    const { info } = drag;
    const cursorCx = worldToCenter(hit.x, 0).cx;
    const cursorCy = worldToCenter(0, hit.y).cy;

    // X: cursor + constant offset → scale → clamp → recompute scale.
    let cx = cursorCx + drag.grabOffsetX;
    let scale = scaleForCenterX(cx, info);
    const halfW = (info.w * scale) / 2;
    cx = Math.min(Math.max(cx, halfW), DESKTOP_W - halfW);
    scale = scaleForCenterX(cx, info);

    // Y: anchor the window TOP to the cursor (not the center), so scale changes
    // grow the window downward and never shift the top edge up or down.
    const halfH = (info.h * scale) / 2;
    let windowTopY = cursorCy + drag.topOffsetY;
    windowTopY = Math.max(windowTopY, MENUBAR_H);                          // hard top clamp
    let cy = windowTopY + halfH;
    cy = Math.min(cy, DESKTOP_H - DOCK_CLEARANCE - halfH);                // hard bottom clamp

    drag.mesh.scale.set(scale, scale, 1);
    const p = centerToWorld(cx, cy);
    drag.mesh.position.x = p.x;
    drag.mesh.position.y = p.y;
  });

  window.addEventListener('mouseup', () => { drag = null; });
}
