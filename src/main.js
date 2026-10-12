// Kover — ковёр, который лежит на рабочем столе и прячет под собой папки и файлы.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const RUG_ASPECT = 1514 / 786; // пропорции картинки ковра (ширина / высота)
const PAD = 36; // запас под тень вокруг ковра
const MIN_WIDTH = 160;
const MAX_WIDTH = 3000;
const DEFAULT_WIDTH = 560;

const isMac = process.platform === 'darwin';
const ru = () => (app.getLocale() || '').toLowerCase().startsWith('ru')
  || (app.getPreferredSystemLanguages?.() || []).some((l) => l.toLowerCase().startsWith('ru'));
const t = (r, e) => (ru() ? r : e);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- состояние ----------
const statePath = () => path.join(app.getPath('userData'), 'rugs.json');
let state = { rugs: [], hidden: false };
let saveTimer = null;

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (data && Array.isArray(data.rugs)) state = { rugs: data.rugs, hidden: !!data.hidden };
    return true;
  } catch {
    return false;
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  clearTimeout(saveTimer);
  for (const [id, w] of wins) {
    const rug = state.rugs.find((r) => r.id === id);
    if (rug && !w.isDestroyed()) {
      const b = w.getBounds();
      rug.cx = Math.round(b.x + b.width / 2);
      rug.cy = Math.round(b.y + b.height / 2);
    }
  }
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('save failed', e);
  }
}

const clampWidth = (w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
const rugHeight = (w) => Math.round(w / RUG_ASPECT);
const sideFor = (w) => Math.ceil(Math.hypot(w, rugHeight(w))) + PAD * 2;

function centerOnScreen(rug) {
  const pt = { x: Math.round(rug.cx), y: Math.round(rug.cy) };
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
  });
}

function newRug(offset = 0) {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cx: Math.round(wa.x + wa.width / 2 + offset),
    cy: Math.round(wa.y + wa.height / 2 + offset),
    angle: 0,
    width: Math.min(DEFAULT_WIDTH, Math.round(wa.width * 0.6)),
  };
}

// ---------- окна-ковры ----------
const wins = new Map(); // id -> BrowserWindow
let drag = null; // { win, timer, startCursor, startPos }

function boundsFor(rug) {
  const side = sideFor(rug.width);
  return {
    x: Math.round(rug.cx - side / 2),
    y: Math.round(rug.cy - side / 2),
    width: side,
    height: side,
  };
}

function createRugWindow(rug) {
  const win = new BrowserWindow({
    ...boundsFor(rug),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    show: false,
    title: 'Kover',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.rugId = rug.id;
  win.setIgnoreMouseEvents(true, { forward: true });
  if (isMac) win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (!state.hidden) win.showInactive();
  });
  win.on('closed', () => wins.delete(rug.id));
  wins.set(rug.id, win);
  return win;
}

function rugOf(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return {};
  return { win, rug: state.rugs.find((r) => r.id === win.rugId) };
}

function sendRug(win, rug) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('rug:set', { width: rug.width, height: rugHeight(rug.width), angle: rug.angle });
}

function resizeRug(win, rug, width) {
  const b = win.getBounds();
  rug.cx = b.x + b.width / 2;
  rug.cy = b.y + b.height / 2;
  rug.width = clampWidth(width);
  win.setBounds(boundsFor(rug));
  sendRug(win, rug);
  saveState();
}

function setAngle(win, rug, angle) {
  rug.angle = ((angle % 360) + 360) % 360;
  sendRug(win, rug);
  saveState();
}

function addRug() {
  const rug = newRug(state.rugs.length ? 40 * (state.rugs.length % 6) : 0);
  state.rugs.push(rug);
  state.hidden = false;
  showAll();
  createRugWindow(rug);
  saveState();
  rebuildTray();
}

function removeRug(id) {
  state.rugs = state.rugs.filter((r) => r.id !== id);
  const w = wins.get(id);
  if (w && !w.isDestroyed()) w.destroy();
  saveState();
  rebuildTray();
}

function showAll() {
  state.hidden = false;
  for (const w of wins.values()) if (!w.isDestroyed()) w.showInactive();
  saveState();
  rebuildTray();
}

function hideAll() {
  state.hidden = true;
  for (const w of wins.values()) if (!w.isDestroyed()) w.hide();
  saveState();
  rebuildTray();
}

// ---------- перетаскивание (двигаем окно вслед за курсором) ----------
function stopDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  saveState();
}

ipcMain.on('rug:drag-start', (e) => {
  const { win } = rugOf(e);
  if (!win) return;
  stopDrag();
  const [x, y] = win.getPosition();
  const c = screen.getCursorScreenPoint();
  drag = { win, startCursor: c, startPos: { x, y } };
  drag.timer = setInterval(() => {
    if (!drag || drag.win.isDestroyed()) return stopDrag();
    const p = screen.getCursorScreenPoint();
    const nx = drag.startPos.x + p.x - drag.startCursor.x;
    const ny = drag.startPos.y + p.y - drag.startCursor.y;
    const [cx, cy] = drag.win.getPosition();
    if (cx !== nx || cy !== ny) drag.win.setPosition(nx, ny, false);
  }, 8);
});

ipcMain.on('rug:drag-end', () => stopDrag());

ipcMain.on('rug:ignore', (e, ignore) => {
  const { win } = rugOf(e);
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('rug:ready', (e) => {
  const { win, rug } = rugOf(e);
  if (win && rug) sendRug(win, rug);
});

ipcMain.on('rug:angle', (e, angle) => {
  const { rug } = rugOf(e);
  if (!rug || !Number.isFinite(angle)) return;
  rug.angle = ((angle % 360) + 360) % 360;
  saveState();
});

ipcMain.on('rug:zoom', (e, factor) => {
  const { win, rug } = rugOf(e);
  if (!win || !rug || !Number.isFinite(factor)) return;
  resizeRug(win, rug, rug.width * factor);
});

ipcMain.on('rug:menu', (e) => {
  const { win, rug } = rugOf(e);
  if (!win || !rug) return;
  stopDrag();
  rugMenu(win, rug).popup({ window: win });
});

// ---------- меню ----------
function sizesFor(win) {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const full = Math.min(wa.width * 0.94, wa.height * 0.94 * RUG_ASPECT);
  return [
    [t('Маленький', 'Small'), 320],
    [t('Средний', 'Medium'), 560],
    [t('Большой', 'Large'), 860],
    [t('Во весь стол', 'Fill the desk'), full],
  ];
}

function rugMenu(win, rug) {
  return Menu.buildFromTemplate([
    { label: t('Повернуть на 90°', 'Rotate 90°'), click: () => setAngle(win, rug, Math.round(rug.angle / 90) * 90 + 90) },
    { label: t('Положить ровно', 'Straighten'), click: () => setAngle(win, rug, 0) },
    {
      label: t('Размер', 'Size'),
      submenu: [
        ...sizesFor(win).map(([label, w]) => ({ label, click: () => resizeRug(win, rug, w) })),
        { type: 'separator' },
        { label: t('Больше', 'Bigger'), click: () => resizeRug(win, rug, rug.width * 1.15) },
        { label: t('Меньше', 'Smaller'), click: () => resizeRug(win, rug, rug.width / 1.15) },
      ],
    },
    { type: 'separator' },
    { label: t('Постелить ещё один ковёр', 'Add another rug'), click: addRug },
    { label: t('Убрать этот ковёр', 'Remove this rug'), click: () => removeRug(rug.id) },
    { label: t('Спрятать все ковры', 'Hide all rugs'), click: hideAll },
    { type: 'separator' },
    loginItem(),
    { label: t('Как пользоваться…', 'How to use…'), click: showHelp },
    { label: t('Выйти', 'Quit'), click: () => app.quit() },
  ]);
}

function loginItem() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const opts = isMac ? {} : { path: exe };
  return {
    label: t('Запускать вместе с компьютером', 'Start at login'),
    type: 'checkbox',
    enabled: app.isPackaged,
    checked: app.isPackaged && app.getLoginItemSettings(opts).openAtLogin,
    click: (item) => app.setLoginItemSettings({ ...opts, openAtLogin: item.checked }),
  };
}

const helpText = () => t(
  '• Тяни ковёр мышкой — он переедет.\n'
  + '• Потяни за уголок — ковёр загнётся, можно подглядеть, что под ним.\n'
  + '• Колесо мыши / два пальца на тачпаде над ковром — повернуть.\n'
  + '• Ctrl или ⌘ + колесо (или щипок на тачпаде) — сделать больше/меньше.\n'
  + '• Правая кнопка по ковру — меню: размер, ещё ковёр, убрать.\n'
  + '• Значок ковра в ' + (isMac ? 'строке меню вверху' : 'трее у часов') + ' — показать/спрятать ковры и выйти.',
  '• Drag the rug to move it.\n'
  + '• Drag a corner to fold it and peek underneath.\n'
  + '• Scroll over the rug to rotate it.\n'
  + '• Ctrl/⌘ + scroll (or pinch) to resize.\n'
  + '• Right-click the rug for more options.\n'
  + '• Use the rug icon in the ' + (isMac ? 'menu bar' : 'system tray') + ' to show/hide rugs or quit.',
);

function showHelp() {
  dialog.showMessageBox({
    type: 'info',
    title: 'Kover',
    message: t('Ковёр на рабочий стол', 'A rug for your desktop'),
    detail: helpText(),
    buttons: ['OK'],
  });
}

let tray = null;

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Постелить ещё один ковёр', 'Add another rug'), click: addRug },
    state.hidden || !state.rugs.length
      ? { label: t('Показать ковры', 'Show rugs'), click: () => (state.rugs.length ? showAll() : addRug()) }
      : { label: t('Спрятать ковры', 'Hide rugs'), click: hideAll },
    {
      label: t('Положить все ровно', 'Straighten all'),
      click: () => state.rugs.forEach((r) => setAngle(wins.get(r.id), r, 0)),
    },
    { type: 'separator' },
    loginItem(),
    { label: t('Как пользоваться…', 'How to use…'), click: showHelp },
    { type: 'separator' },
    { label: t('Выйти', 'Quit'), click: () => app.quit() },
  ]));
}

function createTray() {
  const img = isMac
    ? nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-win.png'));
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(t('Ковёр', 'Kover'));
  if (!isMac) tray.on('click', () => (state.hidden ? showAll() : hideAll()));
  rebuildTray();
}

// ---------- запуск ----------
app.on('second-instance', () => {
  if (!state.rugs.length) addRug();
  else showAll();
});

app.on('window-all-closed', () => {
  // живём в трее, даже если все ковры убраны
});

app.on('before-quit', saveNow);

app.whenReady().then(() => {
  if (isMac && app.dock) app.dock.hide();
  const firstRun = !loadState();
  state.rugs = state.rugs.filter((r) => r && r.id && Number.isFinite(r.width));
  if (firstRun || !state.rugs.length) state.rugs = [newRug()];
  for (const rug of state.rugs) {
    rug.width = clampWidth(rug.width);
    rug.angle = Number.isFinite(rug.angle) ? rug.angle : 0;
    if (!centerOnScreen(rug)) Object.assign(rug, { cx: newRug().cx, cy: newRug().cy });
    createRugWindow(rug);
  }
  createTray();
  saveState();
  if (firstRun) {
    if (Notification.isSupported()) {
      new Notification({
        title: t('Ковёр постелен', 'Rug is down'),
        body: t('Тяни мышкой, крути колесом, загибай уголок. Правая кнопка — меню.',
          'Drag it, scroll to rotate, pull a corner to peek. Right-click for menu.'),
      }).show();
    }
  }
});
