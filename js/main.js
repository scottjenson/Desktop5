// Scene setup: one static chrome plane + one textured mesh per window.
//
// Two kinds of canvas, deliberately separated:
//   • #gl                  — the visible WebGL output and the only event surface
//   • #sources .src        — hidden <canvas layoutsubtree> texture sources
// HTMLTexture's `onpaint` is a single slot per canvas, so each window needs its
// own source canvas to get an independent, live-updating texture.

import * as THREE from 'three';
import { DESKTOP_W, DESKTOP_H, FOV, CAMERA_Z, Z_STEP, MENUBAR_H, DOCK_CLEARANCE, GRID_CELL_PX, WARP_DEADZONE, WARP_POWER, WARP_STRENGTH, RENDER_SUPERSAMPLE, WINDOW_SUPERSAMPLE, GRID_LINE_CORE_PX, GRID_LINE_GLOW_PX, GRID_GLOW_STRENGTH, GRID_EDGE_FADE_START, GRID_EDGE_FADE_FLOOR, GRID_INTENSITY, HIGHLIGHT_GAIN, HIGHLIGHT_THICKNESS, MORPH_SEGMENTS_X } from './config.js';
import { initWindows } from './windows.js';

// ── CSS custom properties (derived from config.js) ────────
const r = document.documentElement.style;
r.setProperty('--menubar-h', MENUBAR_H + 'px');
r.setProperty('--menu-shift', DESKTOP_W * 0.25 + 'px');
r.setProperty('--snap-top', MENUBAR_H + 'px');
r.setProperty('--snap-height', (DESKTOP_H - MENUBAR_H - DOCK_CLEARANCE) + 'px');

// ── Renderer / scene / camera ─────────────────────────────
const gl = document.getElementById('gl');
// No MSAA (antialias): the buffer is already supersampled (see fitCanvas), the grid
// lines are analytically antialiased via fwidth(), and windows are axis-aligned quads
// — multisampling a multi-megapixel buffer costs bandwidth for no visible gain.
const renderer = new THREE.WebGLRenderer({ canvas: gl });
renderer.setSize(DESKTOP_W, DESKTOP_H, false); // logical size; buffer = this × pixelRatio (fitCanvas)
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

// Render-on-demand: interaction/animation code calls invalidate() whenever it mutates
// the scene (transforms, uniforms, visibility). Texture repaints are detected
// separately, in the render loop, by polling texture.version.
let needsRender = true;
const invalidate = () => { needsRender = true; };

const scene = new THREE.Scene();
scene.background = null; // shader plane handles the background

// Camera aspect is locked to the desktop ratio, so the texture is never stretched.
const camera = new THREE.PerspectiveCamera(FOV, DESKTOP_W / DESKTOP_H, 0.1, 100);
camera.position.z = CAMERA_Z;

// CSS-scale the canvas to fit the viewport (black bars top/bottom) — and size the
// drawing buffer to what is actually displayed, not a fixed DESKTOP × RENDER_SUPERSAMPLE.
// Buffer px = displayed CSS px × max(devicePixelRatio, RENDER_SUPERSAMPLE): a dpr-1
// projector still gets ≥2× supersampling on the dense grid flanks, while a retina
// laptop stops shading 4× the pixels it can display. Capped at DESKTOP × RENDER_SUPERSAMPLE
// (the old fixed buffer) so a huge/hi-dpi viewport can't push the cost back up.
function fitCanvas() {
  const s = Math.min(window.innerWidth / DESKTOP_W, window.innerHeight / DESKTOP_H);
  gl.style.width = DESKTOP_W * s + 'px';
  gl.style.height = DESKTOP_H * s + 'px';
  const ratio = Math.min(RENDER_SUPERSAMPLE, s * Math.max(devicePixelRatio, RENDER_SUPERSAMPLE));
  if (ratio !== renderer.getPixelRatio()) renderer.setPixelRatio(ratio); // calls setSize(…, false) internally — CSS untouched
  invalidate();
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
  uniform float u_warpStrength; // total spatial compression per flank (animates 0→max during boot)
  uniform float u_warpStrengthMax; // the warp's full value; u_warpStrength/this = warp progress 0..1
  uniform float u_coreWidth;    // crisp line core half-width (screen px)
  uniform float u_glowWidth;    // soft glow falloff radius (screen px)
  uniform float u_glowStrength; // glow halo brightness (0..1)
  uniform float u_edgeFadeStart;// |centerX| where the edge fade begins easing toward the floor
  uniform float u_edgeFadeFloor;// brightness the edge fade bottoms out at (>0 so grid stays visible)
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

    // Edge fade: ease line intensity DOWN TO u_edgeFadeFloor (not 0) toward the L/R edges,
    // so the compressed flanks dim but the grid stays visible all the way to the bezel.
    float fadeAmt = 1.0 - smoothstep(u_edgeFadeStart, 1.0, abs(centerX));
    float flooredFade = mix(u_edgeFadeFloor, 1.0, fadeAmt);
    // Tie the fade to the warp: at flat (warpProgress 0) the grid is uniform to the edges;
    // the vignette eases in IN LOCKSTEP with the warp boot (and any live warp change).
    float warpProgress = u_warpStrength / max(u_warpStrengthMax, 1e-5);
    float edgeFade = mix(1.0, flooredFade, warpProgress);
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
      u_warpStrengthMax: { value: WARP_STRENGTH },
      u_coreWidth:    { value: GRID_LINE_CORE_PX },
      u_glowWidth:    { value: GRID_LINE_GLOW_PX },
      u_glowStrength: { value: GRID_GLOW_STRENGTH },
      u_edgeFadeStart:{ value: GRID_EDGE_FADE_START },
      u_edgeFadeFloor:{ value: GRID_EDGE_FADE_FLOOR },
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
function morphMaterial(el, geomHalfW, geomHalfH) {
  const mat = new THREE.MeshBasicMaterial({ map: htmlTexture(el), transparent: true, alphaTest: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.u_halfPlaneW   = { value: planeW / 2 };
    shader.uniforms.u_warpDeadzone = { value: WARP_DEADZONE };
    shader.uniforms.u_warpPower    = { value: WARP_POWER };
    shader.uniforms.u_warpStrength = { value: WARP_STRENGTH };
    shader.uniforms.u_warpBlend    = { value: mat.userData.pendingWarpBlend ?? 0.0 };
    shader.uniforms.u_geomHalfW    = { value: geomHalfW }; // window half-size in world units
    shader.uniforms.u_geomHalfH    = { value: geomHalfH };
    // Shape variant, toggled by the "-" key (plans/morph-readability.md):
    // 0 faithful (curved) · 1 creased centered-Y (readable fold)
    shader.uniforms.u_morphMode    = { value: mat.userData.pendingMorphMode ?? 0.0 };

    shader.vertexShader = `
      uniform float u_halfPlaneW;
      uniform float u_warpDeadzone;
      uniform float u_warpPower;
      uniform float u_warpStrength;
      uniform float u_warpBlend;
      uniform float u_geomHalfW;
      uniform float u_geomHalfH;
      uniform float u_morphMode;
      varying vec2 v_phys;   // fragment's POST-warp (physical) world xy
      varying vec4 v_winExt; // window extent: (logical xwL, logical xwR, center world y, world height)
      // Fold description for the fragment's exact piecewise inverse (modes 1/3):
      varying vec4 v_foldW;  // logical  x of (left edge, left hinge, right hinge, right edge)
      varying vec4 v_foldX;  // physical x of the same four points
      varying vec4 v_foldS;  // grid localScale at the same four points

      // Same math as the original inline Newton block, factored into functions so
      // the shape variants can also solve the WINDOW EDGES (chord/rect modes need
      // the edge positions to straighten between grid-locked corners).
      float warpDerivAt(float xs) {
        float flankDist = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
        return u_warpPower * pow(flankDist, max(0.0, u_warpPower - 1.0)) * u_warpStrength / (1.0 - u_warpDeadzone);
      }
      float localScaleAt(float xs) { return 1.0 / (1.0 + warpDerivAt(xs)); }
      float newtonInverse(float xw) {
        float xs = xw; // initial guess; smooth monotonic f → sub-pixel in 4 iters
        for (int i = 0; i < 4; i++) {
          float flankDist = max(0.0, abs(xs) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
          float warp = sign(xs) * pow(flankDist, u_warpPower) * u_warpStrength;
          xs -= ((xs + warp) - xw) / (1.0 + warpDerivAt(xs));
        }
        return xs;
      }
    ` + shader.vertexShader;

    // Replace the standard projection with our warped one. <project_vertex> normally does:
    //   vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0); gl_Position = projectionMatrix * mvPosition;
    // We split modelView into model (to get world X for the warp) then view.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */`
        vec4 squashedWorld = modelMatrix * vec4(transformed, 1.0);
        float xw = squashedWorld.x / u_halfPlaneW;        // logical pos, -1..1

        // Window logical extent (modelMatrix origin = window center; [0][0]/[1][1]
        // = mesh scale — windows never rotate).
        float sclX = modelMatrix[0][0];
        float sclY = modelMatrix[1][1];
        float cxw  = modelMatrix[3][0];
        float xwL  = (cxw - u_geomHalfW * sclX) / u_halfPlaneW;
        float xwR  = (cxw + u_geomHalfW * sclX) / u_halfPlaneW;

        // FAITHFUL mapping (mode 0, the original): Newton-solve this vertex's
        // physical x; Y scales by the grid's localScale AT THIS VERTEX, so the
        // deeper edge foreshortens more → curved-edge trapezoid hugging the grid
        // lines, plus the accepted drift toward the screen equator.
        float xs = newtonInverse(xw);
        float localScale = localScaleAt(xs);

        // Both modes keep the window corners locked to the grid curve (xsL/xsR are
        // the faithful edge solutions). The crease placement is linear in LOGICAL x
        // per fold piece, so its Y-scale is linear in PHYSICAL x → straight edges.
        float xsL = newtonInverse(xwL);
        float xsR = newtonInverse(xwR);

        // Fold description: three x-pieces [edge | hinge]—[identity]—[hinge | edge],
        // creased at the dead-zone boundary. Hinges clamp to the window span, so
        // fully-in-flank degenerates to a plain chord and fully-in-center to
        // identity. Shared with the fragment shader via varyings so its per-pixel
        // inverse uses the SAME piecewise map.
        float hingeLw = clamp(-u_warpDeadzone, xwL, xwR);
        float hingeRw = clamp( u_warpDeadzone, xwL, xwR);
        float xsHL = newtonInverse(hingeLw);
        float xsHR = newtonInverse(hingeRw);
        v_foldW = vec4(xwL, hingeLw, hingeRw, xwR);
        v_foldX = vec4(xsL, xsHL, xsHR, xsR);
        v_foldS = vec4(localScaleAt(xsL), localScaleAt(xsHL), localScaleAt(xsHR), localScaleAt(xsR));

        float xsFinal; float yScaleSel; float yPivot = 0.0; // pivot 0 = screen equator
        if (u_morphMode < 0.5) {                 // 0 faithful — silk (curved edges)
          xsFinal = xs;
          yScaleSel = localScale;
        } else {
          // 1 creased centered-Y — orthogonal inside the dead zone, straight chord
          // over the flank portion only (gradual onset like faithful), Y converging
          // about the WINDOW centerline so text shear stays gentle and lines don't
          // fan (equator-pulled shear mangles fold text — plan: C findings).
          float foldScale;
          if (xw >= hingeRw) {
            float t   = (xw - hingeRw) / max(xwR - hingeRw, 1e-6);
            xsFinal   = mix(xsHR, xsR, t);
            foldScale = mix(v_foldS.z, v_foldS.w, t);
          } else if (xw <= hingeLw) {
            float t   = (hingeLw - xw) / max(hingeLw - xwL, 1e-6);
            xsFinal   = mix(xsHL, xsL, t);
            foldScale = mix(v_foldS.y, v_foldS.x, t);
          } else {
            xsFinal = xw;                        // dead zone: warp is identity here
            foldScale = 1.0;
          }
          yScaleSel = foldScale;
          yPivot = modelMatrix[3][1];            // window centerline, not equator
        }

        // Blend flat ↔ warped. Y scales about yPivot (pivot 0 reduces to the
        // original y *= mix(1, yScale, blend) — equator pull).
        squashedWorld.x = mix(xw, xsFinal, u_warpBlend) * u_halfPlaneW;
        squashedWorld.y = mix(squashedWorld.y, yPivot + (squashedWorld.y - yPivot) * yScaleSel, u_warpBlend);

        // Pass 1 (plans/morph-readability.md): per-pixel content-mapping inputs.
        // v_phys is the fragment's actual physical position (positions interpolate
        // exactly); v_winExt the window's logical extent.
        v_phys = squashedWorld.xy;
        v_winExt = vec4(xwL, xwR, modelMatrix[3][1], u_geomHalfH * 2.0 * sclY);

        vec4 mvPosition = viewMatrix * squashedWorld;
        gl_Position = projectionMatrix * mvPosition;
      `
    );

    // Fragment side of Pass 1: per-pixel inverse of the vertex warp. A fragment
    // knows its PHYSICAL x, so the logical coordinate is the closed-form FORWARD
    // warp f(xs) — no Newton iteration needed in this direction. This replaces the
    // sliver-interpolated UVs (content was grid-exact only at the 41 vertex
    // columns) with an exact mapping at every pixel: the 40 sampling seams vanish.
    shader.fragmentShader = `
      uniform float u_halfPlaneW;
      uniform float u_warpDeadzone;
      uniform float u_warpPower;
      uniform float u_warpStrength;
      uniform float u_warpBlend;
      uniform float u_morphMode;
      varying vec2 v_phys;
      varying vec4 v_winExt;
      varying vec4 v_foldW;
      varying vec4 v_foldX;
      varying vec4 v_foldS;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */`
        #ifdef USE_MAP
          float xs_f    = v_phys.x / u_halfPlaneW;
          float flank_f = max(0.0, abs(xs_f) - u_warpDeadzone) / (1.0 - u_warpDeadzone);
          float xw_f    = xs_f + sign(xs_f) * pow(flank_f, u_warpPower) * u_warpStrength;
          float deriv_f = u_warpPower * pow(flank_f, max(0.0, u_warpPower - 1.0)) * u_warpStrength / (1.0 - u_warpDeadzone);
          float ls_f    = 1.0 / (1.0 + deriv_f);
          float uW = (xw_f - v_winExt.x) / max(v_winExt.y - v_winExt.x, 1e-6);
          // Y: undo the vertex Y-pull at this fragment's x (same blend as the pull).
          float vW = (v_phys.y / mix(1.0, ls_f, u_warpBlend) - v_winExt.z) / max(v_winExt.w, 1e-6) + 0.5;

          // Per-pixel content mapping:
          //   0 faithful — smooth-warp inverse (uW/vW above).
          //   1 creased centered-Y — exact PIECEWISE inverse of the fold. Plain
          //     vMapUv is NOT enough: interpolating UVs across the converging
          //     (trapezoid) quads is only affine per triangle, and the fold
          //     concentrates the scale change into few segments ⇒ visible
          //     per-segment ripple that mangles text (tested; plan: C findings).
          vec2 contentUv;
          if (u_morphMode < 0.5) {
            contentUv = clamp(vec2(uW, vW), 0.0, 1.0);
          } else {
            float xs_p = v_phys.x / u_halfPlaneW;
            float xw_p; float s_p;
            if (xs_p >= v_foldX.z) {        // right fold piece
              float t = (xs_p - v_foldX.z) / max(v_foldX.w - v_foldX.z, 1e-6);
              xw_p = mix(v_foldW.z, v_foldW.w, t);
              s_p  = mix(v_foldS.z, v_foldS.w, t);
            } else if (xs_p <= v_foldX.y) { // left fold piece
              float t = (v_foldX.y - xs_p) / max(v_foldX.y - v_foldX.x, 1e-6);
              xw_p = mix(v_foldW.y, v_foldW.x, t);
              s_p  = mix(v_foldS.y, v_foldS.x, t);
            } else {                        // identity piece (dead zone)
              xw_p = xs_p;
              s_p  = 1.0;
            }
            float uP = (xw_p - v_winExt.x) / max(v_winExt.y - v_winExt.x, 1e-6);
            float yLog = v_winExt.z + (v_phys.y - v_winExt.z) / mix(1.0, s_p, u_warpBlend);
            float vP = (yLog - v_winExt.z) / max(v_winExt.w, 1e-6) + 0.5;
            contentUv = clamp(vec2(uP, vP), 0.0, 1.0);
          }
          vec2 morphUv = mix(vMapUv, contentUv, u_warpBlend);
          vec4 sampledDiffuseColor = texture2D( map, morphUv );
          diffuseColor *= sampledDiffuseColor;
        #endif
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

// Set a window mesh's morph SHAPE variant (0 faithful / 1 creased centered-Y).
// Same lazy-compile tolerance as setWarpBlend. Visible only while morphed.
const MORPH_MODE_NAMES = ['faithful (curved, hugs grid)', 'creased centered-Y (readable fold)'];
function setMorphMode(mesh, mode) {
  const mat = mesh.material;
  mat.userData.pendingMorphMode = mode;
  if (mat.userData.shader) mat.userData.shader.uniforms.u_morphMode.value = mode;
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
  const w = canvas.width;  // design size in DESKTOP px (index.html attributes);
  const h = canvas.height; // all mesh/clamp/registry math stays in this space

  // Supersample (Pass 1 "B", plans/morph-readability.md): enlarge the bitmap and
  // lay the DOM out at SS× via CSS zoom, so GPU minification during morph/park has
  // SS× the texels (three r184 hardcodes LINEAR filtering for HTMLTexture — no
  // mipmaps — so this is the only quality lever). At SS = 1 this is byte-identical
  // to the old path. Hit rects measured below come back in zoomed px → ÷SS.
  const SS = WINDOW_SUPERSAMPLE;
  canvas.width = w * SS;
  canvas.height = h * SS;

  // Pin both the source canvas and the window to exact pixels so the subtree
  // lays out at exactly the bitmap size (no %-of-ambiguous-containing-block
  // squashing while the canvas is parked off-screen). With zoom, the element's
  // rendered size is w×SS px — still exactly the bitmap size (Learning #1).
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.zoom = SS;

  // Subdivided 40×1 so vertices can bend along the grid warp (Window Morph demo).
  // At u_warpBlend = 0 (default) this renders pixel-identical to a flat quad.
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w * S, h * S, MORPH_SEGMENTS_X, 1),
    // alphaTest discards the transparent rounded corners so they don't write
    // depth and punch holes through windows stacked behind them.
    // morphMaterial adds the gated vertex warp (u_warpBlend = 0 → flat) and the
    // per-pixel content mapping (Pass 1); half-sizes feed v_winExt.
    morphMaterial(el, (w * S) / 2, (h * S) / 2)
  );
  // The morph vertex shader displaces geometry far from mesh.position: with the
  // logical-overscroll drag clamp, the position can sit OUTSIDE the frustum while
  // the warped window is visibly on-screen. Default bbox culling would blink the
  // window out mid-drag (~80% of the way to the bezel), so cull manually never.
  mesh.frustumCulled = false;

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

  // Every window: keep the .os-window root ref (survives reparenting — Learning #9).
  // Music uses it to toggle .compact; the word processor's text selection uses its
  // LIVE getBoundingClientRect to map raycaster uv → client px for caret lookup.
  const rootEl = el;

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
      // gBCR returns zoomed px; ÷SS keeps hit rects in design px (uv·info.w space).
      playHitRect = { x: (hr.left - cr.left) / SS, y: (hr.top - cr.top) / SS, w: hr.width / SS, h: hr.height / SS };
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
      return { el: fileEl, x: (hr.left - cr.left) / SS, y: (hr.top - cr.top) / SS, w: hr.width / SS, h: hr.height / SS };
    });
  }

  // Remember the original placement so the "4" key can reset the demo (see keydown below).
  const home = { x: mesh.position.x, y: mesh.position.y, z };

  windowMeshes.push({ mesh, w, h, id, canvas, scrollEl, playHitRect, playBtnEl, barEls, fileHits, rootEl, home });
  scene.add(mesh);
}));

// ── Clone pass ("d" key, windows.js) ──────────────────────
// One texture, two meshes: each window gets a hidden twin sharing its HTMLTexture,
// so the desktop can double to 10 windows (the Exposé-clutter contrast) with no
// second DOM, no extra rasterization. Plain MeshBasicMaterial — clones never morph.
// The spread shares every cached ref (scrollEl, hit rects, canvas) with the sibling,
// so scroll/click routing on a clone drives the same DOM and updates both meshes.
// cloneOffset (desktop px, +y down) staggers each twin so doubling reads as natural
// clutter rather than a mirror; applied from the sibling's live position on toggle.
const CLONE_OFFSETS = [[220, 140], [-260, 110], [240, -130], [-210, -150], [190, 160]];
windowMeshes.slice().forEach((orig, i) => {
  const mat = new THREE.MeshBasicMaterial({ map: orig.mesh.material.map, transparent: true, alphaTest: 0.5 });
  const twin = new THREE.Mesh(orig.mesh.geometry, mat);
  twin.frustumCulled = false;
  twin.visible = false;
  const off = CLONE_OFFSETS[i % CLONE_OFFSETS.length];
  twin.position.set(orig.home.x + off[0] * S, orig.home.y - off[1] * S, orig.home.z);
  windowMeshes.push({
    ...orig, id: orig.id + '-b', mesh: twin, cloneOf: orig, cloneOffset: off,
    home: { x: twin.position.x, y: twin.position.y, z: twin.position.z, visible: false },
  });
  scene.add(twin);
});

// ── Interaction ───────────────────────────────────────────
const windowsApi = initWindows({ gl, camera, windowMeshes, S, chromeSrc: document.getElementById('src-chrome'), menubarSrc, revealUniform: bgMesh.material.uniforms.u_reveal, warpUniform: bgMesh.material.uniforms.u_warpStrength, dragActiveUniform: bgMesh.material.uniforms.u_dragActive, dragBandUniform: bgMesh.material.uniforms.u_dragBand, invalidate });

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
  invalidate();
});

// "-" toggles the frontmost window's morph SHAPE variant (plans/morph-readability.md):
// faithful (curved) ↔ creased centered-Y (readable fold) — the two survivors of the
// shape exploration; both keep the corners locked to the grid curve. Only visible
// while the window is morphed ("0"). Mode persists per window.
window.addEventListener('keydown', (e) => {
  if (e.key !== '-' || !windowMeshes.length) return;
  const front = windowMeshes.reduce((a, b) => (b.mesh.position.z > a.mesh.position.z ? b : a));
  const mode = ((front.mesh.material.userData.pendingMorphMode ?? 0) + 1) % 2;
  setMorphMode(front.mesh, mode);
  console.log(`[morph] ${front.id}: mode ${mode} — ${MORPH_MODE_NAMES[mode]}`);
  invalidate();
});

// "?" toggles the demo-key help overlay — plain DOM layered above #gl (presenter
// chrome, not part of the scene: no texture, no invalidate). pointer-events:none in
// CSS keeps the demo interactive while it's up.
const helpOverlay = document.getElementById('help-overlay');
window.addEventListener('keydown', (e) => {
  if (e.key === '?' && !e.repeat && !e.metaKey && !e.ctrlKey) {
    helpOverlay.hidden = !helpOverlay.hidden;
  }
});

// "4" resets every window to its original position/scale/morph/visibility so the demo
// can be re-run without reloading. Touches windows ONLY — the menubar and grid lines
// (their own meshes/uniforms) are left exactly as they are.
window.addEventListener('keydown', (e) => {
  if (e.key !== '4') return;
  for (const win of windowMeshes) {
    win.mesh.position.set(win.home.x, win.home.y, win.home.z);
    win.mesh.scale.set(1, 1, 1);
    win.mesh.visible = win.home.visible ?? true; // clones reset to hidden — back to the original 5
    setWarpBlend(win.mesh, 0);
    setMorphMode(win.mesh, 0);
  }
  windowsApi.resetStack(); // restore stack order so the next click doesn't reshuffle z
  invalidate();
});

// ── Render loop — renders only when something changed ─────
// Two dirty signals: (a) needsRender, set by invalidate() from every transform /
// uniform / visibility mutation in main.js and windows.js; (b) HTMLTexture repaints —
// Chrome's onpaint sets texture.needsUpdate (a setter that bumps texture.version), so
// polling version catches every repaint, whether from an explicit requestPaint() or
// Chrome-initiated (scroll, CSS transitions, image loads). An idle desktop does zero
// GPU work, which also keeps a fanless laptop from thermally throttling the frames
// that matter during interaction.
const liveTextures = [chrome.material.map, menubarMesh.material.map, ...windowMeshes.map((w) => w.mesh.material.map)];
const texVersions = liveTextures.map(() => -1);

(function animate() {
  requestAnimationFrame(animate);
  let dirty = needsRender;
  for (let i = 0; i < liveTextures.length; i++) {
    const v = liveTextures[i].version;
    if (v !== texVersions[i]) { texVersions[i] = v; dirty = true; }
  }
  if (!dirty) return;
  needsRender = false;
  renderer.render(scene, camera);
})();
