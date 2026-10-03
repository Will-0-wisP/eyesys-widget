/* =========================================================================
   PANEL WINDOW: glass folder explorer + settings
   ========================================================================= */
const api = window.eyesysAPI;
const { EYES } = window.EYE_MANIFEST;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const panelEl = $('panel');
const glassBg = $('glass-bg');
const pathEl = $('panel-path');
const titleEl = $('panel-title');
const folderPathReadout = $('folder-path-readout');
const viewSeg = $('view-seg');
const sortSelect = $('sort-select');
const sortDirSeg = $('sort-dir-seg');
const dragSeg = $('drag-seg');
const listEl = $('file-list');
const cpuReadout = $('cpu-readout');
const countReadout = $('count-readout');
const settingsRow = $('settings-row');
const sizeSlider = $('size-slider');
const sizeReadout = $('size-readout');
const spinSlider = $('spin-slider');
const spinReadout = $('spin-readout');
const opacitySlider = $('opacity-slider');
const opacityReadout = $('opacity-readout');
const opacityLabel = $('opacity-label');
const blurSlider = $('blur-slider');
const blurReadout = $('blur-readout');
const layerSeg = $('layer-seg');
const eyeGrid = $('eye-grid');
const resizeHandle = $('resize-handle');

const MAX_ROWS = 500;
const STAGGER_ROWS = 24;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const state = {
  cfg: { iconSize: 90, eye: 'itachi', layer: 'overlay', blur: 25, spinRpm: 5, eyeOpacity: 100,
         panelTitle: 'Folder Preview', view: 'list', sortBy: 'name', sortDir: 'asc', dragToCopy: true },
  dir: 'left',
  hasBackdrop: false,
  customEyes: [],
  resizing: false,
  titleEditing: false
};

/* ---------------------------------------------------------------- settings UI */
function svgToDataUri(text) {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
}

function eyeThumb(eye) {
  const src = eye.svg ? svgToDataUri(eye.svg) : `eyes/mangekyou/${eye.id}.svg`;
  return `<img alt="" draggable="false" src="${src}" />`;
}

function buildEyeGrid() {
  eyeGrid.innerHTML = '';
  [...EYES, ...state.customEyes].forEach((eye) => {
    const b = document.createElement('button');
    b.className = 'eye-choice' + (state.cfg.eye === eye.id ? ' selected' : '');
    b.title = eye.name;
    b.innerHTML = eyeThumb(eye);
    b.addEventListener('click', () => api.saveConfig({ eye: eye.id }));
    eyeGrid.appendChild(b);
  });
}

function applyBlur() {
  const px = state.cfg.blur;
  document.documentElement.style.setProperty('--glass-blur', px + 'px');
  blurSlider.value = px;
  blurReadout.textContent = px ? px + 'px' : 'off';
  // no snapshot, or blur set to 0 -> plain translucent glass over the live desktop
  panelEl.classList.toggle('has-glass', px > 0 && state.hasBackdrop);
}

function applyCfg(cfg) {
  const eyeChanged = cfg.eye !== state.cfg.eye;
  Object.assign(state.cfg, cfg);
  sizeSlider.value = state.cfg.iconSize;
  sizeReadout.textContent = state.cfg.iconSize + 'px';
  layerSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layer === state.cfg.layer));
  spinSlider.value = state.cfg.spinRpm;
  spinReadout.textContent = state.cfg.spinRpm ? state.cfg.spinRpm + ' rpm' : 'still';
  opacitySlider.value = state.cfg.eyeOpacity;
  opacityReadout.textContent = state.cfg.eyeOpacity + '%';
  const overlay = state.cfg.layer === 'overlay';   // opacity only makes sense in overlay mode
  opacitySlider.disabled = !overlay;
  opacityLabel.classList.toggle('dim', !overlay);
  applyBlur();
  if (!state.titleEditing) titleEl.value = state.cfg.panelTitle; // don't clobber an in-progress edit

  listEl.classList.toggle('grid', state.cfg.view === 'grid');
  viewSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.cfg.view));
  sortSelect.value = state.cfg.sortBy;
  sortDirSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.dir === state.cfg.sortDir));
  dragSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.drag === 'on') === state.cfg.dragToCopy));

  if (eyeChanged) buildEyeGrid();
}

viewSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) api.saveConfig({ view: b.dataset.view }); // pure CSS reflow, no re-fetch needed
});

async function applySortChange(partial) {
  await api.saveConfig(partial);
  await refreshFolder(); // sort order is computed on the main side, so re-fetch to see it
}
sortSelect.addEventListener('change', () => applySortChange({ sortBy: sortSelect.value }));
sortDirSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) applySortChange({ sortDir: b.dataset.dir });
});

dragSeg.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  await api.saveConfig({ dragToCopy: b.dataset.drag === 'on' });
  await refreshFolder(); // rebuilds rows so their draggable attribute reflects the new setting
});

function commitTitle() {
  const clean = titleEl.value.trim().slice(0, 60) || 'Folder Preview';
  titleEl.value = clean;
  if (clean !== state.cfg.panelTitle) api.saveConfig({ panelTitle: clean });
}
titleEl.addEventListener('focus', () => { state.titleEditing = true; titleEl.select(); });
titleEl.addEventListener('blur', () => { state.titleEditing = false; commitTitle(); });
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') titleEl.blur();
  else if (e.key === 'Escape') { titleEl.value = state.cfg.panelTitle; titleEl.blur(); }
});



async function loadCustomEyes() {
  try { state.customEyes = await api.listCustomEyes(); } catch (e) { state.customEyes = []; }
  buildEyeGrid();
}

layerSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) api.saveConfig({ layer: b.dataset.layer });
});
sizeSlider.addEventListener('input', () => api.saveConfig({ iconSize: Number(sizeSlider.value) }));
spinSlider.addEventListener('input', () => api.saveConfig({ spinRpm: Number(spinSlider.value) }));
opacitySlider.addEventListener('input', () => api.saveConfig({ eyeOpacity: Number(opacitySlider.value) }));
blurSlider.addEventListener('input', () => {
  state.cfg.blur = Number(blurSlider.value);
  applyBlur();                                   // live: the snapshot is re-blurred instantly
  api.saveConfig({ blur: state.cfg.blur });
});

$('gear-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsRow.classList.toggle('hidden');
});
$('close-btn').addEventListener('click', () => api.closePanel());
$('choose-folder-btn').addEventListener('click', async () => {
  const folder = await api.chooseFolder();
  if (folder) await refreshFolder();
});
$('open-eyes-btn').addEventListener('click', () => api.openEyesFolder());

/* ---------------------------------------------------------------- folder list */
function glyphFor(isDirectory) {
  if (isDirectory) {
    return `<svg viewBox="0 0 24 24"><path fill="#e8b84b" d="M3 5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5Z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24"><path fill="#cfd6e0" d="M6 2h8l6 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path fill="#9aa4b2" d="M14 2v6h6z"/></svg>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function refreshFolder() {
  const res = await api.listDir();
  pathEl.textContent = res.path;
  pathEl.title = res.path;
  folderPathReadout.textContent = res.path;
  folderPathReadout.title = res.path;
  listEl.innerHTML = '';
  countReadout.textContent = '';

  if (!res.ok) {
    listEl.innerHTML = `<li class="empty-state">Couldn't read this folder:<br>${escapeHtml(res.error || 'unknown error')}</li>`;
    return;
  }
  if (!res.items.length) {
    listEl.innerHTML = `<li class="empty-state">This folder is empty.</li>`;
    return;
  }

  const frag = document.createDocumentFragment();
  res.items.slice(0, MAX_ROWS).forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'file-item' + (i < STAGGER_ROWS ? ' stagger' : '');
    li.style.setProperty('--i', i);
    li.innerHTML = `<span class="glyph">${glyphFor(item.isDirectory)}</span><span class="item-name">${escapeHtml(item.name)}</span>`;
    li.addEventListener('click', () => api.openPath(item.fullPath));

    // Native OS drag: drop a listed item onto Explorer or any other app to copy it there.
    // Windows performs the actual copy itself; we only need to start the drag correctly.
    li.draggable = state.cfg.dragToCopy;
    li.addEventListener('dragstart', (e) => {
      if (!state.cfg.dragToCopy) { e.preventDefault(); return; }
      e.preventDefault(); // required so Electron takes over with a native OS drag instead of a web one
      api.startDrag(item.fullPath);
    });

    frag.appendChild(li);
  });
  listEl.appendChild(frag);
  countReadout.textContent = res.items.length > MAX_ROWS
    ? `first ${MAX_ROWS} of ${res.items.length} items`
    : `${res.items.length} item${res.items.length === 1 ? '' : 's'}`;
}

/* ---------------------------------------------------------------- open / close / layout */
function applyLayout(d) {
  state.dir = d.dir;
  stage.className = 'dir-' + d.dir;
  panelEl.style.width = d.width + 'px';
  panelEl.style.height = d.height + 'px';
  // scale/slide out from the point nearest the icon
  panelEl.style.transformOrigin = `${clamp(d.origin.x, 0, d.width)}px ${clamp(d.origin.y, 0, d.height)}px`;
}

function applyBackdrop(backdrop) {
  if (!backdrop) { state.hasBackdrop = false; applyBlur(); return; }
  // -1.5px = the panel's border width, so the snapshot lines up exactly with the screen
  Object.assign(glassBg.style, {
    left: backdrop.x - 1.5 + 'px',
    top: backdrop.y - 1.5 + 'px',
    width: backdrop.w + 'px',
    height: backdrop.h + 'px',
    backgroundImage: `url("${backdrop.url}")`
  });
  state.hasBackdrop = true;
  applyBlur();
}

api.onPanelOpen((d) => {
  panelEl.classList.remove('visible');
  panelEl.classList.remove('has-glass'); // clear yesterday's screenshot; today's arrives via panel-backdrop
  settingsRow.classList.add('hidden');
  applyLayout(d);
  applyCfg(d.cfg);
  cpuReadout.textContent = `CPU: ${d.cpu}%`;

  // The panel shows on plain glass right away; a blurred backdrop of what's behind it
  // (see panel-backdrop below) and the folder contents both fill in a moment later so
  // opening never waits on a screenshot or a directory read.
  api.panelReady();
  refreshFolder();
  loadCustomEyes();
});

api.onPanelBackdrop((backdrop) => applyBackdrop(backdrop));

api.onPanelShown(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => panelEl.classList.add('visible')));
});

api.onPanelHide(() => panelEl.classList.remove('visible'));

// the icon moved, or the panel was resized from settings, while open: reposition/resize;
// a screenshot no longer lines up after a resize, so drop back to plain glass until the
// next open takes a fresh one
api.onPanelLayout((d) => {
  applyLayout(d);
  state.hasBackdrop = false;
  applyBlur();
});

api.onConfig((cfg) => applyCfg(cfg));
api.onOpenSettings(() => settingsRow.classList.remove('hidden'));
api.onCpu((cpu) => { cpuReadout.textContent = `CPU: ${cpu}%`; });

// clicking the transparent margin around the panel also dismisses it
stage.addEventListener('mousedown', (e) => {
  if (state.resizing || panelEl.contains(e.target)) return;
  api.closePanel();
});

/* ---------------------------------------------------------------- drag-to-resize */
const SIGN = { left: { x: -1, y: 1 }, right: { x: 1, y: 1 }, down: { x: 1, y: 1 }, up: { x: 1, y: -1 } };
let rz = null;
let rzFrame = 0;

resizeHandle.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  resizeHandle.setPointerCapture(e.pointerId);
  state.resizing = true;
  panelEl.classList.add('dragging-resize');
  const limits = await api.resizeStart();
  if (!limits) { state.resizing = false; return; }
  const rect = panelEl.getBoundingClientRect();
  rz = { sx: e.screenX, sy: e.screenY, w: rect.width, h: rect.height, cw: rect.width, ch: rect.height, ...limits };
});

resizeHandle.addEventListener('pointermove', (e) => {
  if (!rz) return;
  const s = SIGN[state.dir];
  rz.cw = clamp(rz.w + s.x * (e.screenX - rz.sx), rz.minW, rz.maxW);
  rz.ch = clamp(rz.h + s.y * (e.screenY - rz.sy), rz.minH, rz.maxH);
  if (!rzFrame) {
    rzFrame = requestAnimationFrame(() => {
      rzFrame = 0;
      if (!rz) return;
      panelEl.style.width = rz.cw + 'px';
      panelEl.style.height = rz.ch + 'px';
    });
  }
});

function endResize() {
  panelEl.classList.remove('dragging-resize');
  if (!rz) { state.resizing = false; return; }
  cancelAnimationFrame(rzFrame);
  rzFrame = 0;
  panelEl.style.width = rz.cw + 'px';
  panelEl.style.height = rz.ch + 'px';
  api.resizeEnd(rz.cw, rz.ch);
  rz = null;
  setTimeout(() => { state.resizing = false; }, 50);
}
resizeHandle.addEventListener('pointerup', endResize);
resizeHandle.addEventListener('pointercancel', endResize);

/* ---------------------------------------------------------------- startup */
(async function init() {
  applyCfg(await api.getConfig());
  buildEyeGrid();
})();
