// Рисуем ковёр: перетаскивание, поворот, загибание уголка.
const api = window.kover;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const img = new Image();
img.src = 'rug.jpg';

let W = 0; // ширина ковра (CSS px)
let H = 0; // высота ковра
let angleDeg = 0; // угол, который показываем (с «прилипанием» к 0/90/180/270)
let rawAngle = 0; // угол без прилипания — накапливается от колеса
let dpr = 1;
let side = 0;

let mode = 'idle'; // idle | drag | lift
let ignoring = true;
let corner = -1; // какой уголок загнут/под курсором
let liftP = null; // текущая точка, куда «приехал» уголок (локальные координаты)
let liftTarget = null;
let animating = false;
let mouse = null; // последняя позиция курсора в окне

const SNAP = 3; // градусы прилипания

// ---------- геометрия ----------
const rad = () => (angleDeg * Math.PI) / 180;
const corners = () => [
  { x: -W / 2, y: -H / 2 },
  { x: W / 2, y: -H / 2 },
  { x: W / 2, y: H / 2 },
  { x: -W / 2, y: H / 2 },
];

function toLocal(x, y) {
  const dx = x - side / 2;
  const dy = y - side / 2;
  const a = rad();
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

const inside = (p) => Math.abs(p.x) <= W / 2 && Math.abs(p.y) <= H / 2;
const cornerZone = () => Math.min(W, H) * 0.24;

function cornerAt(p) {
  if (!inside(p)) return -1;
  const cs = corners();
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(p.x - cs[i].x, p.y - cs[i].y) < cornerZone()) return i;
  }
  return -1;
}

// оставляем часть многоугольника, где f(p) <= 0
function clipPoly(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const tt = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt });
    }
  }
  return out;
}

function pathPoly(poly) {
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

// ---------- изнанка ковра ----------
let backPattern = null;
function makeBackPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,240,220,0.05)';
  g.fillRect(0, 0, 6, 3);
  g.fillStyle = 'rgba(0,0,0,0.08)';
  g.fillRect(0, 3, 3, 3);
  backPattern = ctx.createPattern(c, 'repeat');
}

// ---------- рисование ----------
function resize() {
  const nd = window.devicePixelRatio || 1;
  const ns = window.innerWidth;
  if (nd === dpr && ns === side && canvas.width) return;
  dpr = nd;
  side = ns;
  canvas.width = Math.round(side * dpr);
  canvas.height = Math.round(side * dpr);
  makeBackPattern();
}

function draw() {
  resize();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!W || !img.complete || !img.naturalWidth) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(side / 2, side / 2);
  ctx.rotate(rad());
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const rect = corners();
  const C = corner >= 0 ? rect[corner] : null;
  const folded = C && liftP && Math.hypot(liftP.x - C.x, liftP.y - C.y) > 0.5;

  if (!folded) {
    ctx.save();
    setShadow(10, 3, 0.42);
    ctx.drawImage(img, -W / 2, -H / 2, W, H);
    ctx.restore();
    return;
  }

  const P = liftP;
  const M = { x: (C.x + P.x) / 2, y: (C.y + P.y) / 2 };
  let nx = C.x - P.x;
  let ny = C.y - P.y;
  const len = Math.hypot(nx, ny);
  nx /= len;
  ny /= len;
  const side_ = (p) => (p.x - M.x) * nx + (p.y - M.y) * ny; // > 0 — сторона загнутого уголка

  const base = clipPoly(rect, side_);
  const flap = clipPoly(rect, (p) => -side_(p));
  const reflect = (p) => {
    const d = 2 * side_(p);
    return { x: p.x - d * nx, y: p.y - d * ny };
  };

  // 1) основная часть ковра с тенью
  if (base.length >= 3) {
    ctx.save();
    setShadow(10, 3, 0.42);
    pathPoly(base);
    ctx.fillStyle = '#3a0d0a';
    ctx.fill();
    ctx.restore();
    ctx.save();
    pathPoly(base);
    ctx.clip();
    ctx.drawImage(img, -W / 2, -H / 2, W, H);
    // складка: лёгкое затемнение у линии сгиба
    const g = ctx.createLinearGradient(M.x, M.y, M.x - nx * 22, M.y - ny * 22);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  if (flap.length < 3) return;
  const flapR = flap.map(reflect);

  // 2) тень от загнутого уголка
  const lift = Math.min(1, len / (Math.min(W, H) * 0.6));
  ctx.save();
  setShadow(8 + 16 * lift, 4 + 8 * lift, 0.45);
  pathPoly(flapR);
  ctx.fillStyle = '#2b0b08';
  ctx.fill();
  ctx.restore();

  // 3) изнанка уголка: тот же узор зеркально, но тусклее
  ctx.save();
  ctx.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny,
    2 * (M.x * nx + M.y * ny) * nx, 2 * (M.x * nx + M.y * ny) * ny);
  pathPoly(flap);
  ctx.clip();
  ctx.filter = 'brightness(0.8) saturate(0.75) contrast(0.85) sepia(0.12)';
  ctx.drawImage(img, -W / 2, -H / 2, W, H);
  ctx.filter = 'none';
  if (backPattern) {
    ctx.fillStyle = backPattern;
    ctx.fillRect(-W / 2, -H / 2, W, H);
  }
  // объём: светлее у сгиба, темнее к краю
  const far = Math.max(20, len * 0.5);
  const g2 = ctx.createLinearGradient(M.x, M.y, M.x + nx * far, M.y + ny * far);
  g2.addColorStop(0, 'rgba(255,235,215,0.22)');
  g2.addColorStop(0.35, 'rgba(255,235,215,0.04)');
  g2.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = g2;
  ctx.fillRect(-W / 2, -H / 2, W, H);
  ctx.restore();
}

function setShadow(blur, offset, alpha) {
  // тень не зависит от поворота: свет всегда сверху
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur * dpr;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = offset * dpr;
}

// ---------- анимация уголка ----------
function tick() {
  let moving = false;
  if (corner >= 0 && liftTarget) {
    if (!liftP) liftP = { ...corners()[corner] };
    const k = mode === 'lift' ? 0.45 : 0.22;
    const dx = liftTarget.x - liftP.x;
    const dy = liftTarget.y - liftP.y;
    if (Math.hypot(dx, dy) > 0.3) {
      liftP.x += dx * k;
      liftP.y += dy * k;
      moving = true;
    } else {
      liftP = { ...liftTarget };
    }
    const C = corners()[corner];
    if (!moving && mode !== 'lift' && Math.hypot(liftP.x - C.x, liftP.y - C.y) < 0.5 && hoverCorner() !== corner) {
      corner = -1;
      liftP = liftTarget = null;
    }
  }
  draw();
  if (moving) requestAnimationFrame(tick);
  else animating = false;
}

function animate() {
  if (animating) return;
  animating = true;
  requestAnimationFrame(tick);
}

function hoverCorner() {
  if (!mouse || mode !== 'idle') return -1;
  return cornerAt(toLocal(mouse.x, mouse.y));
}

// лёгкий «подгиб» уголка при наведении — подсказка, что его можно потянуть
function hintTarget(i) {
  const C = corners()[i];
  const d = Math.min(W, H) * 0.07;
  const sx = -Math.sign(C.x);
  const sy = -Math.sign(C.y);
  return { x: C.x + sx * d * 0.9, y: C.y + sy * d * 0.6 };
}

function setIgnore(v) {
  if (v === ignoring) return;
  ignoring = v;
  api.ignoreMouse(v);
}

function updateHover() {
  if (mode !== 'idle') return;
  const p = mouse ? toLocal(mouse.x, mouse.y) : null;
  const hit = p && inside(p);
  setIgnore(!hit);
  const c = p ? cornerAt(p) : -1;
  canvas.style.cursor = c >= 0 ? 'grab' : hit ? 'move' : 'default';
  if (c >= 0) {
    if (corner !== c) {
      corner = c;
      liftP = { ...corners()[c] };
    }
    liftTarget = hintTarget(c);
  } else if (corner >= 0) {
    liftTarget = { ...corners()[corner] };
  }
  animate();
}

// ---------- мышь ----------
window.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (mode === 'lift') {
    const C = corners()[corner];
    let p = toLocal(e.clientX, e.clientY);
    // не даём загнуть дальше разумного
    const maxLen = Math.min(W, H) * 0.95;
    const dx = p.x - C.x;
    const dy = p.y - C.y;
    const l = Math.hypot(dx, dy);
    if (l > maxLen) p = { x: C.x + (dx / l) * maxLen, y: C.y + (dy / l) * maxLen };
    liftTarget = p;
    animate();
    return;
  }
  updateHover();
});

window.addEventListener('mouseleave', () => {
  if (mode !== 'idle') return;
  mouse = null;
  updateHover();
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const p = toLocal(e.clientX, e.clientY);
  if (!inside(p)) return;
  const c = cornerAt(p);
  if (c >= 0) {
    mode = 'lift';
    corner = c;
    if (!liftP) liftP = { ...corners()[c] };
    liftTarget = { ...liftP };
    canvas.style.cursor = 'grabbing';
  } else {
    mode = 'drag';
    canvas.style.cursor = 'move';
    api.dragStart();
  }
  e.preventDefault();
});

function endPointer() {
  if (mode === 'drag') api.dragEnd();
  if (mode === 'lift' && corner >= 0) liftTarget = { ...corners()[corner] };
  mode = 'idle';
  animate();
  updateHover();
}

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) endPointer();
});
window.addEventListener('blur', () => {
  if (mode !== 'idle') endPointer();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (inside(toLocal(e.clientX, e.clientY))) api.menu();
});

let angleSaveTimer = null;
let zoomAcc = 1;
let zoomRaf = 0;
window.addEventListener('wheel', (e) => {
  if (mode !== 'idle') return;
  if (!inside(toLocal(e.clientX, e.clientY))) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomAcc *= Math.exp(-e.deltaY * 0.004);
    if (!zoomRaf) {
      zoomRaf = requestAnimationFrame(() => {
        api.zoom(zoomAcc);
        zoomAcc = 1;
        zoomRaf = 0;
      });
    }
    return;
  }
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  rawAngle += d * (e.deltaMode === 1 ? 4 : 0.15);
  rawAngle = ((rawAngle % 360) + 360) % 360;
  const nearest = Math.round(rawAngle / 90) * 90;
  angleDeg = Math.abs(rawAngle - nearest) < SNAP ? nearest % 360 : rawAngle;
  corner = -1;
  liftP = liftTarget = null;
  draw();
  clearTimeout(angleSaveTimer);
  angleSaveTimer = setTimeout(() => api.setAngle(angleDeg), 250);
  // после поворота курсор мог оказаться за краем ковра
  setIgnore(!inside(toLocal(e.clientX, e.clientY)));
}, { passive: false });

// ---------- связь с главным процессом ----------
api.onSet(({ width, height, angle }) => {
  W = width;
  H = height;
  angleDeg = rawAngle = angle;
  corner = -1;
  liftP = liftTarget = null;
  draw();
});

window.addEventListener('resize', draw);
img.onload = draw;
api.ready();
