// Window interaction: raycaster-based focus + drag over per-window meshes.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
  PLATEAU_FRAC, SHRUNK_PX, SNAP_ZONE_STEP, MID_SCALE,
  WARP_DEADZONE, WARP_POWER, WARP_STRENGTH,
  SHAKE_MIN_TRAVEL, SHAKE_WINDOW_MS, SHAKE_COUNT,
} from './config.js';

// ── Helpers ───────────────────────────────────────────────

// Window scale as a function of normalized horizontal position (xPos ∈ -1..1, 0 = centre).
// This is the exact analytical derivative of the background grid's warp curve
// (gridX = x + sign(x)·flankDist^power·strength): the window shrinks at precisely the
// rate the grid compresses. Dials live in config.js and are shared with the shader,
// so the two physics can never drift. Width-independent — every window shrinks to the
// same factor at a given x (≈1/6 at the screen edge with the default dials).
function getWindowScale(xPos) {
  const flankDist = Math.max(0, Math.abs(xPos) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  const innerDeriv = 1 / (1 - WARP_DEADZONE);
  const derivative = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH * innerDeriv;
  return 1 / (1 + derivative);
}

// Two edge snap zones: left and right.
const _iW = SHRUNK_PX + 90; // icon zone width (~200px)

const ZONE_RECTS = [
  { left: 0,                width: _iW }, // zone 0 — left edge
  { left: DESKTOP_W - _iW, width: _iW }, // zone 1 — right edge
];

// Returns the snap {cx, scale} for a given zone index (0 = left edge, 1 = right edge).
function snapForZone(index, info) {
  const iconScale = SHRUNK_PX / info.w;
  const snaps = [
    { cx: SHRUNK_PX / 2,             scale: iconScale }, // left edge
    { cx: DESKTOP_W - SHRUNK_PX / 2, scale: iconScale }, // right edge
  ];
  return snaps[index];
}

// Park-all uses mid zones (50% scale), not the icon-sized edge zones.
const _pL = DESKTOP_W * (1 - PLATEAU_FRAC) / 2;
const _pR = DESKTOP_W * (1 + PLATEAU_FRAC) / 2;
function parkSnapForSide(isLeft) {
  return isLeft
    ? { cx: (_iW + _pL) / 2,             scale: MID_SCALE }
    : { cx: (_pR + DESKTOP_W - _iW) / 2, scale: MID_SCALE };
}

// ── Main ──────────────────────────────────────────────────

export function initWindows({ gl, camera, windowMeshes, S, chromeSrc, menubarSrc, revealUniform }) {
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
  // Desktop-px center X → normalized -1..1 (matches the shader's centerX space).
  const cxToNorm = (cx) => (cx - DESKTOP_W / 2) / (DESKTOP_W / 2);

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

  // ── Music player ─────────────────────────────────────────
  const BAR_FREQS  = [0.9, 1.4, 0.7, 1.2, 0.85, 1.55, 1.0];
  const BAR_PHASES = [0, 1.1, 2.3, 0.7, 1.85, 0.4, 2.9];
  const BAR_MIN = 4, BAR_MAX = 28;
  let musicPlaying = false;
  let musicAnimId  = null;
  const musicInfo  = windowMeshes.find(w => w.id === 'music');

  function animateBars() {
    const t = performance.now() / 1000;
    for (let i = 0; i < musicInfo.barEls.length; i++) {
      const h = BAR_MIN + (BAR_MAX - BAR_MIN) * (0.5 + 0.5 * Math.sin(t * BAR_FREQS[i] * Math.PI * 2 + BAR_PHASES[i]));
      musicInfo.barEls[i].style.height = h + 'px';
      musicInfo.barEls[i].style.opacity = '1';
    }
    musicInfo.canvas.requestPaint?.();
    if (musicPlaying) musicAnimId = requestAnimationFrame(animateBars);
  }

  function togglePlay() {
    musicPlaying = !musicPlaying;
    musicInfo.playBtnEl.textContent = musicPlaying ? '⏸' : '▶';
    if (musicPlaying) {
      if (musicAnimId) cancelAnimationFrame(musicAnimId);
      animateBars();
    } else {
      for (const bar of musicInfo.barEls) {
        bar.style.height = BAR_MIN + 'px';
        bar.style.opacity = '0.15';
      }
      musicInfo.canvas.requestPaint?.();
    }
  }

  // ── Input ───────────────────────────────────────────────
  gl.addEventListener('mousedown', (e) => {
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const mesh = hits[0].object;
    const info = infoOf.get(mesh);


    const idx = stack.indexOf(info);
    if (idx !== -1) { stack.splice(idx, 1); stack.push(info); restack(); }

    // Music play button hit detection (body click, not a drag).
    if (info.playHitRect && !e.shiftKey) {
      const hitX = hits[0].uv.x * info.w;
      const hitY = (1 - hits[0].uv.y) * info.h;
      const r = info.playHitRect;
      if (hitX >= r.x && hitX <= r.x + r.w && hitY >= r.y && hitY <= r.y + r.h) {
        togglePlay();
        e.preventDefault();
        return;
      }
    }

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
        activeZone:    null,
        startCursorCx: cursorCx,
        shakeDir:      0,
        shakeLastCx:   cursorCx,
        shakeTimes:    [],
        shook:         false,
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

    // X: free drag with self-consistent clamp.
    // scale depends on cx, so halfW depends on cx — a single-pass clamp undershoots
    // (the clamped position is less compressed → larger halfW → edge overshoots 0).
    // Iterate to convergence: typically done in 3–4 steps.
    let cx = cursorCx + drag.grabOffsetX;
    for (let i = 0; i < 5; i++) {
      const s = getWindowScale(cxToNorm(cx));
      const hw = (info.w * s) / 2;
      const clamped = Math.min(Math.max(cx, hw), DESKTOP_W - hw);
      if (Math.abs(clamped - cx) < 0.05) { cx = clamped; break; }
      cx = clamped;
    }
    const scale = getWindowScale(cxToNorm(cx));

    // Y: anchor window top to cursor, hard clamped.
    const halfH = (info.h * scale) / 2;
    let windowTopY = cursorCy + drag.topOffsetY;
    windowTopY = Math.max(windowTopY, MENUBAR_H);
    let cy = Math.min(windowTopY + halfH, DESKTOP_H - DOCK_CLEARANCE - halfH);

    // Shift: highlight left or right edge zone based on drag direction (suppressed after shake).
    if (drag.shift && !drag.shook) {
      const dx = cursorCx - drag.startCursorCx;
      let newZone = null;
      if (dx < -SNAP_ZONE_STEP) newZone = 0;      // left edge
      else if (dx > SNAP_ZONE_STEP) newZone = 1;  // right edge

      if (newZone !== drag.activeZone) {
        drag.activeZone = newZone;
        if (newZone !== null) showZone(newZone);
        else hideZone();
      }
    }

    // Shake detection: count direction reversals with min travel filter.
    const shakeDx = cursorCx - drag.shakeLastCx;
    if (Math.abs(shakeDx) >= SHAKE_MIN_TRAVEL) {
      const dir = shakeDx > 0 ? 1 : -1;
      if (drag.shakeDir !== 0 && dir !== drag.shakeDir) {
        const now = performance.now();
        drag.shakeTimes.push(now);
        drag.shakeTimes = drag.shakeTimes.filter(t => now - t < SHAKE_WINDOW_MS);
        if (drag.shakeTimes.length >= SHAKE_COUNT) {
          parkAll(drag.mesh);
          drag.activeZone = null;
          drag.shook = true;
          hideZone();
          drag.shakeTimes = [];
        }
      }
      drag.shakeDir  = dir;
      drag.shakeLastCx = cursorCx;
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

  // ── Park-all (shake gesture) ──────────────────────────────
  // Parks all full-size windows to mid zones, except the one being dragged.
  function parkAll(excludeMesh) {
    const leftGroup = [];
    const rightGroup = [];

    for (const w of stack) {
      if (w.mesh === excludeMesh) continue;
      if (w.mesh.scale.x < 0.95) continue;
      const curCx = worldToCenter(w.mesh.position.x, 0).cx;
      const curCy = DESKTOP_H / 2 - w.mesh.position.y / S;
      const snap = parkSnapForSide(curCx < DESKTOP_W / 2);
      const halfH = (w.h * snap.scale) / 2;
      const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
      (curCx < DESKTOP_W / 2 ? leftGroup : rightGroup).push({ w, snap, cy });
    }

    for (const group of [leftGroup, rightGroup]) {
      group.sort((a, b) => a.cy - b.cy);
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const cur  = group[i];
        const prevBottom = prev.cy + (prev.w.h * prev.snap.scale) / 2;
        const curHalfH   = (cur.w.h  * cur.snap.scale)  / 2;
        const minCy = prevBottom + 10 + curHalfH;
        if (cur.cy < minCy) cur.cy = Math.min(minCy, DESKTOP_H - DOCK_CLEARANCE - curHalfH);
      }
    }

    for (const { w, snap, cy } of [...leftGroup, ...rightGroup]) {
      const p = centerToWorld(snap.cx, cy);
      animateTo(w.mesh, p.x, p.y, snap.scale);
    }
  }

  // "1" key: toggle menubar centering + pill shape, driving repaints for CSS transitions.
  const menuLeft  = document.getElementById('menu-left');
  const menuRight = document.querySelector('#menubar .menu-right');
  const menubar   = document.getElementById('menubar');
  window.addEventListener('keydown', (e) => {
    if (e.key === '1') {
      menuLeft.classList.toggle('centered');
      menuRight.classList.toggle('centered');
      menubar.classList.toggle('centered');
      const end = performance.now() + 500;
      (function repaint() {
        menubarSrc.requestPaint?.();
        if (performance.now() < end) requestAnimationFrame(repaint);
      })();
    }
  });

  // "2" key: reveal/hide the grid background with a vertical door-open animation.
  let gridOpen = false;
  let revealAnimId = null;
  window.addEventListener('keydown', (e) => {
    if (e.key === '2') {
      gridOpen = !gridOpen;
      const from = revealUniform.value;
      const to   = gridOpen ? 1.0 : 0.0;
      const duration = 600;
      const start = performance.now();
      if (revealAnimId) cancelAnimationFrame(revealAnimId);
      (function tick() {
        const t = Math.min((performance.now() - start) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3); // cubic ease-out
        revealUniform.value = from + (to - from) * eased;
        if (t < 1) revealAnimId = requestAnimationFrame(tick);
        else revealAnimId = null;
      })();
    }
  });

  // Shift released: cancel zone highlight.
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
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
    }
    hideZone();
    drag = null;
  });
}
