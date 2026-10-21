/**
 * Satellite Spotter's look, shared by every element it draws (the globe, the
 * street view, the cards and the sidebar panel): design tokens, reusable CSS,
 * icons and the faint star field behind the globe.
 *
 * Each element includes the CSS it needs in its own shadow root; the tokens
 * are custom properties on :host, so an element nested in another's shadow
 * tree (the street view inside the globe) inherits the same values.
 */

/** Design tokens. Colours are the ISS Tracker's dark glass palette. */
export const TOKENS_CSS = `
:host {
  --sat-glass: linear-gradient(160deg, rgba(15,23,42,.86), rgba(15,23,42,.66));
  --sat-glass-solid: rgba(11,18,34,.96);
  --sat-edge: rgba(148,163,184,.24);
  --sat-rule: rgba(148,163,184,.16);
  --sat-ink: #f8fafc; --sat-ink-2: #cbd5e1; --sat-ink-3: #94a3b8;
  --sat-sky: #7dd3fc; --sat-gold: #fcd34d; --sat-violet: #a78bfa; --sat-preview: #f0abfc;
  --sat-live: #22c55e;
  --sat-lit: #fde68a; --sat-shadow: #c4b5fd;
  --sat-cloud-clear: #86efac; --sat-cloud-partly: #fde68a; --sat-cloud-cloudy: #fda4af;
  --sat-warn: #fdba74;
  --sat-kind-station: #fcd34d; --sat-kind-satellite: #e0f2fe; --sat-kind-starlink: #7dd3fc;
  --sat-kind-rocket: #fb923c; --sat-kind-debris: #94a3b8;
  --sat-panel-shadow: 0 12px 32px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.06);
  --sat-font: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
  font-family: var(--sat-font);
}`;

/** Small utilities every element wants. */
export const UTIL_CSS = `
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }`;

/** The frosted panel every overlay sits on (class "glass"). */
export const GLASS_CSS = `
.glass { background: var(--sat-glass); border: 1px solid var(--sat-edge); border-radius: 16px;
  box-shadow: var(--sat-panel-shadow);
  backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2); }`;

/**
 * Buttons: "btn" is a pill with an icon and a label ("btn gold" for the main
 * action, "btn pink" for the simulation), "ibtn" a round icon-only button.
 * Long and short labels: <span class="long">, <span class="short">.
 */
export const BUTTON_CSS = `
.btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; color: #e0f2fe;
  background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.45); border-radius: 999px; padding: 6px 12px 6px 10px;
  cursor: pointer; white-space: nowrap; text-decoration: none; -webkit-tap-highlight-color: transparent;
  transition: background .15s, border-color .15s, transform .15s, opacity .15s; }
.btn:hover { background: rgba(56,189,248,.26); border-color: rgba(125,211,252,.8); }
.btn:active { transform: scale(.97); }
.btn[disabled] { opacity: .45; cursor: default; transform: none; }
.btn svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
.btn.gold { color: #fef3c7; background: rgba(252,211,77,.14); border-color: rgba(252,211,77,.5); }
.btn.gold:hover { background: rgba(252,211,77,.26); border-color: rgba(253,230,138,.9); }
.btn.pink { color: #fae8ff; background: rgba(240,171,252,.13); border-color: rgba(240,171,252,.5); }
.btn.pink:hover { background: rgba(240,171,252,.24); border-color: rgba(245,208,254,.9); }
.btn.quiet { color: var(--sat-ink-2); background: rgba(148,163,184,.1); border-color: rgba(148,163,184,.3); }
.btn.quiet:hover { color: var(--sat-ink); background: rgba(148,163,184,.2); border-color: rgba(203,213,225,.6); }
.ibtn { display: inline-grid; place-items: center; width: 32px; height: 32px; flex: none; padding: 0; border-radius: 50%;
  border: 1px solid transparent; background: rgba(148,163,184,.14); color: var(--sat-ink); cursor: pointer;
  -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s, transform .15s; }
.ibtn:hover { background: rgba(148,163,184,.28); }
.ibtn:active { transform: scale(.94); }
.ibtn svg { width: 18px; height: 18px; fill: currentColor; }
.ibtn[aria-pressed="true"] { background: var(--sat-sky); color: #0f172a; }`;

/**
 * Outlined pills for short states: "chip" (current colour), "chip gold"
 * (bright), "chip warn" (daylight), "chip dim" (secondary facts).
 */
export const CHIP_CSS = `
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; letter-spacing: .06em; line-height: 1.5;
  padding: 1px 8px; border-radius: 999px; text-transform: uppercase; border: 1px solid currentColor; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.chip svg { width: 11px; height: 11px; fill: currentColor; }
.chip.gold { color: var(--sat-gold); background: rgba(252,211,77,.1); }
.chip.warn { color: var(--sat-warn); }
.chip.dim { color: var(--sat-ink-3); }
.chip.sky { color: var(--sat-sky); }`;

/** Keyboard focus rings (never for mouse clicks). */
export const FOCUS_CSS = `
:is(button, a, input, select, [tabindex]):focus { outline: none; }
:is(button, a, input, select, [tabindex]):focus-visible { outline: 2px solid var(--sat-sky); outline-offset: 2px; }`;

/**
 * Keyframes shared by the views. Elements decide when to use them, inside
 * @media (prefers-reduced-motion: no-preference).
 */
export const MOTION_CSS = `
@keyframes sat-ping { 0% { box-shadow: 0 0 0 0 rgba(var(--ping, 34,197,94),.55); } 80%, 100% { box-shadow: 0 0 0 8px rgba(var(--ping, 34,197,94),0); } }
@keyframes sat-spin { to { transform: rotate(360deg); } }
@keyframes sat-glow { 50% { box-shadow: 0 0 0 1px rgba(252,211,77,.55), 0 0 18px rgba(252,211,77,.28); } }
@keyframes sat-rise { from { opacity: 0; transform: translateY(6px); } }`;

// Material Design Icons paths (MDI 7.4.47, Apache 2.0), plus three drawn here
// for this integration: train, debris and the satellite cloud toggle.
export const ICONS = {
  home: "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
  follow:
    "M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M3.05,13H1V11H3.05C3.5,6.83 6.83,3.5 11,3.05V1H13V3.05C17.17,3.5 20.5,6.83 20.95,11H23V13H20.95C20.5,17.17 17.17,20.5 13,20.95V23H11V20.95C6.83,20.5 3.5,17.17 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z",
  chase:
    "M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z",
  globe:
    "M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
  layers:
    "M12,16L19.36,10.27L21,9L12,2L3,9L4.63,10.27M12,18.54L4.62,12.81L3,14.07L12,21.07L21,14.07L19.37,12.8L12,18.54Z",
  play: "M8,5.14V19.14L19,12.14L8,5.14Z",
  pause: "M14,19H18V5H14M6,19H10V5H6V19Z",
  eye: "M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z",
  // mdi:city-variant-outline
  street:
    "M15,23H13V21H15V23M19,21H17V23H19V21M15,17H13V19H15V17M7,21H5V23H7V21M7,17H5V19H7V17M19,17H17V19H19V17M15,13H13V15H15V13M19,13H17V15H19V13M21,9A2,2 0 0,1 23,11V23H21V11H11V23H9V15H3V23H1V15A2,2 0 0,1 3,13H9V11A2,2 0 0,1 11,9V7A2,2 0 0,1 13,5H15V1H17V5H19A2,2 0 0,1 21,7V9M19,9V7H13V9H19Z",
  close:
    "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  fullscreen: "M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z",
  fullscreen_exit: "M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z",
  // mdi:satellite-variant
  satellite:
    "M11.62,1L17.28,6.67L15.16,8.79L13.04,6.67L11.62,8.09L13.95,10.41L12.79,11.58L13.24,12.04C14.17,11.61 15.31,11.77 16.07,12.54L12.54,16.07C11.77,15.31 11.61,14.17 12.04,13.24L11.58,12.79L10.41,13.95L8.09,11.62L6.67,13.04L8.79,15.16L6.67,17.28L1,11.62L3.14,9.5L5.26,11.62L6.67,10.21L3.84,7.38C3.06,6.6 3.06,5.33 3.84,4.55L4.55,3.84C5.33,3.06 6.6,3.06 7.38,3.84L10.21,6.67L11.62,5.26L9.5,3.14L11.62,1M18,14A4,4 0 0,1 14,18V16A2,2 0 0,0 16,14H18M22,14A8,8 0 0,1 14,22V20A6,6 0 0,0 20,14H22Z",
  // mdi:space-station
  station:
    "M15.5 19V21H13.73C13.39 21.6 12.74 22 12 22C11.26 22 10.61 21.6 10.27 21H8.5V19H10.27C10.44 18.7 10.7 18.44 11 18.27V17H10C9.45 17 9 16.55 9 16V13H6V17C6 17.55 5.55 18 5 18H3C2.45 18 2 17.55 2 17V8C2 7.45 2.45 7 3 7H5C5.55 7 6 7.45 6 8V11H9V8C9 7.45 9.45 7 10 7H11V6H10C9.45 6 9 5.55 9 5V4C9 3.45 9.45 3 10 3H14C14.55 3 15 3.45 15 4V5C15 5.55 14.55 6 14 6H13V7H14C14.55 7 15 7.45 15 8V11H18V8C18 7.45 18.45 7 19 7H21C21.55 7 22 7.45 22 8V17C22 17.55 21.55 18 21 18H19C18.45 18 18 17.55 18 17V13H15V16C15 16.55 14.55 17 14 17H13V18.27C13.3 18.44 13.56 18.7 13.73 19H15.5M3 16V17H5V16H3M3 14V15H5V14H3M3 12V13H5V12H3M3 10V11H5V10H3M3 8V9H5V8H3M19 16V17H21V16H19M19 14V15H21V14H19M19 12V13H21V12H19M19 10V11H21V10H19M19 8V9H21V8H19Z",
  telescope:
    "M21.9,8.9L20.2,9.9L16.2,3L17.9,2L21.9,8.9M9.8,7.9L12.8,13.1L18.9,9.6L15.9,4.4L9.8,7.9M11.4,12.7L9.4,9.2L5.1,11.7L7.1,15.2L11.4,12.7M2.1,14.6L3.1,16.3L5.7,14.8L4.7,13.1L2.1,14.6M12.1,14L11.8,13.6L7.5,16.1L7.8,16.5C8,16.8 8.3,17.1 8.6,17.3L7,22H9L10.4,17.7H10.5L12,22H14L12.1,16.4C12.6,15.7 12.6,14.8 12.1,14Z",
  rocket:
    "M20 22L16.14 20.45C16.84 18.92 17.34 17.34 17.65 15.73L20 22M7.86 20.45L4 22L6.35 15.73C6.66 17.34 7.16 18.92 7.86 20.45M12 2C12 2 17 4 17 12C17 15.1 16.25 17.75 15.33 19.83C15 20.55 14.29 21 13.5 21H10.5C9.71 21 9 20.55 8.67 19.83C7.76 17.75 7 15.1 7 12C7 4 12 2 12 2M12 12C13.1 12 14 11.1 14 10C14 8.9 13.1 8 12 8C10.9 8 10 8.9 10 10C10 11.1 10.9 12 12 12Z",
  // Drawn here: four tumbling shards.
  debris: "M3.5,14.5L8.2,11.2L10.4,15.6L5.9,19.1Z M12.6,4.6L17.4,3.4L16.1,8.3Z M13.8,13.2L19.4,11.8L20.6,16.4L15.6,18.8Z M8.6,5.8L11,7.1L9.7,9.6L7.6,8.4Z",
  // Drawn here: a string of satellites following each other.
  train:
    "M2.8,19a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0M7.1,15a1.9,1.9 0 1,0 3.8,0a1.9,1.9 0 1,0 -3.8,0M11.4,11a1.6,1.6 0 1,0 3.2,0a1.6,1.6 0 1,0 -3.2,0M15.65,7a1.35,1.35 0 1,0 2.7,0a1.35,1.35 0 1,0 -2.7,0M19.4,3.5a1.1,1.1 0 1,0 2.2,0a1.1,1.1 0 1,0 -2.2,0",
  // Drawn here: scattered dots of different sizes (every satellite at once).
  cloud_of_satellites:
    "M4,7a2,2 0 1,0 4,0a2,2 0 1,0 -4,0M13,4.5a1.5,1.5 0 1,0 3,0a1.5,1.5 0 1,0 -3,0M17.5,11a2.5,2.5 0 1,0 5,0a2.5,2.5 0 1,0 -5,0M9,12.5a1.5,1.5 0 1,0 3,0a1.5,1.5 0 1,0 -3,0M2.5,16a1.5,1.5 0 1,0 3,0a1.5,1.5 0 1,0 -3,0M13,19a2,2 0 1,0 4,0a2,2 0 1,0 -4,0M7.6,21a1,1 0 1,0 2,0a1,1 0 1,0 -2,0M19.4,4.4a1,1 0 1,0 2,0a1,1 0 1,0 -2,0",
  // mdi:cloud
  cloud:
    "M6.5 20Q4.22 20 2.61 18.43 1 16.85 1 14.58 1 12.63 2.17 11.1 3.35 9.57 5.25 9.15 5.88 6.85 7.75 5.43 9.63 4 12 4 14.93 4 16.96 6.04 19 8.07 19 11 20.73 11.2 21.86 12.5 23 13.78 23 15.5 23 17.38 21.69 18.69 20.38 20 18.5 20Z",
  star: "M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z",
  // mdi:weather-sunset-up / -down
  sunrise:
    "M3,12H7A5,5 0 0,1 12,7A5,5 0 0,1 17,12H21A1,1 0 0,1 22,13A1,1 0 0,1 21,14H3A1,1 0 0,1 2,13A1,1 0 0,1 3,12M15,12A3,3 0 0,0 12,9A3,3 0 0,0 9,12H15M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M12.71,16.3L15.82,19.41C16.21,19.8 16.21,20.43 15.82,20.82C15.43,21.21 14.8,21.21 14.41,20.82L12,18.41L9.59,20.82C9.2,21.21 8.57,21.21 8.18,20.82C7.79,20.43 7.79,19.8 8.18,19.41L11.29,16.3C11.5,16.1 11.74,16 12,16C12.26,16 12.5,16.1 12.71,16.3Z",
  sunset:
    "M3,12H7A5,5 0 0,1 12,7A5,5 0 0,1 17,12H21A1,1 0 0,1 22,13A1,1 0 0,1 21,14H3A1,1 0 0,1 2,13A1,1 0 0,1 3,12M15,12A3,3 0 0,0 12,9A3,3 0 0,0 9,12H15M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M12.71,20.71L15.82,17.6C16.21,17.21 16.21,16.57 15.82,16.18C15.43,15.79 14.8,15.79 14.41,16.18L12,18.59L9.59,16.18C9.2,15.79 8.57,15.79 8.18,16.18C7.79,16.57 7.79,17.21 8.18,17.6L11.29,20.71C11.5,20.9 11.74,21 12,21C12.26,21 12.5,20.9 12.71,20.71Z",
  // mdi:compass-outline
  compass:
    "M7,17L10.2,10.2L17,7L13.8,13.8L7,17M12,11.1A0.9,0.9 0 0,0 11.1,12A0.9,0.9 0 0,0 12,12.9A0.9,0.9 0 0,0 12.9,12A0.9,0.9 0 0,0 12,11.1M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z",
  // mdi:information-outline
  info: "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z",
  // mdi:crosshairs
  crosshair:
    "M3.05,13H1V11H3.05C3.5,6.83 6.83,3.5 11,3.05V1H13V3.05C17.17,3.5 20.5,6.83 20.95,11H23V13H20.95C20.5,17.17 17.17,20.5 13,20.95V23H11V20.95C6.83,20.5 3.5,17.17 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z",
  chevron_down: "M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z",
  chevron_up: "M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z",
  chevron_left: "M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z",
  chevron_right: "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
  // mdi:repeat
  loop: "M17,17H7V14L3,18L7,22V19H19V13H17M7,7H17V10L21,6L17,2V5H5V11H7V7Z",
  replay:
    "M12,5V1L7,6L12,11V7A6,6 0 0,1 18,13A6,6 0 0,1 12,19A6,6 0 0,1 6,13H4A8,8 0 0,0 12,21A8,8 0 0,0 20,13A8,8 0 0,0 12,5Z",
  // mdi:fast-forward
  forward: "M13,6V18L21.5,12M4,18L12.5,12L4,6V18Z",
  // mdi:format-list-bulleted
  list: "M7,5H21V7H7V5M7,13V11H21V13H7M4,4.5A1.5,1.5 0 0,1 5.5,6A1.5,1.5 0 0,1 4,7.5A1.5,1.5 0 0,1 2.5,6A1.5,1.5 0 0,1 4,4.5M4,10.5A1.5,1.5 0 0,1 5.5,12A1.5,1.5 0 0,1 4,13.5A1.5,1.5 0 0,1 2.5,12A1.5,1.5 0 0,1 4,10.5M7,19V17H21V19H7M4,16.5A1.5,1.5 0 0,1 5.5,18A1.5,1.5 0 0,1 4,19.5A1.5,1.5 0 0,1 2.5,18A1.5,1.5 0 0,1 4,16.5Z",
  // mdi:open-in-new
  open: "M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z",
  // mdi:clock-outline
  clock:
    "M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z",
  // mdi:weather-sunny
  sun: "M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z",
  // mdi:filter-variant
  filter: "M6,13H18V11H6M3,6V8H21V6M10,18H14V16H10V18Z",
};

/** The icon for a kind of object (sat-format's kinds), or for a Starlink train. */
export function kindIcon(kind, { train = false } = {}) {
  if (train) return "train";
  switch (kind) {
    case "iss":
    case "tiangong":
      return "station";
    case "hubble":
      return "telescope";
    case "rocket":
      return "rocket";
    case "debris":
      return "debris";
    default:
      return "satellite";
  }
}

const escapeAttr = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * An icon as inline SVG in the current text colour. Decorative (hidden from
 * screen readers) unless it has a title, which also becomes its label.
 */
export function svgIcon(key, { title } = {}) {
  const path = ICONS[key] ?? "";
  if (title) {
    const t = escapeAttr(title);
    return `<svg viewBox="0 0 24 24" role="img" aria-label="${t}"><title>${t}</title><path d="${path}"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

let starsUrl;
/**
 * A faint, fixed star field as a CSS url() (a 512-px tile), drawn once per
 * page; purely decorative. A software canvas: the image is read back once,
 * which would stall a GPU canvas.
 */
export function starField() {
  if (starsUrl) return starsUrl;
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let seed = 25544;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 300; i++) {
    const r = rnd() < 0.07 ? 1.1 : 0.55;
    ctx.fillStyle = `rgba(${rnd() < 0.2 ? "200,220,255" : "255,255,255"},${0.2 + rnd() * 0.65})`;
    ctx.beginPath();
    ctx.arc(rnd() * 512, rnd() * 512, r, 0, 2 * Math.PI);
    ctx.fill();
  }
  starsUrl = `url(${c.toDataURL()})`;
  return starsUrl;
}
