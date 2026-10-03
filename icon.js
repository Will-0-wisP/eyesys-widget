/* =========================================================================
   ICON WINDOW
   CPU 0-15% simple | 16-40% double | 41-70% triple | 71-100% selected eye
   - the eye turns slowly all the time (speed = setting)
   - changing eye: spin up very fast + red closes in from the edge, swap under
     the red, red opens from the centre outward, spin eases back to idle speed
   ========================================================================= */
const api = window.eyesysAPI;
const { BASIC, EYES } = window.EYE_MANIFEST;

const $ = (id) => document.getElementById(id);
const iconEl = $('icon');
const idleEl = $('eye-idle');
const clickEl = $('eye-click');
const veil = $('veil');
const layers = [$('eyeA'), $('eyeB')];

const ICON_MIN = 48;
const ICON_MAX = 160;
const BOOST_RPM = 240;              // "very fast" during a transition (4 turns per second)
const TIER_EYES = ['simple', 'double', 'triple'];
const BOUNDS = [15, 40, 70];        // tier boundaries
const HYST = 4;                     // % below a boundary before dropping a tier (stops flip-flopping)
const VEIL_IN_MS = 420;
const VEIL_OUT_MS = 560;

const state = {
  cpu: 0,
  tier: 0,
  panelOpen: false,
  spinning: false,
  eyeId: null,
  lastClosedAt: 0,
  cfg: { iconSize: 90, eye: 'itachi', layer: 'overlay', spinRpm: 5, eyeOpacity: 100 },
  onDesktop: true, // whether the foreground is the bare desktop (vs. an app) -- overlay mode only
  customEyes: []
};

/* ---------------------------------------------------------------- easing */
const easeIn = (p) => p * p;
const easeOut = (p) => 1 - (1 - p) * (1 - p);
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/* ---------------------------------------------------------------- continuous spin */
// one infinite animation (runs on the compositor, nearly free); we only change its playbackRate
const spinAnim = idleEl.animate(
  [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
  { duration: 1000, iterations: Infinity, easing: 'linear' }
);
const rpmToRate = (rpm) => rpm / 60; // duration is 1 s per turn, so rate = turns per second
spinAnim.playbackRate = rpmToRate(state.cfg.spinRpm);

let rampToken = 0;
function rampSpin(toRate, ms, ease) {
  const token = ++rampToken;
  const from = spinAnim.playbackRate;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      if (token !== rampToken) return resolve(); // a newer ramp took over
      const p = Math.min(1, (now - t0) / ms);
      spinAnim.playbackRate = from + (toRate - from) * ease(p);
      if (p < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/* ---------------------------------------------------------------- eyes */
function svgToDataUri(text) {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
}

// everything is shown through <img>, so an SVG can never run scripts
function eyeSrc(id) {
  if (BASIC[id]) return BASIC[id];
  const custom = state.customEyes.find((e) => e.id === id);
  if (custom) return svgToDataUri(custom.svg);
  const known = EYES.find((e) => e.id === id) || EYES[0];
  return `eyes/mangekyou/${known.id}.svg`;
}

function updateTier(cpu) {
  let t = state.tier;
  while (t < 3 && cpu > BOUNDS[t]) t++;
  while (t > 0 && cpu <= BOUNDS[t - 1] - HYST) t--;
  state.tier = t;
}

const eyeForTier = (t) => (t < 3 ? TIER_EYES[t] : state.cfg.eye);

function preloadImage(src) {
  const im = new Image();
  im.src = src;
  return im.decode().catch(() => {});
}

let front = -1;
async function showEye(id) {
  const next = layers[front === 0 ? 1 : 0];
  next.src = eyeSrc(id);
  try { await next.decode(); } catch (e) { /* show anyway */ }
  next.classList.add('on');
  if (front >= 0) layers[front].classList.remove('on');
  front = layers.indexOf(next);
}

/* ---------------------------------------------------------------- red wave */
function animateVeil(closing) {
  const from = closing ? '100%' : '-16%';
  const to = closing ? '-16%' : '100%';
  const a = veil.animate(
    [{ '--hole': from }, { '--hole': to }],
    {
      duration: closing ? VEIL_IN_MS : VEIL_OUT_MS,
      easing: closing ? 'cubic-bezier(0.55, 0, 0.9, 0.6)' : 'cubic-bezier(0.1, 0.6, 0.3, 1)',
      fill: 'forwards'
    }
  );
  return a.finished.then(() => {
    veil.style.setProperty('--hole', to); // keep the end state, drop the finished animation
    a.cancel();
  }).catch(() => {});
}

/* ---------------------------------------------------------------- eye transition */
let wantedEye = null;
let transitioning = false;

function requestEye(id) {
  wantedEye = id;
  if (state.eyeId === null) {        // very first paint: no effect
    state.eyeId = id;
    showEye(id);
    return;
  }
  if (!transitioning && id !== state.eyeId) runTransition();
}

async function runTransition() {
  transitioning = true;
  try {
    while (wantedEye !== state.eyeId) {
      let target = wantedEye;
      let ready = preloadImage(eyeSrc(target));

      rampSpin(rpmToRate(BOOST_RPM), 240, easeIn);      // spin up very fast
      await animateVeil(true);                          // red closes in: edge -> centre

      if (wantedEye !== target) {                       // changed our mind while covered
        target = wantedEye;
        ready = preloadImage(eyeSrc(target));
      }
      await ready;
      await showEye(target);                            // swap while fully covered
      state.eyeId = target;

      rampSpin(rpmToRate(state.cfg.spinRpm), 900, easeOut); // ease back to idle speed
      await animateVeil(false);                         // red opens: centre -> edge
    }
  } finally {
    transitioning = false;
  }
}

/* ---------------------------------------------------------------- settings: size, spin, opacity */
function setIconSize(px) {
  const size = Math.max(ICON_MIN, Math.min(ICON_MAX, Math.round(px)));
  state.cfg.iconSize = size;
  document.documentElement.style.setProperty('--icon-size', size + 'px');
  return size;
}

function setIdleRpm(rpm) {
  state.cfg.spinRpm = rpm;
  if (!transitioning) rampSpin(rpmToRate(rpm), 500, easeInOut); // during a transition the ramp-out uses the new value
}

// Opacity only ever applies in overlay mode, and even then only while the icon is actually
// sitting over another app's window -- full strength over the bare desktop, and always full
// strength in "Desktop only" mode regardless of the slider.
function applyOpacity() {
  const dimmed = state.cfg.layer === 'overlay' && !state.onDesktop;
  const v = dimmed ? state.cfg.eyeOpacity / 100 : 1;
  iconEl.style.setProperty('--eye-opacity', String(v));
}

// Ctrl + scroll over the icon resizes it
iconEl.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  api.saveConfig({ iconSize: setIconSize(state.cfg.iconSize + (e.deltaY < 0 ? 6 : -6)) });
}, { passive: false });

/* ---------------------------------------------------------------- drag to move */
let drag = null;
let justDragged = false;

iconEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    api.dragStart();
  }
  api.dragMove(dx, dy);
});

window.addEventListener('mouseup', () => {
  if (drag && drag.moved) {
    api.dragEnd();
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
  }
  drag = null;
});

/* ---------------------------------------------------------------- click: spin, then open */
function clickSpin() {
  return clickEl.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 300, easing: 'ease-in-out' }
  ).finished;
}

iconEl.addEventListener('click', async () => {
  if (justDragged || state.spinning) return;
  // the mousedown of this very click already made the panel lose focus and close: treat as "toggle off"
  if (Date.now() - state.lastClosedAt < 350) return;
  if (state.panelOpen) { api.closePanel(); return; }

  state.spinning = true;
  api.preparePanel();                   // main loads the panel + starts the backdrop screenshot right away
  const opened = await api.openPanel();  // the window itself appears first...

  // ...then the click-spin flourish and the eye's own transition (fast spin + red wave) play together
  const spinDone = clickSpin().catch(() => {});
  if (opened) {
    state.panelOpen = true;
    iconEl.classList.add('open');
    requestEye(state.cfg.eye);
  } else {
    updateTier(state.cpu);
    requestEye(eyeForTier(state.tier));
  }
  await spinDone;
  state.spinning = false;
});

// Right-click: a small menu (Settings / Exit), same as most desktop widgets.
iconEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.showContextMenu();
});

// Opening the panel from the right-click menu bypasses the click handler above entirely, so it
// announces itself here too; the guard keeps this a no-op when the click handler already did it.
api.onPanelOpened(() => {
  if (state.panelOpen) return;
  state.panelOpen = true;
  iconEl.classList.add('open');
  requestEye(state.cfg.eye);
});

/* ---------------------------------------------------------------- messages from main */
api.onCpu((cpu) => {
  state.cpu = cpu;
  if (state.panelOpen || state.spinning) return;
  updateTier(cpu);
  requestEye(eyeForTier(state.tier));
});

api.onPanelClosed(() => {
  state.panelOpen = false;
  state.lastClosedAt = Date.now();
  iconEl.classList.remove('open');
  updateTier(state.cpu);
  requestEye(eyeForTier(state.tier)); // back to live CPU graphics
});

async function loadCustomEyes() {
  try { state.customEyes = await api.listCustomEyes(); } catch (e) { state.customEyes = []; }
}

api.onDesktopState((onDesktop) => {
  state.onDesktop = onDesktop;
  applyOpacity();
});

api.onConfig(async (cfg) => {
  const prev = Object.assign({}, state.cfg);
  Object.assign(state.cfg, { eye: cfg.eye, layer: cfg.layer, spinRpm: cfg.spinRpm, eyeOpacity: cfg.eyeOpacity });
  if (state.cfg.layer !== 'overlay') state.onDesktop = true; // no polling outside overlay mode; always full opacity
  setIconSize(cfg.iconSize);
  applyOpacity();
  if (cfg.spinRpm !== prev.spinRpm) setIdleRpm(cfg.spinRpm);
  if (cfg.eye !== prev.eye) {
    if (cfg.eye.startsWith('custom:')) await loadCustomEyes();
    requestEye(state.panelOpen ? cfg.eye : eyeForTier(state.tier)); // live preview while picking
  }
});

(async function init() {
  const cfg = await api.getConfig();
  Object.assign(state.cfg, {
    eye: cfg.eye || state.cfg.eye,
    layer: cfg.layer || state.cfg.layer,
    spinRpm: Number.isFinite(cfg.spinRpm) ? cfg.spinRpm : state.cfg.spinRpm,
    eyeOpacity: Number.isFinite(cfg.eyeOpacity) ? cfg.eyeOpacity : state.cfg.eyeOpacity
  });
  if (state.cfg.layer !== 'overlay') state.onDesktop = true; // no polling outside overlay mode
  setIconSize(cfg.iconSize || 90);
  applyOpacity();
  spinAnim.playbackRate = rpmToRate(state.cfg.spinRpm);
  await loadCustomEyes();
  state.cpu = await api.getCpu();
  updateTier(state.cpu);
  requestEye(eyeForTier(state.tier));
})();
