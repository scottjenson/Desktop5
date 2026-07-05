# Terraced Warp — zoom shelves instead of a smooth funnel

## Status: PROPOSED (2026-07-05). No code. Prototype next; nothing here is committed
design. Read alongside `plans/morph-readability.md` (the distortion diagnosis this
builds on) and `plans/grid.md` (the curve's current implementation sites).

## The problem this dissolves

Two desires collided (Scott, 2026-07-05):
1. **Parking capacity** — windows should zoom down *fast* off the plateau so lots of
   ~50% / ~25% windows park in the flanks.
2. **Morph readability** — the grid warp shouldn't distort a morphed window's
   content so much that morphed dragging is unusable.

With the current power curve these fight over one dial (`WARP_STRENGTH`), because a
power curve couples two different properties:

* Parking cares about the curve's **value**: is scale ≈0.55 available close to the
  plateau?
* Morph readability cares about the curve's **slope across one window's width**.
  `morph-readability.md` cause #2 is the killer: *differential* compression
  (aspect smearing), not miniaturization. "Text survives miniaturization far better
  than aspect-ratio smearing" — uniform 0.55 is readable; 0.99→0.31 across one
  window is not.

Measured today: a widest-case window parked at the inner stash column (cx 620 ± 212)
spans **scale 0.312 at its outer edge → 0.992 at its inner edge** — a 3× differential
across its own width. THAT is the unreadability, not the 0.62 average.

A monotone power curve can only reach low values by being steep somewhere windows
rest. Lowering `WARP_STRENGTH` weakens value and slope together — trading capacity
for readability forever. **The lateral fix: shape, not strength.**

## The idea

Make the compression profile **terraced**: flat shelves of constant scale joined by
short steep transitions, instead of a monotonically steepening cubic.

```
scale(x)  1.0 ────────────╮ plateau (dead zone, unchanged)
                          ╰─╮  transition A (~70 px)
          0.55              ╰──────────╮ SHELF 1  (~390 px) ← inner stash column
                                       ╰─╮  transition B (~100 px)
          0.22                           ╰────╮ SHELF 2 (~180 px) ← outer stash column
          0.15                                ╰──╮ final dip (~120 px) → bezel
                                                  bezel
```

**The central claim — why the illusion survives:** within a shelf the local scale is
constant, so the grid there is *orthogonal, just denser* — horizontals run straight
and parallel, verticals evenly spaced. A morphed window resting on a shelf is
therefore a plain **uniformly-miniaturized rectangle** that STILL hugs the grid
exactly. "Grid-faithful" and "undistorted" — the two things the current curve forces
apart — *coincide* on a shelf. The sacred silhouette costs nothing where windows
actually rest; the distortion budget is spent in the narrow transitions windows only
pass *through*.

Side benefits that fall out for free:
* The grid **visibly explains the parking architecture** — the shelves read as
  distinct line-density bands ("the desk has zoom zones"), a stronger demo story
  than a smooth gradient.
* `MIN_SCALE` floor removed — the curve bottoms at the dip target (~0.15) by design.
  `getWindowScale` and `gridLocalScale` collapse into ONE function (the split exists
  only because of the floor). The drag-rails "bunching" effect (grid.md finding #1)
  goes away with it — flag to Scott, he liked it.
* Final dip to ≈0.15 = icon-snap scale (110px / 640–760px windows ≈ 0.145–0.17):
  a plain drag to the bezel rests AT icon size, so the shift-snap no longer jumps,
  and music compact (`< 0.21`) triggers on plain edge drags again.
* Stash columns stop being hand-placed: **column x = shelf center, column scale =
  shelf scale, by definition.** The lateral-clearance derivation in config.js
  becomes unnecessary.

## Drag feel — continuous, but with detents (Scott asked; recording the answer)

No jumps: `f` is C², so a dragged window's size is a continuous function of
position — mid-transition it passes through every size in between. What changes is
the *rate*: constant size on shelves, all shrinking concentrated in the ~70–120 px
transitions. Subjectively: slide… quick squeeze… slide… quick squeeze — the zoom
zones read as detents/gear-changes under the hand instead of today's continuous
taper. The shelf never needed a discontinuity; it needs ZERO SLOPE where windows
rest (both edges of a resting window see the same scale). A flat (unmorphed) drag
stays rigid throughout — one uniform scale sampled at the window center, "a window
shrinking quickly" in transitions; only a MORPHED window physically bends while
straddling a transition (the Phase 2 crumple judgment).

## Worked example (left flank, desktop px; right mirrors)

Physical 0..860 (plateau boundary at 860 = |xn| 0.5, unchanged `WARP_DEADZONE`):

| Segment | Physical px | Scale | Notes |
|---|---|---|---|
| transition A | 860→790 (70) | 1.0→0.55 | steep: full onset in ~70 px |
| **shelf 1** | 790→400 (390) | 0.55 | holds typical window (640·0.55 = 352); widest (418) overhangs 28 px — mild edge distortion, acceptable |
| transition B | 400→300 (100) | 0.55→0.22 | |
| **shelf 2** | 300→120 (180) | 0.22 | widest window = 167 px ✓ |
| final dip | 120→0 (120) | 0.22→0.15 | drama + icon-scale landing; overlaps edge zone (0–200), where only icons live |

**Capacity check:** logical half-width = ∫ dx/scale = **3477 px → ratio 2.02×**,
vs the current cubic's 2.33×. The funnel loses ~13% of its anamorphic capacity, not
half — the long 0.22 shelf does the heavy lifting. (Halving `WARP_STRENGTH`, the
rejected alternative, would have dropped it to 1.67×.)

All segment positions/widths/scales are dials. Constraints when tuning:
* shelf width ≥ (window width you care about) × shelf scale, else the window
  overhangs into transitions and picks up edge distortion;
* shelf 1 must end ≤ plateau boundary minus transition A;
* sum of segments = flank width (860). Transitions can't be TOO narrow: all
  differential compression concentrates there — a window dragged *through* a 70 px
  1.0→0.55 transition will visibly crumple mid-flight (brief, but violent; faithful
  mode's "gradual onset" quality changes character). If it reads badly, widen
  transitions by shaving shelf 2 or the dip.

## Construction — define the scale profile, integrate for the warp

Invert today's derivation. The current code defines displacement
(`f(x) = x + flankDist^P · STR`) and *derives* scale from its slope. Instead define
**`g(x) = 1/scale(x)`** directly as piecewise-constant with smoothstep ramps, and
integrate:

* `g(t) = a + (b−a)·smoothstep(t)` on each transition; constant on shelves.
* Forward warp `f(x) = ∫₀ˣ g` — closed form (smoothstep integrates to a quartic
  polynomial per segment; ∫₀¹ smoothstep = ½, so each transition contributes
  `T·(a+b)/2` of logical width).
* Derivative for Newton = `g(x)` itself — free.
* `smoothstep` has zero slope at both ends ⇒ `g` is C¹ ⇒ **`f` is C²** — the same
  smoothness class `WARP_POWER = 3` was chosen for (no grid kinks; grid.md).
* Newton inverse (logical→physical) unchanged in form: smooth monotone `f`,
  4 iterations, per-segment quartic. Fragment closed-form forward mapping
  (morph-readability Pass 1) carries over verbatim — it just calls the new `f`.
* Boot morph ("2" key) & `u_warpBlend`: blend by scaling the *displacement*
  `f(x) − x` by the blend factor, exactly as `u_warpStrength` is animated today.

Representation: ~5 segments × (start x, width, scale). Small uniform arrays (or a
handful of scalar uniforms) for GLSL; a shared breakpoint table in config.js as the
single source of truth. `WARP_POWER`/`WARP_STRENGTH` retire (keep exports until all
readers are ported, then delete).

## Implementation sites (the curve lives in ~6 places, 2 languages)

| Site | What changes |
|---|---|
| `js/config.js` | breakpoint table (segment scales/widths) replaces POWER/STRENGTH; derive `STASH_INNER/OUTER_CX` = shelf centers; delete `MIN_SCALE` |
| `js/windows.js` | `getWindowScale` + `gridLocalScale` → one `g`-based function; `warpForward`/`warpInverse` → piecewise closed form; drag-shrink, drag band, stash columns inherit automatically |
| `js/main.js` grid shader | fragment warp of `gridX` → piecewise `f`; the shelf bands appear in the grid automatically |
| `js/main.js` morph vertex shader | Newton solver calls new `f`/`g` (GLSL twin of windows.js — factor ONE shared GLSL string if possible) |
| `js/main.js` morph fragment shader | closed-form forward `f` swap, same structure |
| `js/config.js` music | re-check `MUSIC_COMPACT_SCALE = 0.21`: dip bottoms at 0.15 < 0.21 ✓, shelf 2 = 0.22 > 0.21 ✓ — the pin still works, margins unchanged |

## Plan — phases, each independently judgeable

1. **Phase 0 — look test (grid only, ~1 hr).** Port ONLY the grid shader's warp to
   the terraced `f` and press "2". Judge: do the shelf bands read as intentional
   zoom zones or as a rendering artifact? Windows/morph still on the old curve —
   they will visibly disagree with the grid; don't drag, just look. Cheap kill
   switch: if the terraced grid is ugly, stop here and fall back (below).
2. **Phase 1 — window physics (~1 session).** Port `getWindowScale`/`warpForward`/
   `warpInverse`; delete the floor; derive stash columns from shelves; re-verify
   shake with 10 windows, edge snap, music compact.
3. **Phase 2 — morph shaders (~1 session).** Port Newton + fragment forward; drag a
   morphed window through a transition and judge the crumple; test both `-` modes
   parked on each shelf — THE payoff screenshot: readable morphed text at 0.55.
4. **Phase 3 — cleanup.** Retire dead dials, update CLAUDE.md (Learnings touching
   the curve: #8 columns, grid.md #185 bunching note), record verdicts here.

## Fallback if terraces disappoint

**Depth-driven `u_warpBlend`** (cheap, an afternoon): during morphed drags, ramp
blend 0→1 with flank depth — rigid near the plateau (where content is readable),
fully grid-hugging deep in the flank (where 1/9-scale content is unreadable anyway;
morph-readability.md accepts this). Reuses the existing per-window animated uniform.
Cost: a half-blended window mid-flank neither hugs the grid nor sits flat — brushes
the sacred-silhouette constraint; needs Scott's eyes. NOT tested; do not assume it
reads well.

Explicitly NOT on the table (tested & rejected, morph-readability.md): rigid-ink /
picture-frame decoupling of content from silhouette; equator-sheared creases.
