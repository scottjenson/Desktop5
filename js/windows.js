// Window interaction: raycaster-based focus + drag over per-window meshes.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
  PLATEAU_FRAC, SHRINK_FRAC, SHRUNK_PX, SNAP_ZONE_STEP,
} from './config.js';

// ── Helpers ───────────────────────────────────────────────

// Continuous scale as a function of horizontal position (used during normal drag).
function scaleForCenterX(cx, info) {
  const half = (SHRINK_FRAC * DESKTOP_W) / 2;
  const d = Math.abs(cx - DESKTOP_W / 2);
  if (d <= half) return 1;
  const t = Math.min((d - half) / (DESKTOP_W / 2 - half), 1);
  const ts = t * t * (3 - 2 * t); // smoothstep
  return 1 - ts * (1 - SHRUNK_PX / info.w);
}

// Zone highlight rectangles — 6 zones from left to right.
const _pL = DESKTOP_W * (1 - PLATEAU_FRAC) / 2; // plateau left boundary  = 640
const _pM = DESKTOP_W / 2;                        // plateau center         = 1280
const _pR = DESKTOP_W * (1 + PLATEAU_FRAC) / 2; // plateau right boundary = 1920
const _iW = SHRUNK_PX + 90;                       // icon zone width (~200px)
const _cW = DESKTOP_W * PLATEAU_FRAC / 2;         // center zone width = 640px
const _mW = _pL - _iW;                            // mid zone width = 440px

const ZONE_RECTS = [
  { left: 0,              width: _iW }, // zone 0 — icon-left   (x=0,    w=200)
  { left: _iW,            width: _mW }, // zone 1 — mid-left    (x=200,  w=440)
  { left: _pL,            width: _cW }, // zone 2 — left-center (x=640,  w=640)
  { left: _pM,            width: _cW }, // zone 3 — right-center(x=1280, w=640)
  { left: _pR,            width: _mW }, // zone 4 — mid-right   (x=1920, w=440)
  { left: DESKTOP_W - _iW, width: _iW }, // zone 5 — icon-right  (x=2360, w=200)
];

function zoneIndexForCx(cursorCx) {
  if (cursorCx < _iW) return 0;
  if (cursorCx < _pL) return 1;
  if (cursorCx < _pM) return 2;
  if (cursorCx < _pR) return 3;
  if (cursorCx < DESKTOP_W - _iW) return 4;
  return 5;
}

// Returns the snap {cx, scale} for a given zone index.
function snapForZone(index, info) {
  const iconScale = SHRUNK_PX / info.w;
  const snaps = [
    { cx: SHRUNK_PX / 2,             scale: iconScale }, // icon-left  (55)
    { cx: (_iW + _pL) / 2,           scale: 0.5       }, // mid-left   (420)
    { cx: (_pL + _pM) / 2,           scale: 1         }, // left-slot  (960)
    { cx: (_pM + _pR) / 2,           scale: 1         }, // right-slot (1600)
    { cx: (_pR + DESKTOP_W - _iW) / 2, scale: 0.5     }, // mid-right  (2140)
    { cx: DESKTOP_W - SHRUNK_PX / 2, scale: iconScale }, // icon-right (2505)
  ];
  return snaps[index];
}

// ── Main ──────────────────────────────────────────────────

export function initWindows({ gl, camera, windowMeshes, S, chromeSrc, menubarSrc }) {
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

  // ── Zone overlay ────────────────────────────────────────
  const overlay = document.getElementById('snap-zone-overlay');

  function showZone(index) {
    overlay.style.left  = ZONE_RECTS[index].left + 'px';
    overlay.style.width = ZONE_RECTS[index].width + 'px';
    overlay.style.display = 'block';
    chromeSrc.requestPaint?.();
  }
  function hideZone() {
    if (overlay.style.display === 'none') return;
    overlay.style.display = 'none';
    chromeSrc.requestPaint?.();
  }

  // ── Input ───────────────────────────────────────────────
  gl.addEventListener('mousedown', (e) => {
    if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const mesh = hits[0].object;
    const info = infoOf.get(mesh);

    // Interacting during park state ends the session — leave all windows where they are.
    if (parkedWindows.length) parkedWindows = [];

    const idx = stack.indexOf(info);
    if (idx !== -1) { stack.splice(idx, 1); stack.push(info); restack(); }

    const localY = (1 - hits[0].uv.y) * info.h;
    const isShift = e.shiftKey;
    const isIconSized = mesh.scale.x <= (SHRUNK_PX / info.w) * 1.1;

    // Normal drag: titlebar only. Shift-drag or icon-sized: anywhere on the window.
    if (localY <= TITLEBAR_H || isShift || isIconSized) {
      dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), mesh.position);
      raycaster.ray.intersectPlane(dragPlane, hit);

      const { cx, cy } = worldToCenter(mesh.position.x, mesh.position.y);
      const cursorCx = worldToCenter(hit.x, 0).cx;
      const cursorCy = worldToCenter(0, hit.y).cy;
      const grabScale = mesh.scale.x || 1;
      const windowTopY = cy - (info.h * grabScale) / 2;

      drag = {
        mesh, info,
        shift: isShift,
        grabOffsetX: cx - cursorCx,
        topOffsetY:  windowTopY - cursorCy,
        hasMoved: false,
        // Zone starts null — first SNAP_ZONE_STEP px of movement determines the
        // initial zone from cursor position, then ratchets ±1 from there.
        activeZone:   null,
        lastCursorCx: cursorCx,
        accumX: 0,
      };
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return;

    drag.hasMoved = true;
    const { info } = drag;
    const cursorCx = worldToCenter(hit.x, 0).cx;
    const cursorCy = worldToCenter(0, hit.y).cy;

    // X: free drag (same formula for both normal and shift).
    let cx = cursorCx + drag.grabOffsetX;
    let scale = scaleForCenterX(cx, info);
    const halfW = (info.w * scale) / 2;
    cx = Math.min(Math.max(cx, halfW), DESKTOP_W - halfW);
    scale = scaleForCenterX(cx, info);

    // Y: anchor window top to cursor, hard clamped.
    const halfH = (info.h * scale) / 2;
    let windowTopY = cursorCy + drag.topOffsetY;
    windowTopY = Math.max(windowTopY, MENUBAR_H);
    let cy = Math.min(windowTopY + halfH, DESKTOP_H - DOCK_CLEARANCE - halfH);

    // Shift: ratcheted zone selection.
    // First SNAP_ZONE_STEP px sets the initial zone from cursor position;
    // each subsequent SNAP_ZONE_STEP px steps the zone ±1.
    if (drag.shift) {
      drag.accumX += cursorCx - drag.lastCursorCx;
      drag.lastCursorCx = cursorCx;

      if (drag.activeZone === null) {
        // Waiting for first threshold crossing to establish a starting zone.
        if (Math.abs(drag.accumX) >= SNAP_ZONE_STEP) {
          const dir = drag.accumX > 0 ? 1 : -1;
          drag.activeZone = Math.min(5, Math.max(0, zoneIndexForCx(cursorCx) + dir));
          drag.accumX = 0;
          showZone(drag.activeZone);
        }
      } else if (drag.accumX <= -SNAP_ZONE_STEP) {
        drag.activeZone = Math.max(0, drag.activeZone - 1);
        drag.accumX += SNAP_ZONE_STEP;
        showZone(drag.activeZone);
      } else if (drag.accumX >= SNAP_ZONE_STEP) {
        drag.activeZone = Math.min(5, drag.activeZone + 1);
        drag.accumX -= SNAP_ZONE_STEP;
        showZone(drag.activeZone);
      }
    }

    drag.mesh.scale.set(scale, scale, 1);
    const p = centerToWorld(cx, cy);
    drag.mesh.position.x = p.x;
    drag.mesh.position.y = p.y;
  });

  // ── Animation engine ─────────────────────────────────────
  // Drives mesh lerps independently of the Three.js render loop.
  const anims = [];

  function animateTo(mesh, toX, toY, toScale, duration = 400) {
    const existing = anims.findIndex(a => a.mesh === mesh);
    if (existing !== -1) anims.splice(existing, 1);
    anims.push({
      mesh,
      fromX: mesh.position.x, fromY: mesh.position.y, fromScale: mesh.scale.x,
      toX, toY, toScale,
      startTime: performance.now(), duration,
    });
    if (anims.length === 1) tickAnims();
  }

  function tickAnims() {
    const now = performance.now();
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i];
      const t = Math.min((now - a.startTime) / a.duration, 1);
      const e = 1 - Math.pow(1 - t, 3); // cubic ease-out
      a.mesh.position.x = a.fromX + (a.toX - a.fromX) * e;
      a.mesh.position.y = a.fromY + (a.toY - a.fromY) * e;
      const s = a.fromScale + (a.toScale - a.fromScale) * e;
      a.mesh.scale.set(s, s, 1);
      if (t >= 1) anims.splice(i, 1);
    }
    if (anims.length > 0) requestAnimationFrame(tickAnims);
  }

  // ── Shift-hold park-all ───────────────────────────────────
  let parkTimer = null;
  let parkedWindows = []; // [{mesh, origX, origY, origScale}]

  function parkAll() {
    parkedWindows = [];
    for (const w of stack) {
      if (w.mesh.scale.x < 0.95) continue;
      const curCx = worldToCenter(w.mesh.position.x, 0).cx;
      const curCy = DESKTOP_H / 2 - w.mesh.position.y / S;
      parkedWindows.push({ mesh: w.mesh, origX: w.mesh.position.x, origY: w.mesh.position.y, origScale: w.mesh.scale.x });
      const snap = snapForZone(curCx < DESKTOP_W / 2 ? 1 : 4, w);
      const halfH = (w.h * snap.scale) / 2;
      const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
      const p = centerToWorld(snap.cx, cy);
      animateTo(w.mesh, p.x, p.y, snap.scale);
    }
  }

  function restoreAll() {
    for (const pw of parkedWindows) {
      animateTo(pw.mesh, pw.origX, pw.origY, pw.origScale);
    }
    parkedWindows = [];
  }

  // "1" key: toggle menubar centering, driving repaints for the CSS transition.
  const menuLeft  = document.getElementById('menu-left');
  const menuRight = document.querySelector('#menubar .menu-right');
  window.addEventListener('keydown', (e) => {
    if (e.key === '1') {
      menuLeft.classList.toggle('centered');
      menuRight.classList.toggle('centered');
      const end = performance.now() + 450;
      (function repaint() {
        menubarSrc.requestPaint?.();
        if (performance.now() < end) requestAnimationFrame(repaint);
      })();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !e.repeat && !drag) {
      parkTimer = setTimeout(() => { parkTimer = null; parkAll(); }, 1000);
    }
  });

  // Shift released: cancel park timer or restore parked windows; cancel zone highlight.
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
      if (parkedWindows.length) restoreAll();
      if (drag?.shift) { drag.shift = false; drag.activeZone = null; hideZone(); }
    }
  });

  gl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const top = stack[stack.length - 1];
    if (!top?.scrollEl) return;
    top.scrollEl.scrollTop += e.deltaY;
    top.canvas.requestPaint?.();
  }, { passive: false });

  window.addEventListener('mouseup', () => {
    if (drag?.shift && drag.activeZone !== null) {
      // Shift-drag: snap to highlighted zone, preserving current Y.
      const { info, mesh } = drag;
      const snap = snapForZone(drag.activeZone, info);
      const halfH = (info.h * snap.scale) / 2;
      const curCy = DESKTOP_H / 2 - mesh.position.y / S;
      const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
      mesh.scale.set(snap.scale, snap.scale, 1);
      const p = centerToWorld(snap.cx, cy);
      mesh.position.x = p.x;
      mesh.position.y = p.y;
    } else if (drag?.shift && drag.activeZone === null && !drag.hasMoved) {
      // Shift-click (no drag): toggle between full-size center and parked mid zone.
      const { info, mesh } = drag;
      const curScale = mesh.scale.x;
      const curCx = worldToCenter(mesh.position.x, 0).cx;
      const isLeftHalf = curCx < DESKTOP_W / 2;
      const targetZone = curScale >= 0.95
        ? (isLeftHalf ? 1 : 4)   // full-size → park at 50% mid zone
        : (isLeftHalf ? 2 : 3);  // scaled → restore to full-size center zone
      const snap = snapForZone(targetZone, info);
      const halfH = (info.h * snap.scale) / 2;
      const curCy = DESKTOP_H / 2 - mesh.position.y / S;
      const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
      mesh.scale.set(snap.scale, snap.scale, 1);
      const p = centerToWorld(snap.cx, cy);
      mesh.position.x = p.x;
      mesh.position.y = p.y;
    }
    hideZone();
    drag = null;
  });
}
