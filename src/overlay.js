// Прозрачный слой на весь экран: рисует ковры (WebGL) и обрабатывает мышь.
const api = window.kover;
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', {
  alpha: true,
  premultipliedAlpha: true,
  antialias: true,
  depth: true,
  preserveDrawingBuffer: true,
});

const RUG_ASPECT = 1514 / 786;
const EYE = 1800; // «высота камеры» для лёгкой перспективы
const DT = 1 / 60;

let view = { w: window.innerWidth, h: window.innerHeight };
let dpr = window.devicePixelRatio || 1;
const rugs = []; // по порядку снизу вверх
let texture = null;
let textureReady = false;

// ---------- WebGL ----------
function shader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const clothProg = program(`#version 300 es
in vec3 aPos;
in vec3 aNor;
in vec2 aUv;
uniform vec2 uView;
uniform float uEye;
uniform float uShadow;
out vec2 vUv;
out vec3 vNor;
out float vZ;
void main() {
  vec2 c = uView * 0.5;
  vec2 p = aPos.xy;
  float z = aPos.z;
  if (uShadow > 0.5) {
    // свет сверху-слева: тень уезжает вправо-вниз тем дальше, чем выше ткань
    p += vec2(0.35, 0.6) * z + vec2(0.0, 2.5);
    z = 0.0;
  }
  float k = uEye / (uEye - z);
  vec2 s = c + (p - c) * k;
  gl_Position = vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.5 - aPos.z / 4000.0, 1.0);
  vUv = aUv;
  vNor = aNor;
  vZ = aPos.z;
}`, `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uShadow;
in vec2 vUv;
in vec3 vNor;
in float vZ;
out vec4 o;
void main() {
  if (uShadow > 0.5) {
    o = vec4(0.0, 0.0, 0.0, 0.5 * (1.0 - clamp(vZ / 260.0, 0.0, 0.55)));
    return;
  }
  vec3 n = normalize(vNor);
  vec3 col = texture(uTex, vUv).rgb;
  if (!gl_FrontFacing) {
    // изнанка: тот же узор, но тусклый и «сухой»
    n = -n;
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(vec3(l), col, 0.6) * 0.8 + vec3(0.05, 0.03, 0.01);
  }
  vec3 L = normalize(vec3(-0.35, -0.55, 0.85));
  float diff = max(dot(n, L), 0.0);
  float shade = 0.3 + 0.82 * diff;
  o = vec4(col * shade, 1.0);
}`);

const blurProg = program(`#version 300 es
in vec2 aQ;
out vec2 vT;
void main() { vT = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`, `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vT;
out vec4 o;
void main() {
  float a = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float w = exp(-float(x * x + y * y) / 4.0);
      a += texture(uTex, vT + vec2(float(x), float(y)) * uTexel * 2.0).a * w;
      wsum += w;
    }
  }
  a /= wsum;
  o = vec4(0.0, 0.0, 0.0, a);
}`);

const loc = {
  pos: gl.getAttribLocation(clothProg, 'aPos'),
  nor: gl.getAttribLocation(clothProg, 'aNor'),
  uv: gl.getAttribLocation(clothProg, 'aUv'),
  view: gl.getUniformLocation(clothProg, 'uView'),
  eye: gl.getUniformLocation(clothProg, 'uEye'),
  shadow: gl.getUniformLocation(clothProg, 'uShadow'),
  tex: gl.getUniformLocation(clothProg, 'uTex'),
  q: gl.getAttribLocation(blurProg, 'aQ'),
  btex: gl.getUniformLocation(blurProg, 'uTex'),
  texel: gl.getUniformLocation(blurProg, 'uTexel'),
};

const quadVao = gl.createVertexArray();
gl.bindVertexArray(quadVao);
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(loc.q);
gl.vertexAttribPointer(loc.q, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

let shadowFbo = null;
let shadowTex = null;
let shadowSize = [0, 0];

function resize() {
  view = { w: window.innerWidth, h: window.innerHeight };
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  const sw = Math.max(1, Math.round(canvas.width / 2));
  const sh = Math.max(1, Math.round(canvas.height / 2));
  if (!shadowFbo) {
    shadowFbo = gl.createFramebuffer();
    shadowTex = gl.createTexture();
  }
  gl.bindTexture(gl.TEXTURE_2D, shadowTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  shadowSize = [sw, sh];
  for (const r of rugs) clampOnScreen(r);
  render();
}

function loadTexture(src) {
  const img = new Image();
  img.onload = () => {
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    textureReady = true;
    render();
  };
  img.src = src || 'rug.jpg';
}

function makeMesh(rug) {
  const c = rug.cloth;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, c.pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(loc.pos);
  gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
  const norBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
  gl.bufferData(gl.ARRAY_BUFFER, c.normals, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(loc.nor);
  gl.vertexAttribPointer(loc.nor, 3, gl.FLOAT, false, 0, 0);
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, c.uv, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc.uv);
  gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  if (rug.mesh) freeMesh(rug);
  rug.mesh = { vao, posBuf, norBuf, uvBuf, idxBuf, count: c.indices.length };
}

function freeMesh(rug) {
  const m = rug.mesh;
  if (!m) return;
  gl.deleteVertexArray(m.vao);
  [m.posBuf, m.norBuf, m.uvBuf, m.idxBuf].forEach((b) => gl.deleteBuffer(b));
  rug.mesh = null;
}

function drawCloth(rug, shadowPass) {
  const m = rug.mesh;
  gl.useProgram(clothProg);
  gl.uniform2f(loc.view, view.w, view.h);
  gl.uniform1f(loc.eye, EYE);
  gl.uniform1f(loc.shadow, shadowPass ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(loc.tex, 0);
  gl.bindVertexArray(m.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, m.posBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rug.cloth.pos);
  gl.bindBuffer(gl.ARRAY_BUFFER, m.norBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rug.cloth.normals);
  gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
}

function render() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!textureReady) return;
  gl.frontFace(gl.CW);

  gl.enable(gl.SCISSOR_TEST);
  for (const rug of rugs) {
    if (!rug.mesh) makeMesh(rug);
    const box = screenBox(rug);
    if (!box) continue;

    // 1) тень в отдельный буфер
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, shadowSize[0], shadowSize[1]);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    setScissor(box, shadowSize[0] / view.w);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    drawCloth(rug, true);
    gl.blendEquation(gl.FUNC_ADD);

    // 2) размытая тень на экран
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    setScissor(box, canvas.width / view.w);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blurProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.uniform1i(loc.btex, 0);
    gl.uniform2f(loc.texel, 1 / shadowSize[0], 1 / shadowSize[1]);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // 3) сам ковёр
    gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    drawCloth(rug, false);
    gl.disable(gl.DEPTH_TEST);
  }
  gl.disable(gl.SCISSOR_TEST);
}

// прямоугольник на экране, который занимает ковёр вместе с тенью
function screenBox(rug) {
  const p = rug.cloth.pos;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < p.length; k += 3) {
    const z = p[k + 2];
    const [sx, sy] = project(p[k], p[k + 1], z);
    x0 = Math.min(x0, sx);
    y0 = Math.min(y0, sy);
    x1 = Math.max(x1, sx + z * 0.35);
    y1 = Math.max(y1, sy + z * 0.6);
  }
  const m = 24;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(view.w, x1 + m);
  y1 = Math.min(view.h, y1 + m);
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

function setScissor([x0, y0, x1, y1], k) {
  const h = Math.round(view.h * k);
  gl.scissor(Math.floor(x0 * k), h - Math.ceil(y1 * k), Math.ceil((x1 - x0) * k) + 1, Math.ceil((y1 - y0) * k) + 1);
}

// ---------- ковры ----------
function gridFor(width) {
  const nx = Math.max(30, Math.min(64, Math.round(width / 12)));
  const ny = Math.max(12, Math.round(((nx - 1) / RUG_ASPECT)) + 1);
  return { nx, ny };
}

function createRug(spec) {
  const width = spec.width;
  const height = width / RUG_ASPECT;
  const { nx, ny } = gridFor(width);
  const cloth = new Cloth({ width, height, nx, ny });
  const rug = { id: spec.id, width, cloth, active: false, still: 0, flatten: null, mesh: null };
  let restored = false;
  if (spec.pos && spec.nx === nx && spec.ny === ny) {
    try {
      const bin = atob(spec.pos);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const arr = new Float32Array(bytes.buffer);
      if (arr.length === cloth.n * 3 && arr.every(Number.isFinite)) {
        cloth.pos.set(arr);
        cloth.prev.set(arr);
        cloth.computeNormals();
        restored = true;
      }
    } catch {
      restored = false;
    }
  }
  if (!restored) {
    cloth.layFlat(spec.cx ?? view.w / 2, spec.cy ?? view.h / 2, ((spec.angle || 0) * Math.PI) / 180);
    cloth.computeNormals();
  }
  clampOnScreen(rug);
  return rug;
}

function rebuildRug(rug, width) {
  const [cx, cy] = rug.cloth.centroid();
  const angle = (rug.cloth.angle() * 180) / Math.PI;
  const fresh = createRug({ id: rug.id, width, cx, cy, angle });
  freeMesh(rug);
  Object.assign(rug, { width: fresh.width, cloth: fresh.cloth, flatten: null, active: false });
  render();
  scheduleSave();
}

function clampOnScreen(rug) {
  const [cx, cy] = rug.cloth.centroid();
  const nx = Math.max(20, Math.min(view.w - 20, cx));
  const ny = Math.max(20, Math.min(view.h - 20, cy));
  if (nx !== cx || ny !== cy) rug.cloth.translate(nx - cx, ny - cy);
}

function serialize(rug) {
  const c = rug.cloth;
  const bytes = new Uint8Array(c.pos.buffer.slice(0));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const [cx, cy] = c.centroid();
  return {
    id: rug.id,
    width: rug.width,
    cx: Math.round(cx),
    cy: Math.round(cy),
    angle: Math.round((c.angle() * 180) / Math.PI),
    nx: c.nx,
    ny: c.ny,
    pos: btoa(bin),
  };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.save(rugs.map(serialize)), 500);
}

function straighten(rug, angleDeg) {
  const [cx, cy] = rug.cloth.centroid();
  const a = angleDeg == null ? rug.cloth.angle() : (angleDeg * Math.PI) / 180;
  rug.cloth.unpin();
  rug.flatten = rug.cloth.flatTarget(cx, cy, a);
  wake(rug);
}

// ---------- анимация ----------
let running = false;
function wake(rug) {
  rug.active = true;
  rug.still = 0;
  rug.age = 0;
  if (!running) {
    running = true;
    requestAnimationFrame(frame);
  }
}

let lastFrame = 0;
function frame(now) {
  const real = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : DT;
  lastFrame = now;
  let any = false;
  for (const rug of rugs) {
    if (!rug.active) continue;
    const c = rug.cloth;
    if (rug.flatten) {
      const err = c.flattenToward(rug.flatten, 0.16);
      if (err < 0.4) {
        c.pos.set(rug.flatten);
        c.prev.set(c.pos);
        c.computeNormals();
        rug.flatten = null;
        rug.active = false;
        scheduleSave();
      }
    } else {
      if (c.pinned >= 0) rug.age = 0;
      else rug.age += real;
      c.settle = Math.max(0, Math.min(1, 1 - (rug.age - 0.9) / 1.3));
      const mv = c.step(DT);
      if (c.pinned < 0 && mv < 0.05) rug.still++;
      else rug.still = 0;
      if (rug.still > 20 || c.settle === 0) {
        c.settle = 1;
        rug.active = false;
        scheduleSave();
      }
    }
    any = any || rug.active;
  }
  render();
  if (any) requestAnimationFrame(frame);
  else {
    running = false;
    lastFrame = 0;
  }
}

// ---------- мышь ----------
const project = (x, y, z) => {
  const k = EYE / (EYE - z);
  return [view.w / 2 + (x - view.w / 2) * k, view.h / 2 + (y - view.h / 2) * k];
};
const unproject = (sx, sy, z) => {
  const k = (EYE - z) / EYE;
  return [view.w / 2 + (sx - view.w / 2) * k, view.h / 2 + (sy - view.h / 2) * k];
};

function overCloth(x, y) {
  const px = Math.round(x * dpr);
  const py = canvas.height - 1 - Math.round(y * dpr);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  const out = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out[3] > 200;
}

// какой ковёр и какая точка под курсором (сверху вниз)
function pick(x, y) {
  for (let r = rugs.length - 1; r >= 0; r--) {
    const c = rugs[r].cloth;
    const reach = c.s * 1.3;
    let best = -1;
    let bestZ = -Infinity;
    let nearest = -1;
    let nearestD = Infinity;
    for (let k = 0; k < c.n; k++) {
      const [sx, sy] = project(c.pos[k * 3], c.pos[k * 3 + 1], c.pos[k * 3 + 2]);
      const d = Math.hypot(sx - x, sy - y);
      if (d < reach && c.pos[k * 3 + 2] > bestZ) {
        bestZ = c.pos[k * 3 + 2];
        best = k;
      }
      if (d < nearestD) {
        nearestD = d;
        nearest = k;
      }
    }
    if (best >= 0) return { rug: rugs[r], k: best };
    if (nearestD < c.s * 2.5 && insideHull(c, x, y)) return { rug: rugs[r], k: nearest };
  }
  return null;
}

// грубая проверка «внутри ковра»: по треугольникам сетки
function insideHull(c, x, y) {
  const { indices, pos } = c;
  for (let t = 0; t < indices.length; t += 3) {
    const a = project(pos[indices[t] * 3], pos[indices[t] * 3 + 1], pos[indices[t] * 3 + 2]);
    const b = project(pos[indices[t + 1] * 3], pos[indices[t + 1] * 3 + 1], pos[indices[t + 1] * 3 + 2]);
    const d = project(pos[indices[t + 2] * 3], pos[indices[t + 2] * 3 + 1], pos[indices[t + 2] * 3 + 2]);
    const s1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const s2 = (d[0] - b[0]) * (y - b[1]) - (d[1] - b[1]) * (x - b[0]);
    const s3 = (a[0] - d[0]) * (y - d[1]) - (a[1] - d[1]) * (x - d[0]);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  }
  return false;
}

// за край или уголок — тянем и мнём; за середину — переносим целиком
function isEdge(c, k) {
  const i = k % c.nx;
  const j = (k / c.nx) | 0;
  const d = Math.min(i * c.sx, (c.nx - 1 - i) * c.sx, j * c.sy, (c.ny - 1 - j) * c.sy);
  return d < Math.min(c.width, c.height) * 0.2;
}

let ignoring = true;
function setIgnore(v) {
  if (v === ignoring) return;
  ignoring = v;
  api.ignoreMouse(v);
}

let grab = null; // { rug, mode: 'pull'|'move', last:[x,y], lift }

function liftHeight(c) {
  return Math.min(130, Math.max(40, c.height * 0.32));
}

function toTop(rug) {
  const i = rugs.indexOf(rug);
  if (i >= 0 && i !== rugs.length - 1) {
    rugs.splice(i, 1);
    rugs.push(rug);
  }
}

window.addEventListener('mousemove', (e) => {
  if (grab) {
    if (grab.mode === 'move') {
      const dx = e.clientX - grab.last[0];
      const dy = e.clientY - grab.last[1];
      grab.last = [e.clientX, e.clientY];
      grab.rug.cloth.translate(dx, dy);
      clampOnScreen(grab.rug);
      render();
    } else {
      const [x, y] = unproject(e.clientX, e.clientY, grab.lift);
      grab.rug.cloth.movePin(x, y, grab.lift);
      wake(grab.rug);
    }
    return;
  }
  const hit = overCloth(e.clientX, e.clientY);
  setIgnore(!hit);
  if (hit) {
    const p = pick(e.clientX, e.clientY);
    canvas.style.cursor = p && (e.altKey || isEdge(p.rug.cloth, p.k)) ? 'grab' : 'move';
  } else {
    canvas.style.cursor = 'default';
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!overCloth(e.clientX, e.clientY)) return;
  const p = pick(e.clientX, e.clientY);
  if (!p) return;
  e.preventDefault();
  toTop(p.rug);
  const c = p.rug.cloth;
  p.rug.flatten = null;
  if (e.altKey || isEdge(c, p.k)) {
    const lift = c.pos[p.k * 3 + 2] + liftHeight(c);
    const [x, y] = unproject(e.clientX, e.clientY, lift);
    c.pin(p.k, x, y, lift);
    grab = { rug: p.rug, mode: 'pull', lift };
    canvas.style.cursor = 'grabbing';
    wake(p.rug);
  } else {
    grab = { rug: p.rug, mode: 'move', last: [e.clientX, e.clientY] };
    canvas.style.cursor = 'move';
    render();
  }
});

function release() {
  if (!grab) return;
  if (grab.mode === 'pull') {
    grab.rug.cloth.unpin();
    wake(grab.rug);
  } else {
    scheduleSave();
  }
  grab = null;
  canvas.style.cursor = 'default';
}

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) release();
});
window.addEventListener('blur', release);

canvas.addEventListener('dblclick', (e) => {
  if (!overCloth(e.clientX, e.clientY)) return;
  const p = pick(e.clientX, e.clientY);
  if (p) straighten(p.rug);
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!overCloth(e.clientX, e.clientY)) return;
  const p = pick(e.clientX, e.clientY);
  if (p) {
    release();
    api.menu(p.rug.id);
  }
});

// колесо — повернуть (с прилипанием к ровному положению), Ctrl/⌘ + колесо — размер
const wheelState = { rug: null, raw: 0, timer: null, zoom: 1, zoomRaf: 0 };
window.addEventListener('wheel', (e) => {
  if (grab || !overCloth(e.clientX, e.clientY)) return;
  const p = pick(e.clientX, e.clientY);
  if (!p) return;
  e.preventDefault();
  const rug = p.rug;
  if (e.ctrlKey || e.metaKey) {
    wheelState.zoom *= Math.exp(-e.deltaY * 0.004);
    if (!wheelState.zoomRaf) {
      wheelState.zoomRaf = requestAnimationFrame(() => {
        const w = Math.max(160, Math.min(3000, rug.width * wheelState.zoom));
        wheelState.zoom = 1;
        wheelState.zoomRaf = 0;
        rebuildRug(rug, w);
      });
    }
    return;
  }
  const c = rug.cloth;
  const cur = (c.angle() * 180) / Math.PI;
  if (wheelState.rug !== rug) {
    wheelState.rug = rug;
    wheelState.raw = cur;
  }
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  wheelState.raw += d * (e.deltaMode === 1 ? 4 : 0.15);
  const nearest = Math.round(wheelState.raw / 90) * 90;
  const target = Math.abs(wheelState.raw - nearest) < 3 ? nearest : wheelState.raw;
  let delta = target - cur;
  delta = ((delta + 540) % 360) - 180;
  const [cx, cy] = c.centroid();
  c.rotate((delta * Math.PI) / 180, cx, cy);
  c.computeNormals();
  render();
  clearTimeout(wheelState.timer);
  wheelState.timer = setTimeout(() => {
    wheelState.rug = null;
    scheduleSave();
  }, 400);
}, { passive: false });

// ---------- команды из меню ----------
api.onAction(({ id, action, value }) => {
  const rug = rugs.find((r) => r.id === id);
  switch (action) {
    case 'add': {
      const r = createRug(value);
      rugs.push(r);
      render();
      scheduleSave();
      break;
    }
    case 'straighten':
      if (rug) straighten(rug);
      break;
    case 'level':
      if (rug) straighten(rug, 0);
      break;
    case 'rotate90':
      if (rug) straighten(rug, Math.round((rug.cloth.angle() * 180) / Math.PI / 90) * 90 + 90);
      break;
    case 'size':
      if (rug) rebuildRug(rug, value);
      break;
    case 'remove':
      if (rug) {
        freeMesh(rug);
        rugs.splice(rugs.indexOf(rug), 1);
        render();
        scheduleSave();
      }
      break;
    case 'straighten-all':
      rugs.forEach((r) => straighten(r, 0));
      break;
    default:
  }
});

window.addEventListener('resize', resize);

(async () => {
  const init = await api.init();
  resize();
  for (const spec of init.rugs) rugs.push(createRug(spec));
  loadTexture(init.image);
  render();
})();
