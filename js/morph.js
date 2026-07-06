// Window Morph (demo "0"/"-" keys): the material factory + shader that bend a
// window's vertices onto the background grid's warped columns, and the per-mesh
// setters the demo keys drive. Extracted from main.js — this file is dominated by
// the GLSL; nothing here touches the scene, only the material it returns.

import * as THREE from 'three';
import { WARP_DEADZONE, WARP_POWER, WARP_STRENGTH } from './config.js';

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
export function morphMaterial(map, geomHalfW, geomHalfH, halfPlaneW) {
  const mat = new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.u_halfPlaneW   = { value: halfPlaneW };
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
export function setWarpBlend(mesh, value) {
  const mat = mesh.material;
  mat.userData.pendingWarpBlend = value;
  if (mat.userData.shader) mat.userData.shader.uniforms.u_warpBlend.value = value;
}

// Set a window mesh's morph SHAPE variant (0 faithful / 1 creased centered-Y).
// Same lazy-compile tolerance as setWarpBlend. Visible only while morphed.
export const MORPH_MODE_NAMES = ['faithful (curved, hugs grid)', 'creased centered-Y (readable fold)'];
export function setMorphMode(mesh, mode) {
  const mat = mesh.material;
  mat.userData.pendingMorphMode = mode;
  if (mat.userData.shader) mat.userData.shader.uniforms.u_morphMode.value = mode;
}
