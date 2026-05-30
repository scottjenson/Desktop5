# System Context & Architecture: 3D HTML-in-Canvas Window Manager

## 🤖 Agent Initialization Instructions
**To the Coding Agent (Claude):** Read this document fully before generating any code for this project. This document serves as the architectural blueprint for a 3D window manager prototype. 

You are tasked with building a web-based prototype that renders standard HTML/CSS User Interfaces (like application windows) inside a WebGL 3D environment, allowing for true spatial manipulation (Z-depth, X/Y rotation) without losing standard DOM interactivity.

---
## 🛠 Technology Stack & Constraints

* **Primary 3D Library:** Vanilla Three.js (Version `r184` or higher is **strictly required** for native HTML-in-Canvas support).
* **Frameworks:** **NONE**. Do not use React, Vue, or `@react-three/fiber` (R3F). Do not use `@react-three/drei`'s `<Html>` component. We are using Vanilla JavaScript to avoid abstraction layers blocking experimental DOM APIs.
* **Core Feature:** The new Chrome **HTML-in-Canvas API** utilizing the `layoutsubtree` attribute.
* **Styling:** Standard CSS (Flexbox, CSS variables, border-radius for rounded windows) applied directly to DOM nodes embedded within the canvas.

---

## ⚙️ Environment Prerequisites (Crucial Context)
The API this prototype relies on is highly experimental. The user testing your code will be running **Chrome Canary (Chromium 146+)** with the following flag enabled:
`chrome://flags/#canvas-draw-element`

You do not need to build fallbacks for older browsers. Assume the `layoutsubtree` attribute and the `paint` canvas event are fully functional.

---

## 🏗 Architectural Blueprint

### 1. The HTML Structure (`layoutsubtree`)
Instead of floating `<div>` elements over a canvas and trying to sync transforms, we put the HTML *inside* the canvas. 

```html
<!-- The layoutsubtree attribute is mandatory -->
<canvas id="desktop-canvas" layoutsubtree width="1920" height="1080">
    <!-- The actual UI that will be rendered as a texture -->
    <div id="window-manager">
        <div id="window-1" class="os-window">
            <header class="window-titlebar">App 1</header>
            <div class="window-content">
                <button>Interactive Button</button>
            </div>
        </div>
        <!-- Add more windows here -->
    </div>
</canvas>
```

### 2. Texture Mapping & The Event Loop
Three.js (`r184+`) introduced support for this API. Instead of passing a static image, we pass the DOM element to be rasterized by the browser's layout engine.

* **The Material Setup:** You will create a `THREE.PlaneGeometry`. The material will be a `THREE.MeshBasicMaterial` (or `MeshStandardMaterial` if lighting is requested).
* **The Texture:**
    Use Three.js's `HTMLTexture` class (or fallback to `CanvasTexture` if you need to manually handle the updates, but prefer `HTMLTexture` if available in the context of r184+).
* **The Update Trigger:** The browser fires a `paint` event on the canvas whenever the internal HTML changes (hover states, text changes, animations). 
    *If manually syncing:* Listen for `canvas.addEventListener('paint', ...)` and trigger `texture.needsUpdate = true`.

### 3. 3D Window Manipulation
Treat the HTML window exactly like a 3D mesh.
* **Focus/Depth:** When a window is clicked, animate its `mesh.position.z` to bring it closer to the camera.
* **Tilt/Rotation:** Apply subtle `mesh.rotation.x` and `mesh.rotation.y` based on mouse movement or spatial positioning to give a "spatial computing" / VisionOS feel.
* **Animations:** Use a library like `GSAP` (or write custom lerp functions in the requestAnimationFrame loop) for smooth 3D transitions. Do NOT use CSS transforms for 3D placement.

### 4. Interaction Routing (Raycasting)
Because the HTML lives inside the canvas, native cursor interaction *usually* works out of the box for flat projections. However, because we are rotating and manipulating the meshes in 3D:
* You must implement a `THREE.Raycaster`.
* You need to map the 3D intersect coordinates (U/V coordinates on the plane) back to 2D pixel coordinates.
* Use standard DOM APIs like `document.elementFromPoint()` (adjusted for the canvas scale/transform) to pass synthetic click/hover events to the underlying HTML if native hit-testing misaligns due to heavy 3D rotation.

---

## 🚨 Anti-Patterns (DO NOT DO THESE)

1.  **Do NOT use CSS3DRenderer:** We are rendering the HTML *into* the WebGL context as a texture, not overlaying DOM elements using matrix3d transforms.
2.  **Do NOT use React Three Fiber:** Keep the code pure Vanilla JS. R3F obscures the `paint` event and native DOM node injection required for this experimental feature.
3.  **Do NOT capture images using `html2canvas`:** The `layoutsubtree` API is native and performant. Do not use hacky third-party rasterization libraries. 
4.  **Do NOT forget `layoutsubtree`:** The canvas element will fail to render the child DOM nodes if this attribute is missing.

---

## 📝 Implementation Phases for the Agent

When instructed to build the prototype, follow these phases:
1.  **Scaffold:** Setup `index.html`, `style.css`, and `main.js`.
2.  **Scene:** Initialize the Three.js Scene, PerspectiveCamera, WebGLRenderer, and OrbitControls.
3.  **UI Construction:** Build the HTML/CSS for 2-3 sample windows (e.g., a calculator, a text document) and embed them inside the canvas tag.
4.  **Texture Binding:** Create the 3D planes, bind the HTML as textures, and wire up the `paint` event listener to ensure hover states and active states reflect on the 3D meshes.
5.  **Spatial Logic:** Add the GSAP animations or lerping logic to handle moving windows in the Z-space and rotating them along the Y-axis.