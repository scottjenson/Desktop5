// Window interaction: raycaster-based focus + drag over per-window meshes.

import * as THREE from 'three';
import {
  DESKTOP_W, DESKTOP_H, TITLEBAR_H, MENUBAR_H, DOCK_CLEARANCE, Z_STEP,
  SHRUNK_PX, SNAP_ZONE_STEP, MIN_SCALE, WARP_STRENGTH,
  SHAKE_MIN_TRAVEL, SHAKE_WINDOW_MS, SHAKE_COUNT,
  HIGHLIGHT_FADE_IN_MS, HIGHLIGHT_FADE_OUT_MS,
  MUSIC_COMPACT_SCALE, MUSIC_COMPACT_BTN_PX,
  EXPOSE_BOX_FRAC, EXPOSE_GAP_PX, EXPOSE_MAX_SCALE, EXPOSE_FILL,
} from './config.js';
// Stateless warp-curve math + edge/stash geometry (extracted — see js/warp.js).
import {
  getWindowScale, gridLocalScale, warpInverse, cursorToLogical,
  EDGE_ZONES, snapToEdge, stashColumn,
} from './warp.js';

// ── Main ──────────────────────────────────────────────────

export function initWindows({ gl, camera, windowMeshes, S, chromeSrc, menubarSrc, revealUniform, warpUniform, dragActiveUniform, dragBandUniform, invalidate }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const hit = new THREE.Vector3();

  const meshes = windowMeshes.map((w) => w.mesh);
  const infoOf = new Map(windowMeshes.map((w) => [w.mesh, w]));
  let drag = null;
  let textSel = null; // active word-processor text-selection drag (mutually exclusive with drag)

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

  // ── Word-processor text selection ─────────────────────────
  // Native selection can't be triggered by synthetic events (untrusted), so body
  // drags on the wp window drive the Selection API directly: anchor caret on
  // mousedown, setBaseAndExtent on mousemove. Chrome paints the highlight into the
  // window's texture, so it renders at ANY mesh scale — uv → local px is
  // scale-invariant. Cmd+C works on the result (real selection on real DOM).
  //
  // Map a window-local design-px point → client px on the live reparented DOM →
  // text caret. The LIVE root rect absorbs zoom/position, assuming Chrome hit-tests
  // the reparented DOM in gBCR space (verified by the [sel-probe] in main.js).
  // Returns null when the caret API can't see the DOM (probe failed) — callers
  // fall back to normal window behavior.
  function caretFromLocal(info, localX, localY) {
    if (!document.caretRangeFromPoint || !info.rootEl) return null;
    const r = info.rootEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = r.left + (localX / info.w) * r.width;
    let y = r.top + (localY / info.h) * r.height;

    // The reparented window DOMs all overlap in client space and occlude each other
    // for hit-testing ([sel-probe]: the wp was hittable only in the ~80px sliver not
    // covered by other windows). Lift every other reparented root (#gl children:
    // windows + chrome + menubar) out of hit-testing for this synchronous lookup —
    // pointer-events doesn't affect rendering, so no repaint.
    const blockers = [...gl.children].filter((c) => c !== info.rootEl && c.style);
    const prevPe = blockers.map((c) => c.style.pointerEvents);
    blockers.forEach((c) => { c.style.pointerEvents = 'none'; });

    // caretRangeFromPoint only sees points INSIDE the browser viewport, but the
    // window's layout box can extend below it ([sel-probe]: wp spans to client
    // y=1050 in a ~790px-tall viewport). Borrow the window's own internal scroll to
    // bring the target content up for the lookup; restored synchronously, before
    // any paint can observe it.
    const sc = info.scrollEl;
    const yLimit = window.innerHeight - 2;
    let scrollAdj = 0;
    if (y > yLimit && sc) {
      scrollAdj = Math.max(0, Math.min(y - yLimit, sc.scrollHeight - sc.clientHeight - sc.scrollTop));
      if (scrollAdj) { sc.scrollTop += scrollAdj; y -= scrollAdj; }
    }

    let range = null;
    try {
      range = document.caretRangeFromPoint(x, Math.min(y, yLimit));
    } finally {
      if (scrollAdj) sc.scrollTop -= scrollAdj;
      blockers.forEach((c, i) => { c.style.pointerEvents = prevPe[i]; });
    }
    if (!range || !info.rootEl.contains(range.startContainer)) return null;
    return range;
  }

  // Cursor → window-local design px via the window's z-plane (not intersectObject),
  // so a selection drag can extend PAST the mesh edges; clamped to the window.
  const _selPlaneNormal = new THREE.Vector3(0, 0, 1);
  function windowLocalFromEvent(e, info) {
    toNdc(e);
    raycaster.setFromCamera(ndc, camera);
    dragPlane.setFromNormalAndCoplanarPoint(_selPlaneNormal, info.mesh.position);
    if (!raycaster.ray.intersectPlane(dragPlane, hit)) return null;
    const s = info.mesh.scale.x || 1;
    const localX = (hit.x - info.mesh.position.x) / (s * S) + info.w / 2;
    const localY = info.h / 2 - (hit.y - info.mesh.position.y) / (s * S);
    return {
      x: Math.min(Math.max(localX, 0), info.w),
      y: Math.min(Math.max(localY, 0), info.h),
    };
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

    // Word-processor body drag = text selection (body drags on full-size windows
    // were previously unclaimed). Shift and icon-sized keep their window gestures;
    // a failed caret lookup falls through to normal behavior.
    if (info.id === 'wordprocessor' && !isShift && !isIconSized && localY > TITLEBAR_H) {
      const anchor = caretFromLocal(info, hits[0].uv.x * info.w, localY);
      if (anchor) {
        window.getSelection().setBaseAndExtent(
          anchor.startContainer, anchor.startOffset,
          anchor.startContainer, anchor.startOffset); // click = collapse to caret
        textSel = { info, anchor };
        info.canvas.requestPaint?.();
        e.preventDefault();
        return;
      }
    }

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
    // Text selection drag: extend to the caret under the cursor (clamped to the
    // window, so dragging past an edge selects to that edge).
    if (textSel) {
      const p = windowLocalFromEvent(e, textSel.info);
      if (p) {
        const focus = caretFromLocal(textSel.info, p.x, p.y);
        if (focus) {
          window.getSelection().setBaseAndExtent(
            textSel.anchor.startContainer, textSel.anchor.startOffset,
            focus.startContainer, focus.startOffset);
          textSel.info.canvas.requestPaint?.();
        }
      }
      return;
    }

    // Idle hover: text cursor over the wp body (the selection affordance).
    if (!drag) {
      toNdc(e);
      raycaster.setFromCamera(ndc, camera);
      const hover = raycaster.intersectObjects(meshes, false).filter((h) => h.object.visible)[0];
      const hInfo = hover && infoOf.get(hover.object);
      const overWpBody = hInfo?.id === 'wordprocessor'
        && (1 - hover.uv.y) * hInfo.h > TITLEBAR_H
        && hover.object.scale.x > Math.max(SHRUNK_PX / hInfo.w, MIN_SCALE) * 1.1;
      gl.style.cursor = overWpBody ? 'text' : '';
      return;
    }

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
    // One stash per grab: after a fire, drag.shook gates re-triggering until the
    // next mousedown (a repeat within the same grab is always a no-op anyway —
    // stashAll skips parked windows — but re-firing muddies logs and mental model).
    const shakeDx = cursorCx - drag.shakeLastCx;
    if (!drag.shook && Math.abs(shakeDx) >= SHAKE_MIN_TRAVEL) {
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
  // Parks every other full-size window into the two warp-derived columns on its side.
  // Assignment is by RECENCY: the stack is walked front-to-back, so the most recently
  // used windows claim the inner (larger) column until its height budget is spent and
  // the rest overflow to the outer column — the park is a legibility hierarchy, not
  // just storage. Still stateless (Learning #8): nothing is remembered or restored.
  const STASH_GAP = 10;

  // Fit a column's windows non-overlapping into the menubar↔dock band, each as close
  // to its current cy as possible: forward pass pushes overlaps down, backward pass
  // pulls the pile back up from the dock. If the column can't hold everyone at the
  // column scale (safety net — capacity math says it won't happen at 10 windows),
  // shrink the whole column to fit, keeping the total height solvable for both passes.
  function layoutColumn(items, colCx, colScale) {
    if (!items.length) return;
    const top = MENUBAR_H, bot = DESKTOP_H - DOCK_CLEARANCE;
    const gaps = STASH_GAP * (items.length - 1);
    const sumH = items.reduce((sum, it) => sum + it.w.h, 0);
    const s = Math.min(colScale, (bot - top - gaps) / sumH);

    items.sort((a, b) => a.cy - b.cy);
    let prevBottom = top - STASH_GAP;
    for (const it of items) {
      const half = (it.w.h * s) / 2;
      it.cy = Math.max(it.cy, prevBottom + STASH_GAP + half);
      prevBottom = it.cy + half;
    }
    let nextTop = bot + STASH_GAP;
    for (let i = items.length - 1; i >= 0; i--) {
      const half = (items[i].w.h * s) / 2;
      items[i].cy = Math.min(items[i].cy, nextTop - STASH_GAP - half);
      nextTop = items[i].cy - half;
    }

    for (const it of items) {
      const p = centerToWorld(colCx, it.cy);
      animateTo(it.w.mesh, p.x, p.y, s);
    }
  }

  function stashAll(excludeMesh) {
    const band = DESKTOP_H - DOCK_CLEARANCE - MENUBAR_H;
    const innerScale = stashColumn(true, true).scale; // same both sides
    const sides = {
      left:  { inner: [], outer: [], innerH: 0 },
      right: { inner: [], outer: [], innerH: 0 },
    };

    for (let i = stack.length - 1; i >= 0; i--) { // front-to-back = recency order
      const w = stack[i];
      if (w.mesh === excludeMesh || !w.mesh.visible) continue;
      if (w.mesh.scale.x < 0.95) continue;
      const cx = worldToCenter(w.mesh.position.x, 0).cx;
      const cy = DESKTOP_H / 2 - w.mesh.position.y / S;
      const side = sides[cx < DESKTOP_W / 2 ? 'left' : 'right'];
      const need = w.h * innerScale + (side.inner.length ? STASH_GAP : 0);
      if (side.innerH + need <= band) {
        side.inner.push({ w, cy });
        side.innerH += need;
      } else {
        side.outer.push({ w, cy });
      }
    }

    for (const isLeft of [true, false]) {
      const side = sides[isLeft ? 'left' : 'right'];
      const inner = stashColumn(isLeft, true);
      const outer = stashColumn(isLeft, false);
      layoutColumn(side.inner, inner.cx, inner.scale);
      layoutColumn(side.outer, outer.cx, outer.scale);
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
    textSel = null; // selection persists in the DOM; only the drag ends

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
        // Full-size → park in the inner stash column on the current side (a single
        // window has no crowding pressure, so it always gets the larger column).
        const snap = stashColumn(curCx < DESKTOP_W / 2, true);
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
