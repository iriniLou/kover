// Kover — ковёр, который лежит на рабочем столе и прячет под собой папки и файлы.
// На каждом мониторе — прозрачный слой во весь экран; ковры рисуются в нём,
// а клики мимо ковра проходят насквозь к рабочему столу.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const RUG_ASPECT = 1514 / 786;
const DEFAULT_WIDTH = 560;

const isMac = process.platform === 'darwin';
const ru = () => (app.getLocale() || '').toLowerCase().startsWith('ru')
  || (app.getPreferredSystemLanguages?.() || []).some((l) => l.toLowerCase().startsWith('ru'));
const t = (r, e) => (ru() ? r : e);

// WebGL нужен всегда: если видеокарта в «чёрном списке», рисуем программно
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

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
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch (e) {
    console.error('save failed', e);
  }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function newRugSpec(display, offset = 0) {
  const wa = display.workArea;
  return {
    id: newId(),
    display: display.id,
    width: Math.min(DEFAULT_WIDTH, Math.round(wa.width * 0.6)),
    cx: Math.round(wa.width / 2 + offset),
    cy: Math.round(wa.height / 2 + offset),
    angle: 0,
  };
}

// ---------- слои (по одному на монитор) ----------
const overlays = new Map(); // display.id -> BrowserWindow

function createOverlay(display) {
  const wa = display.workArea;
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
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
  win.displayId = display.id;
  win.setIgnoreMouseEvents(true, { forward: true });
  if (isMac) win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.setBounds(wa);
    if (!state.hidden) win.showInactive();
  });
  win.on('closed', () => {
    if (overlays.get(display.id) === win) overlays.delete(display.id);
  });
  overlays.set(display.id, win);
  return win;
}

function buildOverlays() {
  for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
  overlays.clear();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // ковры с отключённых мониторов переезжают на основной
  for (const r of state.rugs) {
    if (!displays.some((d) => d.id === r.display)) {
      r.display = primary.id;
      delete r.pos;
      r.cx = Math.round(primary.workArea.width / 2);
      r.cy = Math.round(primary.workArea.height / 2);
    }
  }
  for (const d of displays) createOverlay(d);
  saveState();
}

let displayTimer = null;
let displayKey = '';
const currentDisplayKey = () => screen.getAllDisplays()
  .map((d) => `${d.id}:${d.workArea.x},${d.workArea.y},${d.workArea.width},${d.workArea.height}`).join('|');

function onDisplaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    const key = currentDisplayKey();
    if (key === displayKey) return;
    displayKey = key;
    buildOverlays();
  }, 800);
}

const overlayOf = (e) => BrowserWindow.fromWebContents(e.sender);
const send = (win, msg) => win && !win.isDestroyed() && win.webContents.send('ov:action', msg);

ipcMain.handle('ov:init', (e) => {
  const win = overlayOf(e);
  const id = win?.displayId;
  let image = null;
  try {
    image = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'rug.jpg')).toString('base64');
  } catch {
    image = null;
  }
  return { image, rugs: state.rugs.filter((r) => r.display === id) };
});

ipcMain.on('ov:save', (e, rugs) => {
  const win = overlayOf(e);
  if (!win || !Array.isArray(rugs)) return;
  const id = win.displayId;
  state.rugs = state.rugs.filter((r) => r.display !== id).concat(rugs.map((r) => ({ ...r, display: id })));
  saveState();
  rebuildTray();
});

ipcMain.on('ov:ignore', (e, ignore) => {
  const win = overlayOf(e);
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('ov:menu', (e, rugId) => {
  const win = overlayOf(e);
  if (!win) return;
  rugMenu(win, rugId).popup({ window: win });
});

// ---------- действия ----------
function addRug() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const count = state.rugs.filter((r) => r.display === display.id).length;
  const spec = newRugSpec(display, 40 * (count % 6));
  state.rugs.push(spec);
  if (state.hidden) showAll();
  send(overlays.get(display.id), { action: 'add', value: spec });
  saveState();
  rebuildTray();
}

function moveToDisplay(win, rugId, display) {
  const rug = state.rugs.find((r) => r.id === rugId);
  if (!rug || display.id === win.displayId) return;
  send(win, { id: rugId, action: 'remove' });
  const spec = { ...newRugSpec(display), id: newId(), width: rug.width, angle: rug.angle || 0 };
  state.rugs = state.rugs.filter((r) => r.id !== rugId).concat(spec);
  send(overlays.get(display.id), { action: 'add', value: spec });
  saveState();
}

function showAll() {
  state.hidden = false;
  for (const w of overlays.values()) if (!w.isDestroyed()) w.showInactive();
  saveState();
  rebuildTray();
}

function hideAll() {
  state.hidden = true;
  for (const w of overlays.values()) if (!w.isDestroyed()) w.hide();
  saveState();
  rebuildTray();
}

function sizesFor(win) {
  const wa = screen.getAllDisplays().find((d) => d.id === win.displayId)?.workArea || screen.getPrimaryDisplay().workArea;
  const full = Math.round(Math.min(wa.width * 0.94, wa.height * 0.94 * RUG_ASPECT));
  return [
    [t('Маленький', 'Small'), 320],
    [t('Средний', 'Medium'), 560],
    [t('Большой', 'Large'), 860],
    [t('Во весь стол', 'Fill the desk'), full],
  ];
}

function rugMenu(win, rugId) {
  const act = (action, value) => () => send(win, { id: rugId, action, value });
  const rug = state.rugs.find((r) => r.id === rugId);
  const displays = screen.getAllDisplays();
  const items = [
    { label: t('Расправить', 'Smooth out'), click: act('straighten') },
    { label: t('Положить ровно', 'Straighten'), click: act('level') },
    { label: t('Повернуть на 90°', 'Rotate 90°'), click: act('rotate90') },
    {
      label: t('Размер', 'Size'),
      submenu: [
        ...sizesFor(win).map(([label, w]) => ({ label, click: act('size', w) })),
        { type: 'separator' },
        { label: t('Больше', 'Bigger'), click: act('size', Math.min(3000, Math.round((rug?.width || DEFAULT_WIDTH) * 1.2))) },
        { label: t('Меньше', 'Smaller'), click: act('size', Math.max(160, Math.round((rug?.width || DEFAULT_WIDTH) / 1.2))) },
      ],
    },
  ];
  if (displays.length > 1) {
    items.push({
      label: t('Перенести на другой экран', 'Move to another display'),
      submenu: displays.map((d, i) => ({
        label: `${t('Экран', 'Display')} ${i + 1}${d.id === win.displayId ? ' ✓' : ''}`,
        enabled: d.id !== win.displayId,
        click: () => moveToDisplay(win, rugId, d),
      })),
    });
  }
  items.push(
    { type: 'separator' },
    { label: t('Постелить ещё один ковёр', 'Add another rug'), click: addRug },
    { label: t('Убрать этот ковёр', 'Remove this rug'), click: act('remove') },
    { label: t('Спрятать все ковры', 'Hide all rugs'), click: hideAll },
    { type: 'separator' },
    loginItem(),
    { label: t('Как пользоваться…', 'How to use…'), click: showHelp },
    { label: t('Выйти', 'Quit'), click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
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
  '• Возьми ковёр за середину и тащи — он переедет целиком.\n'
  + '• Потяни за край или уголок — ковёр задерётся и сомнётся складками. '
  + 'Отпустишь — так и останется мятым.\n'
  + '• С зажатым ' + (isMac ? '⌥ Option' : 'Alt') + ' можно мять за любое место.\n'
  + '• Двойной клик по ковру — расправить.\n'
  + '• Колесо мыши / два пальца на тачпаде — повернуть.\n'
  + '• ' + (isMac ? '⌘' : 'Ctrl') + ' + колесо (или щипок на тачпаде) — больше/меньше.\n'
  + '• Правая кнопка по ковру — меню: расправить, размер, ещё ковёр, убрать.\n'
  + '• Значок ковра ' + (isMac ? 'в строке меню вверху' : 'в трее у часов') + ' — показать/спрятать ковры и выйти.',
  '• Drag the middle of the rug to move it.\n'
  + '• Pull an edge or a corner to lift and crumple it. It stays crumpled.\n'
  + '• Hold ' + (isMac ? '⌥ Option' : 'Alt') + ' to crumple from anywhere.\n'
  + '• Double-click to smooth it out.\n'
  + '• Scroll to rotate; ' + (isMac ? '⌘' : 'Ctrl') + ' + scroll (or pinch) to resize.\n'
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
      label: t('Расправить все и положить ровно', 'Smooth & straighten all'),
      click: () => overlays.forEach((w) => send(w, { action: 'straighten-all' })),
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
  // живём в трее, даже если окна пересоздаются
});

app.on('before-quit', saveNow);

app.whenReady().then(() => {
  if (isMac && app.dock) app.dock.hide();
  const firstRun = !loadState();
  state.rugs = state.rugs.filter((r) => r && r.id && Number.isFinite(r.width));
  const primary = screen.getPrimaryDisplay();
  if (firstRun || !state.rugs.length) state.rugs = [newRugSpec(primary)];
  displayKey = currentDisplayKey();
  buildOverlays();
  createTray();
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
  if (firstRun && Notification.isSupported()) {
    new Notification({
      title: t('Ковёр постелен', 'Rug is down'),
      body: t('Тащи за середину, мни за края, двойной клик — расправить. Правая кнопка — меню.',
        'Drag the middle, crumple the edges, double-click to smooth. Right-click for menu.'),
    }).show();
  }
});
