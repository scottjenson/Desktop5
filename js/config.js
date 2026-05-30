// Shared constants for the desktop prototype.

// Internal desktop resolution (ultrawide-ish). The WebGL canvas renders at this
// size and is CSS-scaled to fit the viewport, producing black bars top/bottom.
export const DESKTOP_W = 2560;
export const DESKTOP_H = 1080;

// Chrome dimensions (desktop px)
export const TITLEBAR_H     = 30; // draggable strip at top of each window
export const MENUBAR_H      = 26; // min margin when clamping a window
export const DOCK_CLEARANCE = 80; // keep windows above the dock

// Camera / depth
export const FOV      = 45;
export const CAMERA_Z = 6;
export const Z_STEP   = 0.01; // world-z gap between stacked / focused windows

// Dynamic drag-shrink: a central plateau stays full-size; a window shrinks
// toward the edges so it can be "placed back" in space (scale, not real z).
export const PLATEAU_FRAC = 0.5; // central fraction of desktop width kept full-size
export const SHRUNK_PX    = 110; // ~icon target width (px) for a window at the edge
