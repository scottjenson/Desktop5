// Window interaction: raycaster-based focus + drag over per-window meshes.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
  PLATEAU_FRAC, SHRUNK_PX, SNAP_ZONE_STEP, MID_SCALE, MIN_SCALE,
  WARP_DEADZONE, WARP_POWER, WARP_STRENGTH,
  SHAKE_MIN_TRAVEL, SHAKE_WINDOW_MS, SHAKE_COUNT,
  HIGHLIGHT_FADE_IN_MS, HIGHLIGHT_FADE_OUT_MS,
  MUSIC_COMPACT_SCALE, MUSIC_COMPACT_BTN_PX,
  EXPOSE_BOX_FRAC, EXPOSE_GAP_PX, EXPOSE_MAX_SCALE, EXPOSE_FILL,
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
  return Math.max(MIN_SCALE, 1 / (1 + derivative));
}

// The GRID's local scale at a normalized x — same curve as getWindowScale but UNCLAMPED.
// The shader's gridYcoord = centerY / localScale uses this exact (un-floored) value, so the
// drag band must too, or it would drift from the lines once the window hits MIN_SCALE.
function gridLocalScale(xPos) {
  const flankDist = Math.max(0, Math.abs(xPos) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  const innerDeriv = 1 / (1 - WARP_DEADZONE);
  const derivative = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH * innerDeriv;
  return 1 / (1 + derivative);
}

// Forward warp f(xs): PHYSICAL normalized x → LOGICAL normalized x. Closed form —
// the same curve the grid shader draws and the morph vertex shader inverts with
// Newton; the forward direction needs no iteration.
function warpForward(xsNorm) {
  const flankDist = Math.max(0, Math.abs(xsNorm) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
  return xsNorm + Math.sign(xsNorm) * Math.pow(flankDist, WARP_POWER) * WARP_STRENGTH;
}

// Newton inverse of warpForward (mirrors the morph vertex shader): LOGICAL
// normalized x → PHYSICAL normalized x. 4 iterations = sub-pixel on this smooth
// monotonic curve.
function warpInverse(xwNorm) {
  let xs = xwNorm;
  for (let i = 0; i < 4; i++) {
    const flankDist = Math.max(0, Math.abs(xs) - WARP_DEADZONE) / (1 - WARP_DEADZONE);
    const deriv = WARP_POWER * Math.pow(flankDist, Math.max(0, WARP_POWER - 1)) * WARP_STRENGTH / (1 - WARP_DEADZONE);
    xs -= (warpForward(xs) - xwNorm) / (1 + deriv);
  }
  return xs;
}

// Physical cursor (desktop px) → LOGICAL desktop px, for dragging MORPHED windows.
// The raycaster returns physical coords but a morphed mesh's position is logical —
// the gap documented in plans/vertex-warp-experiment.md ("runs away" drag). Y per
// shape mode: 0 (faithful) pulls Y toward the screen equator by localScale, so
// divide it back out at the cursor's x; 1 (creased) pivots on the window's own
// centerline, so the window CENTER needs no Y correction.
function cursorToLogical(cxPhys, cyPhys, morphMode) {
  const xsNorm = (cxPhys - DESKTOP_W / 2) / (DESKTOP_W / 2);
  const cx = (warpForward(xsNorm) + 1) * (DESKTOP_W / 2);
  let cy = cyPhys;
  if (morphMode === 0) {
    cy = DESKTOP_H / 2 - (DESKTOP_H / 2 - cyPhys) / gridLocalScale(xsNorm);
  }
  return { cx, cy };
}

// Edge zones: icon-sized positions at the far left and right (shift-drag snap target).
const _iW = SHRUNK_PX + 90; // edge zone width (~200px)

const EDGE_ZONES = [
  { left: 0,                width: _iW }, // left edge
  { left: DESKTOP_W - _iW, width: _iW }, // right edge
];

// Snap position for the edge zones (icon-sized, shift-drag release).
function snapToEdge(isLeft, info) {
  const iconScale = SHRUNK_PX / info.w;
  return isLeft
    ? { cx: SHRUNK_PX / 2,             scale: iconScale }
    : { cx: DESKTOP_W - SHRUNK_PX / 2, scale: iconScale };
}

// Stash zones: 50%-scale mid positions used by stashAll() and shift-click.
const _pL = DESKTOP_W * (1 - PLATEAU_FRAC) / 2;
const _pR = DESKTOP_W * (1 + PLATEAU_FRAC) / 2;
function snapToStash(isLeft) {
  return isLeft
    ? { cx: (_iW + _pL) / 2,             scale: MID_SCALE }
    : { cx: (_pR + DESKTOP_W - _iW) / 2, scale: MID_SCALE };
}

// ── Main ──────────────────────────────────────────────────

export function initWindows({ gl, camera, windowMeshes, S, chromeSrc, menubarSrc, revealUniform, warpUniform, dragActiveUniform, dragBandUniform, invalidate }) {
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
    invalidate();
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

  // ── Drag Rails (Phase 3) ──────────────────────────────────
  // Write the dragged window's vertical extent into u_dragBand, in the shader's gridYcoord
  // (logical-Y) space, so the count of highlighted horizontal lines is warp-invariant.
  //   desktop-px y → centerY:  centerY = 1 - 2·(y/DESKTOP_H)   (top=+1, bottom=-1)
  // The centerY → gridYcoord mapping depends on how the window converges:
  //   flat: window sits at physical = logical x, UNCONVERGED vertically → it spans
  //         more grid rows in the flank: divide the whole extent by ls(cx).
  //   morphed mode 0 (faithful): converges exactly WITH the grid → always covers
  //         the same logical rows: the band IS the logical extent, no division.
  //         (Dividing by ls at the overscrolled LOGICAL cx was the giant-band bug.)
  //   morphed mode 1 (creased): center y is unwarped (pivot = window centerline),
  //         but the fold converges the height ≈ like the grid → scale only the
  //         center term by 1/ls at the window's PHYSICAL center x.
  function writeDragBand(cx, cy, scale, info, morphed, morphMode) {
    const centerY = 1 - 2 * (cy / DESKTOP_H);
    const hc = (info.h * scale) / DESKTOP_H; // half-height in centerY units
    let top, bot;
    if (!morphed) {
      const ls = gridLocalScale(cxToNorm(cx));
      top = (centerY + hc) / ls;
      bot = (centerY - hc) / ls;
    } else if (morphMode === 0) {
      top = centerY + hc;
      bot = centerY - hc;
    } else {
      const ls = gridLocalScale(warpInverse(cxToNorm(cx)));
      top = centerY / ls + hc;
      bot = centerY / ls - hc;
    }
    // band.x = top (larger gridYcoord), band.y = bottom (smaller). Shader treats them as a pair.
    dragBandUniform.value.set(top, bot);
  }

  // u_dragActive fade — a dedicated rAF loop (the mesh animation engine lerps transforms,
  // not uniforms). Fades 0→1 on grab, 1→0 on release.
  let fadeRaf = 0;
  function fadeDragActive(target, duration) {
    const from = dragActiveUniform.value;
    const start = performance.now();
    if (fadeRaf) cancelAnimationFrame(fadeRaf);
    const step = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      const e = 1 - Math.pow(1 - t, 3); // cubic ease-out, matches the mesh engine
      dragActiveUniform.value = from + (target - from) * e;
      invalidate();
      if (t < 1) fadeRaf = requestAnimationFrame(step);
      else fadeRaf = 0;
    };
    step();
  }

  // ── Zone overlay ────────────────────────────────────────
  const overlay = document.getElementById('snap-zone-overlay');

  function showZone(index) {
    overlay.style.left  = EDGE_ZONES[index].left + 'px';
    overlay.style.width = EDGE_ZONES[index].width + 'px';
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

  // ── Music compact mode ────────────────────────────────────
  // When the music window shrinks past MUSIC_COMPACT_SCALE (≈ parking at the edge),
  // swap to a stripped layout with one giant Play/Pause button. The DOM bitmap stays
  // full-res and is GPU-scaled down, so the big button renders crisp at any on-screen
  // size. The hit-test reads info.playHitRect in bitmap-px (uv·info.w), so we just swap
  // that rect alongside the .compact CSS class. Hit rect mirrors the CSS button geometry.
  let musicCompact = false;
  const musicFullHitRect = musicInfo?.playHitRect ?? null;
  const musicCompactHitRect = musicInfo ? {
    x: (musicInfo.w - MUSIC_COMPACT_BTN_PX) / 2,
    y: (musicInfo.h - MUSIC_COMPACT_BTN_PX) / 2,
    w: MUSIC_COMPACT_BTN_PX,
    h: MUSIC_COMPACT_BTN_PX,
  } : null;

  function setMusicCompact(on) {
    if (!musicInfo?.rootEl || on === musicCompact) return;
    musicCompact = on;
    musicInfo.rootEl.classList.toggle('compact', on);
    musicInfo.playHitRect = on ? musicCompactHitRect : musicFullHitRect;
    musicInfo.canvas.requestPaint?.();
  }

  // Called from the scale-set sites (drag, anim, edge snap). Acts only on a crossing.
  function updateMusicCompact() {
    if (!musicInfo) return;
    setMusicCompact(musicInfo.mesh.scale.x < MUSIC_COMPACT_SCALE);
  }

  // ── Input ───────────────────────────────────────────────
  gl.addEventListener('mousedown', (e) => {
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    // Raycaster does NOT skip invisible meshes — without this filter the hidden
    // window clones ("d" key) would steal clicks from the windows behind them.
    const hits = raycaster.intersectObjects(meshes, false).filter((h) => h.object.visible);
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

    // Finder file selection: clicking a file moves the .selected highlight to it.
    // Falls through to normal window behaviour when the click misses every file.
    if (info.fileHits && !e.shiftKey) {
      const hitX = hits[0].uv.x * info.w;
      const hitY = (1 - hits[0].uv.y) * info.h;
      const f = info.fileHits.find(r => hitX >= r.x && hitX <= r.x + r.w && hitY >= r.y && hitY <= r.y + r.h);
      if (f) {
        info.fileHits.forEach(r => r.el.classList.remove('selected'));
        f.el.classList.add('selected');
        info.canvas.requestPaint?.();
        e.preventDefault();
        return;
      }
    }

    const localY = (1 - hits[0].uv.y) * info.h;
    const isShift = e.shiftKey;
    const isIconSized = mesh.scale.x <= Math.max(SHRUNK_PX / info.w, MIN_SCALE) * 1.1;

    // Normal drag: titlebar only. Shift-drag or icon-sized: anywhere on the window.
    if (localY <= TITLEBAR_H || isShift || isIconSized) {
      dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), mesh.position);
      raycaster.ray.intersectPlane(dragPlane, hit);

      const { cx, cy } = worldToCenter(mesh.position.x, mesh.position.y);
      // Morphed windows track in LOGICAL space: forward-warp the physical cursor
      // so grab offsets and the mousemove tracking share the window's own space.
      const morphed = (mesh.material.userData.pendingWarpBlend ?? 0) > 0;
      const morphMode = mesh.material.userData.pendingMorphMode ?? 0;
      const physCx = worldToCenter(hit.x, 0).cx;
      const physCy = worldToCenter(0, hit.y).cy;
      const { cx: cursorCx, cy: cursorCy } = morphed ? cursorToLogical(physCx, physCy, morphMode) : { cx: physCx, cy: physCy };
      const grabScale = mesh.scale.x || 1;
      const windowTopY = cy - (info.h * grabScale) / 2;

      drag = {
        mesh, info,
        shift: isShift,
        morphed, morphMode, grabScale,
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

      // Drag Rails: light up the horizontal lines behind the grabbed window.
      writeDragBand(cx, cy, grabScale, info, morphed, morphMode);
      fadeDragActive(1, HIGHLIGHT_FADE_IN_MS);
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
    const physCx = worldToCenter(hit.x, 0).cx;
    const physCy = worldToCenter(0, hit.y).cy;
    const { cx: cursorCx, cy: cursorCy } = drag.morphed ? cursorToLogical(physCx, physCy, drag.morphMode) : { cx: physCx, cy: physCy };

    let cx = cursorCx + drag.grabOffsetX;
    let scale;
    if (drag.morphed) {
      // The warp compresses a morphed window GEOMETRICALLY — applying the flat
      // pipeline's getWindowScale on top double-shrinks it (the "accelerating
      // scale" bug). Freeze the grab scale; the warp does ALL the compressing.
      scale = drag.grabScale;
      // Logical-overscroll clamp: the logical desktop edge renders at only
      // f⁻¹(1) ≈ 0.78 of the physical half-width — an invisible wall. Allow the
      // logical center out to (2 + WARP_STRENGTH)·half-width so the compressed
      // VISUAL edge can reach the physical bezel (plans/vertex-warp-experiment.md).
      const hw = (info.w * scale) / 2;
      const maxCx = (DESKTOP_W / 2) * (2 + WARP_STRENGTH) - hw;
      cx = Math.min(Math.max(cx, DESKTOP_W - maxCx), maxCx);
    } else {
      // X: free drag with self-consistent clamp.
      // scale depends on cx, so halfW depends on cx — a single-pass clamp undershoots
      // (the clamped position is less compressed → larger halfW → edge overshoots 0).
      // Iterate to convergence: typically done in 3–4 steps.
      for (let i = 0; i < 5; i++) {
        const s = getWindowScale(cxToNorm(cx));
        const hw = (info.w * s) / 2;
        const clamped = Math.min(Math.max(cx, hw), DESKTOP_W - hw);
        if (Math.abs(clamped - cx) < 0.05) { cx = clamped; break; }
        cx = clamped;
      }
      scale = getWindowScale(cxToNorm(cx));
    }

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
          stashAll(drag.mesh);
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

    if (drag.info === musicInfo) updateMusicCompact();

    // Drag Rails: recompute the band every frame — horizontal drift into the flank
    // changes localScale (and thus the gridYcoord band) even with no vertical motion.
    writeDragBand(cx, cy, scale, info, drag.morphed, drag.morphMode);
    invalidate();
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
    invalidate();
    const now = performance.now();
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i];
      const t = Math.min((now - a.startTime) / a.duration, 1);
      const e = 1 - Math.pow(1 - t, 3); // cubic ease-out
      a.mesh.position.x = a.fromX + (a.toX - a.fromX) * e;
      a.mesh.position.y = a.fromY + (a.toY - a.fromY) * e;
      const s = a.fromScale + (a.toScale - a.fromScale) * e;
      a.mesh.scale.set(s, s, 1);
      if (a.mesh === musicInfo?.mesh) updateMusicCompact();
      if (t >= 1) anims.splice(i, 1);
    }
    if (anims.length > 0) requestAnimationFrame(tickAnims);
  }

  // ── Stash-all (shake gesture) ─────────────────────────────
  // Stashes all full-size windows to stash zones, except the one being dragged.
  function stashAll(excludeMesh) {
    const leftGroup = [];
    const rightGroup = [];

    for (const w of stack) {
      if (w.mesh === excludeMesh) continue;
      if (w.mesh.scale.x < 0.95) continue;
      const curCx = worldToCenter(w.mesh.position.x, 0).cx;
      const curCy = DESKTOP_H / 2 - w.mesh.position.y / S;
      const snap = snapToStash(curCx < DESKTOP_W / 2);
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

  // ── Exposé (hold "e") ─────────────────────────────────────
  // Quasimode: keydown saves every visible window's transform and spreads them
  // non-overlapping at one uniform scale; keyup restores. The saved state lives only
  // for the duration of the hold (Learning #8's statelessness is about the stash
  // gesture; a held peek is inherently save-and-restore).
  let exposeSaved = null;

  // Pack all visible windows into a box centered on the desktop, in ≈√n rows of
  // near-equal count (5 windows → 3+2, the classic Exposé cluster). Uniform scale from
  // total area (Exposé look); each row is centered, the row block is centered
  // vertically. Row count is TARGETED rather than wrapped-on-overflow — at demo sizes
  // every window fits one row, so width-wrapping alone never stacked vertically. If a
  // row overflows the box width or the block overflows the height, shrink and repack —
  // sizes decay geometrically, so this always terminates.
  function exposeSlots() {
    const wins = stack
      .filter((w) => w.mesh.visible)
      .map((w) => ({ w, ...worldToCenter(w.mesh.position.x, w.mesh.position.y) }))
      .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx)); // reading order ≈ nearest slot
    if (!wins.length) return [];

    const boxW = DESKTOP_W * EXPOSE_BOX_FRAC;
    const boxH = DESKTOP_H - MENUBAR_H - DOCK_CLEARANCE;
    const totalArea = wins.reduce((sum, { w }) => sum + w.w * w.h, 0);
    let s = Math.min(EXPOSE_MAX_SCALE, Math.sqrt((EXPOSE_FILL * boxW * boxH) / totalArea));

    const nRows = Math.max(1, Math.round(Math.sqrt(wins.length)));
    const perRow = Math.ceil(wins.length / nRows);
    const rows = [];
    for (let i = 0; i < wins.length; i += perRow) rows.push(wins.slice(i, i + perRow));

    for (;;) {
      const widest = Math.max(...rows.map(
        (r) => r.reduce((sum, i) => sum + i.w.w * s, 0) + EXPOSE_GAP_PX * (r.length - 1)));
      if (widest > boxW) { s *= 0.9; continue; }

      const rowH = rows.map((r) => Math.max(...r.map((i) => i.w.h * s)));
      const totalH = rowH.reduce((a, b) => a + b, 0) + EXPOSE_GAP_PX * (rows.length - 1);
      if (totalH > boxH) { s *= 0.9; continue; }

      const slots = [];
      let y = MENUBAR_H + (boxH - totalH) / 2;
      rows.forEach((r, ri) => {
        const rowWidth = r.reduce((sum, i) => sum + i.w.w * s, 0) + EXPOSE_GAP_PX * (r.length - 1);
        let x = (DESKTOP_W - rowWidth) / 2;
        for (const i of r) {
          slots.push({ w: i.w, cx: x + (i.w.w * s) / 2, cy: y + rowH[ri] / 2, scale: s });
          x += i.w.w * s + EXPOSE_GAP_PX;
        }
        y += rowH[ri] + EXPOSE_GAP_PX;
      });
      return slots;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'e' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (exposeSaved || drag) return;
    const slots = exposeSlots();
    if (!slots.length) return;
    exposeSaved = slots.map(({ w }) => ({
      mesh: w.mesh, x: w.mesh.position.x, y: w.mesh.position.y, scale: w.mesh.scale.x,
    }));
    for (const { w, cx, cy, scale } of slots) {
      const p = centerToWorld(cx, cy);
      animateTo(w.mesh, p.x, p.y, scale);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() !== 'e' || !exposeSaved) return;
    for (const saved of exposeSaved) animateTo(saved.mesh, saved.x, saved.y, saved.scale);
    exposeSaved = null;
  });

  // ── Doubling (toggle "d") ─────────────────────────────────
  // Shows/hides the window clones built in main.js, doubling the desktop to 10
  // windows so Exposé ("e") demonstrates its clutter problem. On show, each clone
  // lands at its sibling's CURRENT position plus its stagger offset (clamped), at
  // full size. Blocked while Exposé is held — the packed set must not change mid-peek.
  let doubled = false;
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'd' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (exposeSaved) return;
    doubled = !doubled;
    for (const w of windowMeshes) {
      if (!w.cloneOf) continue;
      if (doubled) {
        const sib = worldToCenter(w.cloneOf.mesh.position.x, w.cloneOf.mesh.position.y);
        const cx = Math.min(Math.max(sib.cx + w.cloneOffset[0], w.w / 2), DESKTOP_W - w.w / 2);
        const cy = Math.min(Math.max(sib.cy + w.cloneOffset[1], MENUBAR_H + w.h / 2), DESKTOP_H - DOCK_CLEARANCE - w.h / 2);
        const p = centerToWorld(cx, cy);
        w.mesh.position.x = p.x;
        w.mesh.position.y = p.y;
        w.mesh.scale.set(1, 1, 1);
      }
      w.mesh.visible = doubled;
    }
    invalidate();
  });

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

  // "2" key: reveal/hide the grid background with a horizontal door-open animation.
  // On first open, chains into a boot morph: flat grid → spatial funnel.
  let gridOpen = false;
  let revealAnimId = null;
  let warpBootDone = false;

  function runWarpBoot() {
    warpBootDone = true;
    const duration = 2500;
    const start = performance.now();
    (function warpTick() {
      const t = Math.min((performance.now() - start) / duration, 1);
      const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; // cubic ease-in-out
      warpUniform.value = eased * WARP_STRENGTH;
      invalidate();
      if (t < 1) requestAnimationFrame(warpTick);
    })();
  }

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
        invalidate();
        if (t < 1) {
          revealAnimId = requestAnimationFrame(tick);
        } else {
          revealAnimId = null;
          if (gridOpen && !warpBootDone) runWarpBoot();
        }
      })();
    }
  });

  // "3" key: toggle visibility of all windows. Used to clear the desktop before
  // switching to Demo 3 (whose word-processor window is too different to morph to),
  // so the tab switch reveals a "new window" on an otherwise-matching empty desktop.
  let windowsHidden = false;
  let hiddenSnapshot = null; // meshes visible at hide time — unhide must not reveal clones
  window.addEventListener('keydown', (e) => {
    if (e.key === '3') {
      windowsHidden = !windowsHidden;
      if (windowsHidden) {
        hiddenSnapshot = meshes.filter((m) => m.visible);
        meshes.forEach((m) => { m.visible = false; });
      } else {
        (hiddenSnapshot ?? meshes).forEach((m) => { m.visible = true; });
        hiddenSnapshot = null;
      }
      invalidate();
    }
  });

  // Text-selection guards. The source DOM is real off-screen text: Cmd+A would
  // select-all across every window's subtree (untrappable, since it's off-screen),
  // and any stray selection bleeds a blue highlight into the textures. Suppress
  // Cmd/Ctrl+A entirely, and let Escape collapse any selection that did occur
  // (e.g. a drag inside the word processor's selectable body).
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      window.getSelection()?.removeAllRanges();
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
    // Drag Rails: fade the highlight out whenever a drag ends.
    if (drag) fadeDragActive(0, HIGHLIGHT_FADE_OUT_MS);

    if (drag?.shift && drag.activeZone !== null) {
      // Shift-drag: snap to highlighted edge zone, preserving current Y.
      const { info, mesh } = drag;
      const snap = snapToEdge(drag.activeZone === 0, info);
      const halfH = (info.h * snap.scale) / 2;
      const curCy = DESKTOP_H / 2 - mesh.position.y / S;
      const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
      mesh.scale.set(snap.scale, snap.scale, 1);
      const p = centerToWorld(snap.cx, cy);
      mesh.position.x = p.x;
      mesh.position.y = p.y;
      if (info === musicInfo) updateMusicCompact();
      invalidate();
    } else if (drag?.shift && drag.activeZone === null && !drag.hasMoved) {
      // Shift-click: toggle between full-size center and mid-zone park.
      const { info, mesh } = drag;
      const curScale = mesh.scale.x;
      const curCx = worldToCenter(mesh.position.x, 0).cx;
      const curCy = DESKTOP_H / 2 - mesh.position.y / S;
      if (curScale >= 0.95) {
        // Full-size → stash on current side.
        const snap = snapToStash(curCx < DESKTOP_W / 2);
        const halfH = (info.h * snap.scale) / 2;
        const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
        animateTo(mesh, centerToWorld(snap.cx, cy).x, centerToWorld(snap.cx, cy).y, snap.scale);
      } else {
        // Parked → restore to full-size center.
        const halfH = info.h / 2;
        const cy = Math.min(Math.max(curCy, MENUBAR_H + halfH), DESKTOP_H - DOCK_CLEARANCE - halfH);
        animateTo(mesh, centerToWorld(DESKTOP_W / 2, cy).x, centerToWorld(DESKTOP_W / 2, cy).y, 1.0);
      }
    }
    hideZone();
    drag = null;
  });

  // Restore the stack to its original (build) order and re-apply z by rank. Used by the
  // "4" demo-reset key so the NEXT click doesn't restack windows to a reordered z.
  // Also cancels any in-flight mesh animations + active drag so they don't clobber the
  // home positions main.js just set.
  function resetStack() {
    anims.length = 0;   // drop any running park/restore lerps
    drag = null;        // abandon an in-progress drag
    exposeSaved = null; // a held "e" must not restore pre-reset transforms on keyup
    doubled = false;    // main.js just hid the clones (home.visible) — keep "d" in step
    windowsHidden = false; hiddenSnapshot = null; // ditto for the "3" hide-all toggle
    stack.length = 0;
    stack.push(...windowMeshes);
    restack();
    updateMusicCompact(); // main.js reset scale to 1 → drop compact mode if it was on
  }

  return { resetStack };
}
