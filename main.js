const { app, BrowserWindow, ipcMain, shell, dialog, screen, desktopCapturer, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const { clamp, inflate, computeLayout, anchoredRect, maxSizes } = require('./layout');

if (!app.requestSingleInstanceLock()) app.exit(0); // only one widget at a time

/* ------------------------------------------------------------------ constants */
const PAD = 20;   // transparent padding around the icon inside its window (glow room)
const M = 24;     // transparent margin around the panel inside its window (shadow room)
const GAP = 10;   // space between icon and panel
const EDGE = 8;   // keep the panel this far from screen edges
const ICON_MIN = 48;
const ICON_MAX = 160;
const PANEL_MIN = { w: 260, h: 220 };
const PANEL_CAP = { w: 520, h: 620 };

/* ------------------------------------------------------------------ config */
const CONFIG_PATH = path.join(app.getPath('userData'), 'eyesys-config.json');
const EYES_DIR = path.join(app.getPath('userData'), 'eyes');

const DEFAULT_CONFIG = {
  watchFolder: app.getPath('home'),
  panelWidth: 380,
  panelHeight: 460,
  posX: null,
  posY: null,
  iconSize: 90,
  eye: 'itachi',     // eye used at 71-100% CPU and while the panel is open
  layer: 'overlay',  // 'overlay' = above every app, 'desktop' = only on the desktop
  blur: 25,          // glass blur in px (0 = off)
  spinRpm: 5,          // idle spin speed of the eye in turns per minute (0 = still)
  eyeOpacity: 100,     // eye opacity in %, only used in overlay mode, only over an app (not the desktop)
  panelTitle: 'Folder Preview',
  view: 'list',        // 'list' or 'grid'
  sortBy: 'name',       // 'name' | 'modified' | 'size' | 'type'
  sortDir: 'asc',       // 'asc' | 'desc'
  dragToCopy: true      // drag a listed item out onto any folder/app to copy it there
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function sanitize(p) {
  const out = {};
  if (typeof p.watchFolder === 'string' && p.watchFolder) out.watchFolder = p.watchFolder;
  if (isNum(p.panelWidth)) out.panelWidth = clamp(Math.round(p.panelWidth), PANEL_MIN.w, PANEL_CAP.w);
  if (isNum(p.panelHeight)) out.panelHeight = clamp(Math.round(p.panelHeight), PANEL_MIN.h, PANEL_CAP.h);
  if (isNum(p.iconSize)) out.iconSize = clamp(Math.round(p.iconSize), ICON_MIN, ICON_MAX);
  if (typeof p.eye === 'string' && p.eye.length < 200) out.eye = p.eye;
  if (p.layer === 'overlay' || p.layer === 'desktop') out.layer = p.layer;
  if (isNum(p.blur)) out.blur = clamp(Math.round(p.blur), 0, 50);
  if (isNum(p.spinRpm)) out.spinRpm = clamp(Math.round(p.spinRpm), 0, 60);
  if (isNum(p.eyeOpacity)) out.eyeOpacity = clamp(Math.round(p.eyeOpacity), 20, 100);
  if (typeof p.panelTitle === 'string') out.panelTitle = p.panelTitle.trim().slice(0, 60) || 'Folder Preview';
  if (p.view === 'list' || p.view === 'grid') out.view = p.view;
  if (['name', 'modified', 'size', 'type'].includes(p.sortBy)) out.sortBy = p.sortBy;
  if (p.sortDir === 'asc' || p.sortDir === 'desc') out.sortDir = p.sortDir;
  if (typeof p.dragToCopy === 'boolean') out.dragToCopy = p.dragToCopy;
  if (isNum(p.posX)) out.posX = Math.round(p.posX);
  if (isNum(p.posY)) out.posY = Math.round(p.posY);
  return out;
}

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))));
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

let config = loadConfig();
let saveTimer = null;

function flushConfig() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('config save failed', e); }
}
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushConfig, 300);
}

/* ------------------------------------------------------------------ state + helpers */
let iconWin = null;
let panelWin = null;
let panelLoaded = null;
let capturePromise = null;
let suppressBlur = false;
let lastCpu = 0;

const state = {
  panelVisible: false,
  opening: false,
  dir: 'left',
  panelRect: null,
  wa: null,
  resize: null,
  hideTimer: null,
  readyResolve: null
};

const alive = (w) => w && !w.isDestroyed();
const send = (w, channel, ...args) => { if (alive(w)) w.webContents.send(channel, ...args); };
const broadcast = (channel, ...args) => { send(iconWin, channel, ...args); send(panelWin, channel, ...args); };
const iconWinSize = () => config.iconSize + 2 * PAD;

function windowOptions(extra) {
  return Object.assign({
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // keeps animations smooth even when the widget is unfocused
    }
  }, process.platform === 'win32' ? { type: 'toolbar' } : {}, extra);
}

function positionIsVisible(x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return cx >= w.x && cx <= w.x + w.width && cy >= w.y && cy <= w.y + w.height;
  });
}

/* ------------------------------------------------------------------ desktop-only layer (Windows) */
// Electron can't push a window to the very bottom of the z-order, so a tiny
// long-lived PowerShell helper calls SetWindowPos(HWND_BOTTOM) when asked.
let psProc = null;
let fgQueue = []; // pending resolvers for outstanding "F" (foreground window) queries, oldest first

function ensureZHelper() {
  if (process.platform !== 'win32' || psProc) return;
  // One tiny long-lived PowerShell process handles two things Electron can't do on its own:
  //   "B <hwnd>"  -> push that window to the bottom of the z-order (used by Desktop-only mode)
  //   "F"         -> reply with the class name of the current foreground window (used to tell
  //                  whether the icon is sitting over the bare desktop or over an app, for opacity)
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hAfter, int X, int Y, int cx, int cy, uint flags); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);'",
    'Add-Type -Namespace Native -Name Win -MemberDefinition $sig',
    'while ($true) {',
    '  $l = [Console]::In.ReadLine()',
    '  if ($l -eq $null) { break }',
    "  if ($l.StartsWith('B ')) {",
    '    $h = $l.Substring(2)',
    '    [void][Native.Win]::SetWindowPos([IntPtr][int64]$h, [IntPtr]1, 0, 0, 0, 0, 0x0013)',
    "  } elseif ($l -eq 'F') {",
    '    $h = [Native.Win]::GetForegroundWindow()',
    '    $sb = New-Object System.Text.StringBuilder 256',
    '    [void][Native.Win]::GetClassName($h, $sb, 256)',
    '    [Console]::Out.WriteLine($sb.ToString())',
    '  }',
    '}'
  ].join('\n');
  try {
    psProc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    readline.createInterface({ input: psProc.stdout }).on('line', (line) => {
      const resolve = fgQueue.shift();
      if (resolve) resolve(line.trim());
    });
    psProc.on('exit', () => { psProc = null; fgQueue.splice(0).forEach((r) => r(null)); });
    psProc.on('error', () => { psProc = null; fgQueue.splice(0).forEach((r) => r(null)); });
    psProc.stdin.on('error', () => {});
  } catch (e) {
    psProc = null;
  }
}

function sendToBottom(win) {
  if (!alive(win) || process.platform !== 'win32') return;
  ensureZHelper();
  if (!psProc) return;
  try {
    const h = win.getNativeWindowHandle();
    const hwnd = h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0));
    psProc.stdin.write('B ' + String(hwnd) + '\n');
  } catch (e) { /* ignore */ }
}

// Resolves with the foreground window's class name, or null if unavailable (non-Windows,
// PowerShell blocked by policy, etc). Requests are answered in the order they were sent.
function queryForegroundClass() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  ensureZHelper();
  if (!psProc) return Promise.resolve(null);
  return new Promise((resolve) => {
    fgQueue.push(resolve);
    try { psProc.stdin.write('F\n'); } catch (e) { fgQueue.pop(); resolve(null); }
  });
}

// "Progman"/"WorkerW" are the desktop itself; anything else in the foreground (including the
// taskbar or Explorer) counts as "an app" for the purpose of the eye-opacity setting.
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);
let onDesktop = true;
let desktopPollTimer = null;

async function pollDesktopState() {
  const cls = await queryForegroundClass();
  // If the helper is unavailable we can't tell what's in front, so default to full opacity
  // (the safer failure mode) rather than dimming the icon for no visible reason.
  const next = cls === null ? true : DESKTOP_CLASSES.has(cls);
  if (next !== onDesktop) {
    onDesktop = next;
    send(iconWin, 'desktop-state', onDesktop);
  }
}

function startDesktopWatch() {
  clearInterval(desktopPollTimer);
  desktopPollTimer = null;
  if (config.layer !== 'overlay') {
    if (!onDesktop) { onDesktop = true; send(iconWin, 'desktop-state', true); }
    return; // opacity is always 100% outside overlay mode; no need to poll
  }
  pollDesktopState();
  desktopPollTimer = setInterval(pollDesktopState, 700);
}

function applyLayer() {
  const overlay = config.layer !== 'desktop';
  [iconWin, panelWin].forEach((w) => {
    if (!alive(w)) return;
    if (overlay) w.setAlwaysOnTop(true, 'screen-saver');
    else w.setAlwaysOnTop(false);
  });
  if (!overlay && !state.panelVisible) sendToBottom(iconWin);
  startDesktopWatch();
}

/* ------------------------------------------------------------------ icon window */
function createIconWindow() {
  const size = iconWinSize();
  const wa = screen.getPrimaryDisplay().workArea;
  let x = isNum(config.posX) ? config.posX : wa.x + wa.width - size - 40;
  let y = isNum(config.posY) ? config.posY : wa.y + 80;
  if (!positionIsVisible(x, y, size)) { x = wa.x + wa.width - size - 40; y = wa.y + 80; }

  iconWin = new BrowserWindow(windowOptions({ width: size, height: size, x, y }));
  iconWin.loadFile('index.html');
  iconWin.once('ready-to-show', () => { iconWin.showInactive(); applyLayer(); });

  iconWin.on('blur', () => {
    if (config.layer === 'desktop' && !state.panelVisible && !state.opening) {
      setTimeout(() => { if (!state.panelVisible && !state.opening) sendToBottom(iconWin); }, 150);
    }
  });
  iconWin.on('closed', () => { iconWin = null; app.quit(); });
}

function resizeIcon(size) {
  if (!alive(iconWin)) return;
  const b = iconWin.getBounds();
  const w = size + 2 * PAD;
  const wa = screen.getDisplayMatching(b).workArea;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const x = clamp(Math.round(cx - w / 2), wa.x - PAD, wa.x + wa.width - w + PAD);
  const y = clamp(Math.round(cy - w / 2), wa.y - PAD, wa.y + wa.height - w + PAD);
  iconWin.setBounds({ x, y, width: w, height: w });
  config.posX = x;
  config.posY = y;
  relayoutPanel();
}

/* ------------------------------------------------------------------ panel window */
function ensurePanelWindow() {
  if (alive(panelWin)) return panelLoaded;
  panelWin = new BrowserWindow(windowOptions({ width: 400, height: 400 }));
  panelLoaded = new Promise((resolve) => panelWin.webContents.once('did-finish-load', resolve));
  panelWin.loadFile('panel.html');
  // clicking anywhere outside the panel (another app, the desktop...) takes focus away -> close
  panelWin.on('blur', () => { if (!suppressBlur) closePanel(); });
  panelWin.on('closed', () => { panelWin = null; state.panelVisible = false; });
  applyLayer();
  return panelLoaded;
}

function currentLayout(pw, ph) {
  const ib = iconWin.getBounds();
  const icon = { x: ib.x + PAD, y: ib.y + PAD, w: ib.width - 2 * PAD, h: ib.height - 2 * PAD };
  const wa = screen.getDisplayMatching(ib).workArea;
  return Object.assign(computeLayout({ icon, wa, pw, ph, gap: GAP, edge: EDGE }), { wa });
}

async function captureDisplay() {
  const d = screen.getDisplayMatching(iconWin.getBounds());
  // Capturing at full display resolution is the slowest part of opening the panel, and the
  // result is heavily blurred anyway, so ask for a much smaller thumbnail (big speed win on 4K).
  const CAP = 900;
  const scale = Math.min(1, CAP / Math.max(d.bounds.width, d.bounds.height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale) }
  });
  let src = sources.find((s) => String(s.display_id) === String(d.id));
  if (!src && sources.length === 1) src = sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  return { img: src.thumbnail, bounds: d.bounds };
}

// Screenshot of what is behind the panel, taken while the panel window is still hidden.
function startCapture() {
  if (!alive(iconWin)) return;
  capturePromise = captureDisplay().catch(() => null);
}

function cropBackdrop(cap, rect) {
  if (!cap) return null;
  try {
    const EX = 80; // extra margin so the blur has real pixels to sample at the panel's edges
    const b = cap.bounds;
    const size = cap.img.getSize();
    const sx = size.width / b.width;
    const sy = size.height / b.height;
    const x0 = Math.max(b.x, rect.x - EX);
    const y0 = Math.max(b.y, rect.y - EX);
    const x1 = Math.min(b.x + b.width, rect.x + rect.width + EX);
    const y1 = Math.min(b.y + b.height, rect.y + rect.height + EX);
    if (x1 <= x0 || y1 <= y0) return null;
    const jpeg = cap.img.crop({
      x: Math.round((x0 - b.x) * sx),
      y: Math.round((y0 - b.y) * sy),
      width: Math.max(1, Math.round((x1 - x0) * sx)),
      height: Math.max(1, Math.round((y1 - y0) * sy))
    }).toJPEG(72);
    return { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), x: x0 - rect.x, y: y0 - rect.y, w: x1 - x0, h: y1 - y0 };
  } catch (e) {
    return null;
  }
}

async function openPanel() {
  if (state.panelVisible || state.opening || !alive(iconWin)) return false;
  state.opening = true;
  clearTimeout(state.hideTimer);
  try {
    await ensurePanelWindow();
    const layout = currentLayout(config.panelWidth, config.panelHeight);
    state.dir = layout.dir;
    state.panelRect = layout.rect;
    state.wa = layout.wa;

    // The screenshot is no longer on the critical path: the panel opens on plain glass
    // immediately, then the blurred backdrop fades in a moment later once it's ready.
    panelWin.setBounds(inflate(layout.rect, M));
    const ready = new Promise((resolve) => {
      state.readyResolve = resolve;
      setTimeout(resolve, 250); // safety net only; panel.js normally resolves this almost instantly
    });
    send(panelWin, 'panel-open', {
      dir: layout.dir,
      width: layout.rect.width,
      height: layout.rect.height,
      origin: layout.origin,
      cfg: config,
      cpu: lastCpu
    });
    await ready;

    panelWin.show();
    panelWin.focus();
    state.panelVisible = true;
    send(panelWin, 'panel-shown');
    send(iconWin, 'panel-opened');

    if (capturePromise) {
      const forRect = state.panelRect;
      capturePromise.then((cap) => {
        if (!state.panelVisible || state.panelRect !== forRect) return; // closed or resized meanwhile
        const backdrop = cropBackdrop(cap, forRect);
        if (backdrop) send(panelWin, 'panel-backdrop', backdrop);
      }).catch(() => {});
      capturePromise = null;
    }
    return true;
  } catch (e) {
    console.error('openPanel failed', e);
    return false;
  } finally {
    state.opening = false;
  }
}

function closePanel() {
  if (!state.panelVisible) return;
  state.panelVisible = false;
  state.resize = null;
  send(panelWin, 'panel-hide');   // fade-out animation
  send(iconWin, 'panel-closed');  // icon snaps straight back to live CPU graphics
  state.hideTimer = setTimeout(() => {
    if (alive(panelWin) && !state.panelVisible && !state.opening) panelWin.hide();
  }, 240);
  if (config.layer === 'desktop') sendToBottom(iconWin);
}

function relayoutPanel() {
  if (!state.panelVisible || !alive(iconWin) || !alive(panelWin)) return;
  const l = currentLayout(state.panelRect.width, state.panelRect.height);
  state.dir = l.dir;
  state.panelRect = l.rect;
  state.wa = l.wa;
  panelWin.setBounds(inflate(l.rect, M));
  send(panelWin, 'panel-layout', { dir: l.dir, width: l.rect.width, height: l.rect.height, origin: l.origin });
}

/* ------------------------------------------------------------------ CPU */
function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((c) => {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  });
  return { idle: idle / cpus.length, total: total / cpus.length };
}

function getCpuUsagePercent() {
  return new Promise((resolve) => {
    const a = cpuSnapshot();
    setTimeout(() => {
      const b = cpuSnapshot();
      const dt = b.total - a.total;
      const usage = dt > 0 ? 100 - Math.round(((b.idle - a.idle) / dt) * 100) : 0;
      resolve(clamp(usage, 0, 100));
    }, 250);
  });
}

let cpuBusy = false;
async function pollCpu() {
  if (cpuBusy) return;
  cpuBusy = true;
  try {
    lastCpu = await getCpuUsagePercent();
    send(iconWin, 'cpu', lastCpu);
    if (state.panelVisible) send(panelWin, 'cpu', lastCpu);
  } finally {
    cpuBusy = false;
  }
}

/* ------------------------------------------------------------------ app lifecycle */
app.whenReady().then(() => {
  try { fs.mkdirSync(EYES_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  createIconWindow();
  setInterval(pollCpu, 1800);
  pollCpu();
});

app.on('before-quit', flushConfig);
app.on('will-quit', () => {
  clearInterval(desktopPollTimer);
  if (psProc) { try { psProc.kill(); } catch (e) { /* ignore */ } }
});
app.on('window-all-closed', () => app.quit());

/* ------------------------------------------------------------------ IPC: config */
ipcMain.handle('get-config', () => config);
ipcMain.handle('get-cpu', () => lastCpu);

ipcMain.handle('save-config', (event, partial) => {
  const clean = sanitize(partial || {});
  const sizeChanged = 'iconSize' in clean && clean.iconSize !== config.iconSize;
  const layerChanged = 'layer' in clean && clean.layer !== config.layer;
  Object.assign(config, clean);
  if (sizeChanged) resizeIcon(config.iconSize);
  if (layerChanged) applyLayer();
  persistSoon();
  broadcast('config', config);
  return config;
});

/* ------------------------------------------------------------------ IPC: panel */
ipcMain.on('panel:prepare', () => { ensurePanelWindow(); startCapture(); });

ipcMain.on('show-context-menu', () => {
  if (!alive(iconWin)) return;
  Menu.buildFromTemplate([
    { label: 'Settings', click: () => openWithSettings() },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ]).popup({ window: iconWin });
});

async function openWithSettings() {
  const opened = state.panelVisible ? true : await openPanel();
  if (opened) send(panelWin, 'open-settings');
}
ipcMain.handle('panel:open', () => openPanel());
ipcMain.on('panel:close', () => closePanel());
ipcMain.on('panel:ready', () => {
  if (state.readyResolve) { state.readyResolve(); state.readyResolve = null; }
});

// While dragging the resize handle the window is temporarily made as big as the
// panel may become, so the resize itself is pure CSS (smooth); it snaps to size on release.
ipcMain.handle('panel:resize-start', () => {
  if (!state.panelVisible || !alive(panelWin)) return null;
  const { maxW, maxH } = maxSizes(state.dir, state.panelRect, state.wa, EDGE, PANEL_CAP);
  state.resize = { maxW, maxH };
  panelWin.setBounds(inflate(anchoredRect(state.dir, state.panelRect, maxW, maxH), M));
  return { maxW, maxH, minW: PANEL_MIN.w, minH: PANEL_MIN.h };
});

ipcMain.on('panel:resize-end', (event, w, h) => {
  if (!state.panelVisible || !state.resize || !alive(panelWin) || !isNum(w) || !isNum(h)) return;
  const nw = clamp(Math.round(w), PANEL_MIN.w, state.resize.maxW);
  const nh = clamp(Math.round(h), PANEL_MIN.h, state.resize.maxH);
  const rect = anchoredRect(state.dir, state.panelRect, nw, nh);
  panelWin.setBounds(inflate(rect, M));
  state.panelRect = rect;
  state.resize = null;
  config.panelWidth = nw;
  config.panelHeight = nh;
  persistSoon();
});

/* ------------------------------------------------------------------ IPC: folder */
// Folders always come first; within each group, sorted by the chosen key/direction.
function compareItems(a, b, cfg) {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const byName = () => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  let cmp;
  if (cfg.sortBy === 'modified') cmp = a.mtimeMs - b.mtimeMs;
  else if (cfg.sortBy === 'size') cmp = a.size - b.size;
  else if (cfg.sortBy === 'type') cmp = a.ext.localeCompare(b.ext) || byName();
  else cmp = byName();
  if (cmp === 0) cmp = byName();
  return cfg.sortDir === 'desc' ? -cmp : cmp;
}

ipcMain.handle('list-dir', async () => {
  const target = config.watchFolder;
  try {
    const items = fs.readdirSync(target, { withFileTypes: true })
      // hide dot-files and Office temp/lock files such as ~$report.docx
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('~$'))
      .map((e) => {
        const fullPath = path.join(target, e.name);
        let mtimeMs = 0;
        let size = 0;
        try {
          const st = fs.statSync(fullPath);
          mtimeMs = st.mtimeMs;
          size = st.size;
        } catch (err) { /* permission error etc: sorts as if empty/oldest, still listed */ }
        return {
          name: e.name,
          isDirectory: e.isDirectory(),
          fullPath,
          mtimeMs,
          size,
          ext: e.isDirectory() ? '' : path.extname(e.name).toLowerCase()
        };
      })
      .sort((a, b) => compareItems(a, b, config));
    return { ok: true, path: target, items };
  } catch (err) {
    return { ok: false, path: target, error: err.message, items: [] };
  }
});

ipcMain.handle('open-path', async (event, p) => {
  if (typeof p !== 'string') return { ok: false, error: 'bad path' };
  const rel = path.relative(path.resolve(config.watchFolder), path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'outside the watched folder' };
  const result = await shell.openPath(path.resolve(p));
  return { ok: result === '', error: result || null };
});

ipcMain.handle('choose-folder', async () => {
  suppressBlur = true; // the native dialog steals focus; don't treat that as "click outside"
  try {
    const r = await dialog.showOpenDialog(panelWin, {
      properties: ['openDirectory'],
      title: 'Choose folder for the widget to show'
    });
    if (r.canceled || !r.filePaths.length) return null;
    config.watchFolder = r.filePaths[0];
    persistSoon();
    broadcast('config', config);
    return config.watchFolder;
  } finally {
    suppressBlur = false;
    if (state.panelVisible && alive(panelWin)) panelWin.focus();
  }
});

/* ------------------------------------------------------------------ IPC: custom eyes */
ipcMain.handle('list-custom-eyes', async () => {
  try {
    return fs.readdirSync(EYES_DIR)
      .filter((n) => n.toLowerCase().endsWith('.svg'))
      .map((n) => ({ n, full: path.join(EYES_DIR, n) }))
      .filter(({ full }) => fs.statSync(full).size < 512 * 1024)
      .map(({ n, full }) => ({ id: 'custom:' + n, name: n.replace(/\.svg$/i, ''), svg: fs.readFileSync(full, 'utf-8') }));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('open-eyes-folder', async () => shell.openPath(EYES_DIR));

/* ---------------- IPC: drag a listed item out to copy it into any folder/app ---------------- */
ipcMain.on('start-drag', async (event, filePath) => {
  if (!config.dragToCopy || typeof filePath !== 'string') return;
  const rel = path.relative(path.resolve(config.watchFolder), path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return; // only items actually in the watched folder
  let icon = null;
  try { icon = await app.getFileIcon(filePath, { size: 'normal' }); } catch (e) { /* fall through */ }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  try {
    event.sender.startDrag({ file: filePath, icon });
  } catch (e) {
    console.error('startDrag failed', e);
  }
});

/* ------------------------------------------------------------------ IPC: dragging the icon */
let dragStart = null;

ipcMain.on('drag-start', () => {
  if (!alive(iconWin)) return;
  const [x, y] = iconWin.getPosition();
  dragStart = { x, y };
});

ipcMain.on('drag-move', (event, dx, dy) => {
  if (!alive(iconWin) || !dragStart || !isNum(dx) || !isNum(dy)) return;
  const s = iconWinSize(); // fixed size avoids DPI-scaling drift on Windows
  iconWin.setBounds({ x: Math.round(dragStart.x + dx), y: Math.round(dragStart.y + dy), width: s, height: s });
});

ipcMain.on('drag-end', () => {
  if (alive(iconWin)) {
    const [x, y] = iconWin.getPosition();
    config.posX = x;
    config.posY = y;
    persistSoon();
  }
  dragStart = null;
});
