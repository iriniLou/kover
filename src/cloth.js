// Физика ковра: сетка частиц (position-based dynamics).
// Координаты в CSS-пикселях экрана: x вправо, y вниз, z — высота над полом.
(function (root) {
  const GRAVITY = 3200; // px/s²

  class Cloth {
    constructor({ width, height, nx, ny }) {
      this.width = width;
      this.height = height;
      this.nx = nx;
      this.ny = ny;
      this.n = nx * ny;
      this.sx = width / (nx - 1);
      this.sy = height / (ny - 1);
      this.s = Math.min(this.sx, this.sy);
      this.thickness = Math.max(3, this.s * 0.7);

      const n = this.n;
      this.pos = new Float32Array(n * 3);
      this.prev = new Float32Array(n * 3);
      this.inv = new Float32Array(n).fill(1);
      this.contact = new Uint8Array(n); // лежит на полу или на другом слое ковра
      this.touch = new Uint8Array(n); // касается другого слоя ковра
      this.ground = new Uint8Array(n); // лежит на полу
      this.normals = new Float32Array(n * 3);
      this.uv = new Float32Array(n * 2);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          this.uv[k * 2] = i / (nx - 1);
          this.uv[k * 2 + 1] = j / (ny - 1);
        }
      }
      this.bend = 0.5; // жёсткость на изгиб: ковёр толстый, гнётся мягкими волнами
      this.restXY = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const i = k % nx;
        const j = (k / nx) | 0;
        this.restXY[k * 2] = i * this.sx - width / 2;
        this.restXY[k * 2 + 1] = j * this.sy - height / 2;
      }
      // сколько ковёр может «собраться» у руки, прежде чем поедет целиком
      this.slack = Math.min(width, height) * 0.16;
      this.inertia = (width * width + height * height) / 12;
      this.settle = 1; // 1 — свободно движется, 0 — замер
      this.buildConstraints();
      this.buildIndices();
      this.pinned = -1;
      this.pinTarget = [0, 0, 0];
      this.rng = 1;
      this.grip = 0.06; // насколько легко сдвинуть лежащую на полу часть
      this.friction = 0.35; // доля сдвига по полу, которая «проскальзывает»
      this.start = new Float32Array(this.n * 3);
      this.staticFriction = 0.04; // px² за подшаг
    }

    idx(i, j) {
      return j * this.nx + i;
    }

    restPos(k) {
      const i = k % this.nx;
      const j = (k / this.nx) | 0;
      return [i * this.sx - this.width / 2, j * this.sy - this.height / 2];
    }

    buildConstraints() {
      const { nx, ny } = this;
      const list = [];
      const add = (i1, j1, i2, j2, stiff) => {
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) return;
        const a = this.idx(i1, j1);
        const b = this.idx(i2, j2);
        const [ax, ay] = this.restPos(a);
        const [bx, by] = this.restPos(b);
        list.push([a, b, Math.hypot(ax - bx, ay - by), stiff === -1 ? this.bend : stiff === -2 ? this.bend * 0.5 : stiff]);
      };
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          add(i, j, i + 1, j, 1); // растяжение
          add(i, j, i, j + 1, 1);
          add(i, j, i + 1, j + 1, 0.9); // сдвиг
          add(i + 1, j, i, j + 1, 0.9);
          add(i, j, i + 2, j, -1); // изгиб
          add(i, j, i, j + 2, -1);
          add(i, j, i + 4, j, -2); // широкий изгиб: без мелких заломов
          add(i, j, i, j + 4, -2);
        }
      }
      const m = list.length;
      this.ca = new Uint32Array(m);
      this.cb = new Uint32Array(m);
      this.rest = new Float32Array(m);
      this.stiff = new Float32Array(m);
      list.forEach(([a, b, r, s], k) => {
        this.ca[k] = a;
        this.cb[k] = b;
        this.rest[k] = r;
        this.stiff[k] = s;
      });
    }

    buildIndices() {
      const { nx, ny } = this;
      const out = new Uint32Array((nx - 1) * (ny - 1) * 6);
      let p = 0;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = this.idx(i, j);
          const b = this.idx(i + 1, j);
          const c = this.idx(i, j + 1);
          const d = this.idx(i + 1, j + 1);
          out.set([a, b, c, b, d, c], p);
          p += 6;
        }
      }
      this.indices = out;
    }

    // плоско, с центром (cx, cy) и поворотом angle (радианы)
    layFlat(cx, cy, angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      for (let k = 0; k < this.n; k++) {
        const [x, y] = this.restPos(k);
        this.pos[k * 3] = cx + x * c - y * s;
        this.pos[k * 3 + 1] = cy + x * s + y * c;
        this.pos[k * 3 + 2] = 0;
      }
      this.prev.set(this.pos);
    }

    flatTarget(cx, cy, angle) {
      const t = new Float32Array(this.n * 3);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      for (let k = 0; k < this.n; k++) {
        const [x, y] = this.restPos(k);
        t[k * 3] = cx + x * c - y * s;
        t[k * 3 + 1] = cy + x * s + y * c;
      }
      return t;
    }

    centroid() {
      let x = 0;
      let y = 0;
      for (let k = 0; k < this.n; k++) {
        x += this.pos[k * 3];
        y += this.pos[k * 3 + 1];
      }
      return [x / this.n, y / this.n];
    }

    // общий угол ковра: средний вектор от левого края к правому
    angle() {
      const { nx, ny, pos } = this;
      let ux = 0;
      let uy = 0;
      for (let j = 0; j < ny; j++) {
        const a = this.idx(0, j) * 3;
        const b = this.idx(nx - 1, j) * 3;
        ux += pos[b] - pos[a];
        uy += pos[b + 1] - pos[a + 1];
      }
      return Math.atan2(uy, ux);
    }

    translate(dx, dy) {
      for (let k = 0; k < this.n; k++) {
        this.pos[k * 3] += dx;
        this.pos[k * 3 + 1] += dy;
        this.prev[k * 3] += dx;
        this.prev[k * 3 + 1] += dy;
      }
    }

    rotate(a, cx, cy) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (const arr of [this.pos, this.prev]) {
        for (let k = 0; k < this.n; k++) {
          const x = arr[k * 3] - cx;
          const y = arr[k * 3 + 1] - cy;
          arr[k * 3] = cx + x * c - y * s;
          arr[k * 3 + 1] = cy + x * s + y * c;
        }
      }
    }

    pin(k, x, y, z) {
      this.pinned = k;
      this.pinTarget = [x, y, z];
    }

    movePin(x, y, z) {
      this.pinTarget = [x, y, z];
    }

    unpin() {
      this.pinned = -1;
    }

    // положение ковра «как целого»: центр и угол, лучше всего подходящие к точкам
    frame() {
      const { pos, restXY, n } = this;
      let cx = 0;
      let cy = 0;
      for (let k = 0; k < n; k++) {
        cx += pos[k * 3];
        cy += pos[k * 3 + 1];
      }
      cx /= n;
      cy /= n;
      let sc = 0;
      let ss = 0;
      for (let k = 0; k < n; k++) {
        const px = pos[k * 3] - cx;
        const py = pos[k * 3 + 1] - cy;
        const qx = restXY[k * 2];
        const qy = restXY[k * 2 + 1];
        sc += qx * px + qy * py;
        ss += qx * py - qy * px;
      }
      const a = Math.atan2(ss, sc);
      return { cx, cy, cos: Math.cos(a), sin: Math.sin(a) };
    }

    // тянем за край: ковёр собирается у руки лишь немного, дальше едет и
    // поворачивается целиком, как тяжёлый ковёр по полу
    dragAlong() {
      const { pos, prev, restXY, n } = this;
      const pk = this.pinned;
      const f = this.frame();
      const gx = f.cx + restXY[pk * 2] * f.cos - restXY[pk * 2 + 1] * f.sin;
      const gy = f.cy + restXY[pk * 2] * f.sin + restXY[pk * 2 + 1] * f.cos;
      const ex = pos[pk * 3] - gx;
      const ey = pos[pk * 3 + 1] - gy;
      const el = Math.hypot(ex, ey);
      // внутрь ковра уголок можно загнуть сильнее — чтобы подглядеть под него
      const inward = ((f.cx - gx) * ex + (f.cy - gy) * ey) / (Math.hypot(f.cx - gx, f.cy - gy) * el || 1);
      const slack = this.slack * (1 + 1.6 * Math.max(0, inward));
      if (el > slack) {
        const k = 1 - slack / el;
        const jx = ex * k;
        const jy = ey * k;
        const rx = gx - f.cx;
        const ry = gy - f.cy;
        const ux = jx / (el * k);
        const uy = jy / (el * k);
        const arm = rx * uy - ry * ux;
        const share = 1 / (1 + (arm * arm) / this.inertia);
        const tx = jx * share;
        const ty = jy * share;
        const da = ((rx * ty - ry * tx) / this.inertia);
        const c = Math.cos(da);
        const s = Math.sin(da);
        for (const arr of [pos, prev]) {
          for (let q = 0; q < n; q++) {
            if (q === pk) continue;
            const x = arr[q * 3] - f.cx;
            const y = arr[q * 3 + 1] - f.cy;
            arr[q * 3] = f.cx + x * c - y * s + tx;
            arr[q * 3 + 1] = f.cy + x * s + y * c + ty;
          }
        }
      }
      // пока держим — ковёр помнит, что он прямоугольный, и не перекашивается
      const g = this.frame();
      const alpha = 0.06;
      for (let q = 0; q < n; q++) {
        if (q === pk) continue;
        const qx = restXY[q * 2];
        const qy = restXY[q * 2 + 1];
        pos[q * 3] += (g.cx + qx * g.cos - qy * g.sin - pos[q * 3]) * alpha;
        pos[q * 3 + 1] += (g.cy + qx * g.sin + qy * g.cos - pos[q * 3 + 1]) * alpha;
      }
    }

    noise() {
      this.rng = (this.rng * 16807) % 2147483647;
      return (this.rng / 2147483647 - 0.5) * 0.02;
    }

    step(dt, substeps = 4, iterations = 4) {
      const h = dt / substeps;
      let maxMove = 0;
      for (let s = 0; s < substeps; s++) {
        maxMove = Math.max(maxMove, this.substep(h, iterations));
      }
      this.computeNormals();
      return maxMove;
    }

    substep(h, iterations) {
      const { pos, prev, n, contact, inv } = this;
      const g = GRAVITY * h * h;
      // 1) интегрирование + трение о пол
      for (let k = 0; k < n; k++) {
        const o = k * 3;
        let vx = pos[o] - prev[o];
        let vy = pos[o + 1] - prev[o + 1];
        let vz = pos[o + 2] - prev[o + 2];
        if (contact[k]) {
          vx *= 0.55;
          vy *= 0.55;
          if (vx * vx + vy * vy < 0.0025) vx = vy = 0;
        } else {
          vx *= 0.995;
          vy *= 0.995;
        }
        vz *= this.touch[k] ? 0.2 : 0.985;
        prev[o] = pos[o];
        prev[o + 1] = pos[o + 1];
        prev[o + 2] = pos[o + 2];
        pos[o] += vx;
        pos[o + 1] += vy;
        pos[o + 2] += vz - g + this.noise();
      }

      // 2) схваченная точка тянется к курсору (не рывком)
      const pk = this.pinned;
      if (pk >= 0) {
        const o = pk * 3;
        const t = this.pinTarget;
        let dx = t[0] - pos[o];
        let dy = t[1] - pos[o + 1];
        let dz = t[2] - pos[o + 2];
        const d = Math.hypot(dx, dy, dz);
        const maxStep = this.s * 2.5;
        if (d > maxStep) {
          dx *= maxStep / d;
          dy *= maxStep / d;
          dz *= maxStep / d;
        }
        pos[o] += dx;
        pos[o + 1] += dy;
        pos[o + 2] += dz;
      }

      // точки, лежащие на полу, «тяжелее» — трение мешает им скользить,
      // поэтому ковёр не едет целиком, а собирается складками
      const w = this.w || (this.w = new Float32Array(n));
      for (let k = 0; k < n; k++) w[k] = k === pk ? 0 : inv[k] * (this.ground[k] ? this.grip : 1);

      this.start.set(pos);

      // 3) связи
      const { ca, cb, rest, stiff } = this;
      const m = ca.length;
      for (let it = 0; it < iterations; it++) {
        for (let c = 0; c < m; c++) {
          const a = ca[c];
          const b = cb[c];
          const wa = w[a];
          const wb = w[b];
          const ws = wa + wb;
          if (ws === 0) continue;
          const oa = a * 3;
          const ob = b * 3;
          const dx = pos[ob] - pos[oa];
          const dy = pos[ob + 1] - pos[oa + 1];
          const dz = pos[ob + 2] - pos[oa + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-6) continue;
          const f = ((d - rest[c]) / (d * ws)) * stiff[c];
          pos[oa] += dx * f * wa;
          pos[oa + 1] += dy * f * wa;
          pos[oa + 2] += dz * f * wa;
          pos[ob] -= dx * f * wb;
          pos[ob + 1] -= dy * f * wb;
          pos[ob + 2] -= dz * f * wb;
        }
        this.solveGround();
      }
      this.touch.fill(0);
      this.selfCollide();
      this.solveGround();

      // 4) трение о пол: лежащие точки сдвигаются лишь частично
      const st = this.start;
      const fr = this.friction;
      for (let k = 0; k < n; k++) {
        if (!contact[k] || k === pk) continue;
        const o = k * 3;
        const dx = pos[o] - st[o];
        const dy = pos[o + 1] - st[o + 1];
        // трение покоя: маленькие сдвиги гасятся полностью — складки остаются
        const f = dx * dx + dy * dy < this.staticFriction ? 0 : fr;
        pos[o] = st[o] + dx * f;
        pos[o + 1] = st[o + 1] + dy * f;
      }
      if (pk >= 0) this.dragAlong();

      // успокоение: после отпускания движение плавно затухает до полной остановки
      if (this.settle < 1) {
        const q = this.settle;
        for (let k = 0; k < n * 3; k++) pos[k] = prev[k] + (pos[k] - prev[k]) * q;
      }

      let maxMove = 0;
      for (let k = 0; k < n; k++) {
        const o = k * 3;
        const mv = Math.abs(pos[o] - prev[o]) + Math.abs(pos[o + 1] - prev[o + 1]) + Math.abs(pos[o + 2] - prev[o + 2]);
        if (mv > maxMove) maxMove = mv;
      }
      return maxMove;
    }

    solveGround() {
      const { pos, n, contact, touch } = this;
      for (let k = 0; k < n; k++) {
        const o = k * 3 + 2;
        if (pos[o] < 0) pos[o] = 0;
        this.ground[k] = pos[o] <= 0.3 ? 1 : 0;
        contact[k] = this.ground[k] || touch[k] ? 1 : 0;
      }
    }

    // ковёр не проходит сквозь себя: загнутый край ложится сверху
    selfCollide() {
      const { pos, prev, n, nx } = this;
      const r = this.thickness;
      const r2 = r * r;
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (let k = 0; k < n; k++) {
        const x = pos[k * 3];
        const y = pos[k * 3 + 1];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
      const gw = Math.min(512, Math.floor((maxx - minx) / r) + 1);
      const gh = Math.min(512, Math.floor((maxy - miny) / r) + 1);
      if (!this.head || this.head.length < gw * gh) this.head = new Int32Array(gw * gh);
      if (!this.next) this.next = new Int32Array(n);
      const { head, next } = this;
      head.fill(-1, 0, gw * gh);
      const cellOf = (k) => {
        const cx = Math.min(gw - 1, Math.floor((pos[k * 3] - minx) / r));
        const cy = Math.min(gh - 1, Math.floor((pos[k * 3 + 1] - miny) / r));
        return [cx, cy];
      };
      for (let k = 0; k < n; k++) {
        const [cx, cy] = cellOf(k);
        const c = cy * gw + cx;
        next[k] = head[c];
        head[c] = k;
      }
      const w = this.w;
      for (let a = 0; a < n; a++) {
        const [cx, cy] = cellOf(a);
        const ai = a % nx;
        const aj = (a / nx) | 0;
        for (let yy = Math.max(0, cy - 1); yy <= Math.min(gh - 1, cy + 1); yy++) {
          for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1); xx++) {
            for (let b = head[yy * gw + xx]; b !== -1; b = next[b]) {
              if (b <= a) continue;
              const bi = b % nx;
              const bj = (b / nx) | 0;
              if (Math.abs(ai - bi) <= 2 && Math.abs(aj - bj) <= 2) continue;
              const oa = a * 3;
              const ob = b * 3;
              const dx = pos[ob] - pos[oa];
              const dy = pos[ob + 1] - pos[oa + 1];
              let dz = pos[ob + 2] - pos[oa + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= r2) continue;
              const wa = w[a];
              const wb = w[b];
              const ws = wa + wb;
              if (ws === 0) continue;
              // толкаем в основном по вертикали — слои ложатся друг на друга
              if (Math.abs(dz) < 0.5) {
                const dzPrev = prev[ob + 2] - prev[oa + 2];
                if (Math.abs(dzPrev) > Math.abs(dz)) dz = dzPrev;
                if (Math.abs(dz) < 1e-3) dz = 1e-3;
              }
              const need = Math.sqrt(Math.max(0, r2 - dx * dx - dy * dy)) - Math.abs(dz);
              if (need <= 0.02) continue;
              const sgn = dz > 0 ? 1 : -1;
              // раздвигаем слои
              const ca = sgn * need * 0.5 * (wa / ws);
              const cb = sgn * need * 0.5 * (wb / ws);
              pos[oa + 2] -= ca;
              pos[ob + 2] += cb;
              // трение ткань о ткань
              const fx = (pos[ob] - prev[ob] - (pos[oa] - prev[oa])) * 0.3;
              const fy = (pos[ob + 1] - prev[ob + 1] - (pos[oa + 1] - prev[oa + 1])) * 0.3;
              pos[oa] += fx * (wa / ws);
              pos[oa + 1] += fy * (wa / ws);
              pos[ob] -= fx * (wb / ws);
              pos[ob + 1] -= fy * (wb / ws);
              this.touch[a] = 1;
              this.touch[b] = 1;
            }
          }
        }
      }
    }

    computeNormals() {
      const { pos, normals, nx, ny } = this;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const l = this.idx(Math.max(0, i - 1), j) * 3;
          const r = this.idx(Math.min(nx - 1, i + 1), j) * 3;
          const u = this.idx(i, Math.max(0, j - 1)) * 3;
          const d = this.idx(i, Math.min(ny - 1, j + 1)) * 3;
          const ax = pos[r] - pos[l];
          const ay = pos[r + 1] - pos[l + 1];
          const az = pos[r + 2] - pos[l + 2];
          const bx = pos[d] - pos[u];
          const by = pos[d + 1] - pos[u + 1];
          const bz = pos[d + 2] - pos[u + 2];
          let cx = ay * bz - az * by;
          let cy = az * bx - ax * bz;
          let cz = ax * by - ay * bx;
          const len = Math.hypot(cx, cy, cz) || 1;
          const o = this.idx(i, j) * 3;
          normals[o] = cx / len;
          normals[o + 1] = cy / len;
          normals[o + 2] = cz / len;
        }
      }
    }

    // плавно расправить: тянем все точки к ровному положению
    flattenToward(target, k) {
      const { pos, prev, n } = this;
      let err = 0;
      for (let q = 0; q < n; q++) {
        const o = q * 3;
        const dx = target[o] - pos[o];
        const dy = target[o + 1] - pos[o + 1];
        const dz = -pos[o + 2];
        pos[o] += dx * k;
        pos[o + 1] += dy * k;
        pos[o + 2] += dz * k;
        err = Math.max(err, Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
      }
      prev.set(pos);
      this.computeNormals();
      return err;
    }
  }

  root.Cloth = Cloth;
})(typeof window !== 'undefined' ? window : globalThis);
