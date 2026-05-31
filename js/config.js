// Shared constants for the desktop prototype.

// Internal desktop resolution (ultrawide-ish). The WebGL canvas renders at this
// size and is CSS-scaled to fit the viewport, producing black bars top/bottom.
export const DESKTOP_W = 3440;
export const DESKTOP_H = 1440;

// Chrome dimensions (desktop px)
export const TITLEBAR_H     = 30; // draggable strip at top of each window
export const MENUBAR_H      = 39; // min margin when clamping a window
export const DOCK_CLEARANCE = 80; // keep windows above the dock

// Camera / depth
export const FOV      = 45;
export const CAMERA_Z = 6;
export const Z_STEP   = 0.01; // world-z gap between stacked / focused windows

// Dynamic drag-shrink: a central plateau stays full-size; a window shrinks
// toward the edges so it can be "placed back" in space (scale, not real z).
export const PLATEAU_FRAC    = 0.5;  // central fraction used for zone layout & snap positions
export const SHRINK_FRAC     = 0.25; // central fraction that stays full-size during drag (steeper curve)
export const SHRUNK_PX       = 110;  // ~icon target width (px) for a window at the edge
export const SNAP_ZONE_STEP  = 100;  // px of horizontal movement to advance one snap zone
export const MID_SCALE       = 0.5;  // scale for mid-zone parked windows (zones 1 and 4)
