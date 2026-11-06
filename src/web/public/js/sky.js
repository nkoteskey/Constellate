import { hash, realm } from './ui.js';

/**
 * The living sky. One rule: every motion is real.
 * The star field, realm regions, nebulae, lights and threads are drawn once and
 * stay still. The canvas animates only when a real record lands (a pulse for a
 * checkpoint, a travelling light for a contribution) or when you fly into a
 * problem, and then it stops.
 */
export class Sky {
  constructor(canvas, { onOpen, onHover, reduceMotion = () => false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onOpen = onOpen; this.onHover = onHover; this.reduceMotion = reduceMotion;
    this.nebulae = []; this.threads = []; this.anims = []; this.hover = null; this.fly = null;
    this.interest = {};
    this.raf = 0;
    this.base = document.createElement('canvas');
    this.sprites = new Map();
    canvas.addEventListener('mousemove', (e) => this.move(e.offsetX, e.offsetY));
    canvas.addEventListener('mouseleave', () => this.move(-1, -1));
    canvas.addEventListener('click', (e) => { const n = this.hit(e.offsetX, e.offsetY); if (n) this.open(n); });
    canvas.addEventListener('keydown', (e) => { if (e.key === 'Enter' && this.hover) this.open(this.hover); });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  set(data) { this.data = data; this.layout(); this.paintBase(); this.draw(); }
  setInterest(interest) { this.interest = interest; if (this.data) { this.layout(); this.paintBase(); this.draw(); } }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.dpr = dpr; this.W = w; this.H = h;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.base.width = w * dpr; this.base.height = h * dpr;
    if (this.data) { this.layout(); this.paintBase(); }
    this.draw();
  }

  /** Realms sit on a wide ellipse; each problem clusters near its realm. On wide screens the sky sits to the right of the headline. */
  layout() {
    if (!this.W) return;
    const { W, H } = this;
    const wide = W > 900;
    // Wide screens: the sky lives to the right of the headline and above the problem cards.
    const cx = wide ? W * 0.75 : W * 0.5, cy = wide ? H * 0.4 : H * 0.36;
    const rx = wide ? Math.min(W * 0.17, 360) : W * 0.36, ry = wide ? Math.min(H * 0.22, 230) : Math.min(H * 0.22, 220);
    const realms = this.data.realms;
    this.realmPos = new Map(realms.map((r, i) => {
      const a = -Math.PI / 2 + (i / realms.length) * Math.PI * 2 + 0.35;
      return [r.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, c: r.colour ?? realm(r.id).c, name: r.name }];
    }));
    const byRealm = {};
    this.nebulae = this.data.problems.map((p) => {
      const anchor = this.realmPos.get(p.realm) ?? { x: cx, y: cy, c: '#9aa0ae' };
      const k = (byRealm[p.realm] = (byRealm[p.realm] ?? 0) + 1) - 1;
      const pull = 1 + Math.min(1.5, (this.interest[p.realm] ?? 0) * 0.12); // the sky slowly arranges itself around you
      const a = hash(p.id) * Math.PI * 2 + k * 2.1;
      const d = (k === 0 ? 0 : 54 + k * 26) / pull;
      const total = p.activity.total;
      const r = Math.max(26, Math.min(86, 22 + Math.sqrt(total + 4) * 6.2));
      const progress = p.progress ? p.progress.done / p.progress.total : 0.45;
      return { ...p, x: anchor.x + Math.cos(a) * d, y: anchor.y + Math.sin(a) * d * 0.8, r, c: anchor.c, progress };
    });
    const pos = new Map(this.nebulae.map((n) => [n.id, n]));
    this.threads = (this.data.threads ?? []).map((t) => ({ ...t, A: pos.get(t.a), B: pos.get(t.b) })).filter((t) => t.A && t.B);
  }

  sprite(n) {
    const key = `${n.id}:${Math.round(n.r)}:${n.progress.toFixed(2)}`;
    if (this.sprites.has(key)) return this.sprites.get(key);
    const dpr = this.dpr ?? 1, R = n.r * 1.9, S = Math.ceil(R * 2 * dpr);
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const rgb = hexRgb(n.c);
    // Layered gas: several offset clouds of the realm's colour.
    for (let i = 0; i < 7; i++) {
      const ox = (hash(n.id + 'ox' + i) - 0.5) * n.r * 0.9, oy = (hash(n.id + 'oy' + i) - 0.5) * n.r * 0.7;
      const rr = n.r * (0.55 + hash(n.id + 'r' + i) * 0.75);
      const grd = g.createRadialGradient(R + ox, R + oy, 0, R + ox, R + oy, rr);
      const a = 0.10 + 0.16 * n.progress;
      grd.addColorStop(0, `rgba(${rgb},${a})`); grd.addColorStop(0.55, `rgba(${rgb},${a * 0.45})`); grd.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grd; g.beginPath(); g.arc(R + ox, R + oy, rr, 0, Math.PI * 2); g.fill();
    }
    // A bright core: brighter when more progress has been verified.
    const core = g.createRadialGradient(R, R, 0, R, R, n.r * 0.42);
    core.addColorStop(0, `rgba(255,255,255,${0.18 + 0.5 * n.progress})`); core.addColorStop(0.4, `rgba(${rgb},${0.18 + 0.2 * n.progress})`); core.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = core; g.beginPath(); g.arc(R, R, n.r * 0.42, 0, Math.PI * 2); g.fill();
    // Embedded stars.
    for (let i = 0; i < 14; i++) {
      const a = hash(n.id + 's' + i) * Math.PI * 2, d = Math.sqrt(hash(n.id + 'sd' + i)) * n.r * 0.9;
      g.fillStyle = `rgba(255,255,255,${0.25 + hash(n.id + 'sa' + i) * 0.5})`;
      g.beginPath(); g.arc(R + Math.cos(a) * d, R + Math.sin(a) * d, 0.4 + hash(n.id + 'sz' + i) * 0.8, 0, Math.PI * 2); g.fill();
    }
    const s = { c, R };
    this.sprites.set(key, s);
    return s;
  }

  /** Everything that does not move: background stars, realm regions, threads, nebulae and the lights of contributors. */
  paintBase() {
    if (!this.W) return;
    const g = this.base.getContext('2d'), { W, H } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // Background stars: still, deterministic.
    const count = Math.round((W * H) / 2600);
    for (let i = 0; i < count; i++) {
      const x = hash('bx' + i) * W, y = hash('by' + i) * H, s = hash('bs' + i);
      g.fillStyle = `rgba(${s > 0.93 ? '255,236,210' : '220,230,255'},${0.08 + s * 0.42})`;
      g.fillRect(x, y, s > 0.97 ? 1.6 : 1, s > 0.97 ? 1.6 : 1);
    }
    // Realm regions: a soft wash of colour and a quiet name.
    for (const [, r] of this.realmPos) {
      const grd = g.createRadialGradient(r.x, r.y, 0, r.x, r.y, 170);
      const rgb = hexRgb(r.c);
      grd.addColorStop(0, `rgba(${rgb},0.07)`); grd.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grd; g.beginPath(); g.arc(r.x, r.y, 170, 0, Math.PI * 2); g.fill();
    }
    g.font = '500 10.5px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    if (W > 720) for (const [, r] of this.realmPos) { g.fillStyle = `rgba(${hexRgb(r.c)},0.55)`; g.fillText(r.name.toUpperCase().split('').join(' '), r.x, r.y + 118); }
    // Threads: real links in the knowledge graph. Bridges between realms are bright.
    for (const t of this.threads) {
      const { A, B } = t;
      const mx = (A.x + B.x) / 2 + (A.y - B.y) * 0.18, my = (A.y + B.y) / 2 + (B.x - A.x) * 0.18;
      g.lineWidth = t.bridge ? 1.6 : 0.9;
      if (t.bridge) {
        const grd = g.createLinearGradient(A.x, A.y, B.x, B.y);
        grd.addColorStop(0, A.c); grd.addColorStop(0.5, '#ffffff'); grd.addColorStop(1, B.c);
        g.strokeStyle = grd; g.globalAlpha = 0.85; g.shadowColor = '#fff'; g.shadowBlur = 8;
      } else { g.strokeStyle = 'rgba(170,190,230,1)'; g.globalAlpha = Math.min(0.32, 0.07 + t.weight * 0.04); g.shadowBlur = 0; }
      g.beginPath(); g.moveTo(A.x, A.y); g.quadraticCurveTo(mx, my, B.x, B.y); g.stroke();
      g.globalAlpha = 1; g.shadowBlur = 0;
      t.mid = { x: 0.25 * A.x + 0.5 * mx + 0.25 * B.x, y: 0.25 * A.y + 0.5 * my + 0.25 * B.y };
    }
    g.globalCompositeOperation = 'lighter';
    for (const n of this.nebulae) { const s = this.sprite(n); g.drawImage(s.c, n.x - s.R, n.y - s.R, s.R * 2, s.R * 2); }
    g.globalCompositeOperation = 'source-over';
    // The lights of the people (amber) and agents (blue) working here.
    for (const n of this.nebulae) {
      const lights = [...Array(Math.min(n.activity.agents, 16)).fill(0), ...Array(Math.min(n.activity.humans, 12)).fill(1)];
      lights.forEach((human, i) => {
        const a = hash(n.id + 'L' + i) * Math.PI * 2, d = n.r * (0.55 + 0.75 * hash(n.id + 'Ld' + i));
        dot(g, n.x + Math.cos(a) * d, n.y + Math.sin(a) * d * 0.85, human ? '#ffc46b' : '#7cc4ff', human ? 2.2 : 1.6);
      });
    }
  }

  draw(now = performance.now()) {
    if (!this.W) return;
    const g = this.ctx, { W, H } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (this.fly) {
      const k = Math.min(1, (now - this.fly.t) / 650), e = 1 - Math.pow(1 - k, 3);
      const s = 1 + e * 3.2;
      g.save(); g.translate(W / 2, H / 2); g.scale(s, s); g.translate(-(W / 2 + (this.fly.n.x - W / 2) * e), -(H / 2 + (this.fly.n.y - H / 2) * e));
      g.globalAlpha = 1 - e * 0.85;
      g.drawImage(this.base, 0, 0, W, H);
      g.restore();
      if (k >= 1) { const n = this.fly.n; this.fly = null; this.onOpen?.(n); return; }
      this.raf = requestAnimationFrame((t) => this.draw(t));
      return;
    }
    g.drawImage(this.base, 0, 0, W, H);
    if (this.hover) {
      const n = this.hover;
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
      g.setLineDash([2, 5]); g.beginPath(); g.arc(n.x, n.y, n.r * 1.05, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    // Real events only.
    this.anims = this.anims.filter((a) => now - a.t < a.dur);
    for (const a of this.anims) {
      const k = (now - a.t) / a.dur;
      if (a.type === 'pulse') {
        g.strokeStyle = `rgba(${hexRgb(a.c)},${(1 - k) * 0.8})`; g.lineWidth = 1.6;
        g.beginPath(); g.arc(a.n.x, a.n.y, a.n.r * (0.6 + k * 1.3), 0, Math.PI * 2); g.stroke();
        g.fillStyle = `rgba(255,255,255,${(1 - k) * 0.25})`; g.beginPath(); g.arc(a.n.x, a.n.y, a.n.r * 0.4, 0, Math.PI * 2); g.fill();
      } else if (a.type === 'travel') {
        const e = 1 - Math.pow(1 - k, 2);
        const x = a.from.x + (a.n.x - a.from.x) * e, y = a.from.y + (a.n.y - a.from.y) * e;
        g.strokeStyle = `rgba(${hexRgb(a.c)},${0.35 * (1 - k)})`; g.lineWidth = 1;
        g.beginPath(); g.moveTo(a.from.x + (a.n.x - a.from.x) * Math.max(0, e - 0.18), a.from.y + (a.n.y - a.from.y) * Math.max(0, e - 0.18)); g.lineTo(x, y); g.stroke();
        dot(g, x, y, a.c, 2.4);
      }
    }
    if (this.anims.length) this.raf = requestAnimationFrame((t) => this.draw(t));
  }

  /** A real record landed. Checkpoints pulse; other contributions travel in as a light. */
  event(ev) {
    const n = this.nebulae.find((x) => x.id === ev.root);
    if (!n) return;
    if (ev.newOperator) { n.activity[ev.by === 'human' ? 'humans' : 'agents']++; }
    n.activity.total++;
    const c = ev.by === 'human' ? '#ffc46b' : '#7cc4ff';
    if (this.reduceMotion()) { this.paintBase(); this.draw(); return; }
    if (ev.kind === 'checkpoint') this.anims.push({ type: 'pulse', n, c: '#ffffff', t: performance.now(), dur: 1600 });
    else {
      const a = hash(ev.id) * Math.PI * 2;
      this.anims.push({ type: 'travel', n, c, from: { x: n.x + Math.cos(a) * n.r * 3, y: n.y + Math.sin(a) * n.r * 2.4 }, t: performance.now(), dur: 1300 });
    }
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.draw(t));
    clearTimeout(this.repaint); this.repaint = setTimeout(() => { this.paintBase(); this.draw(); }, 1700);
  }

  hit(x, y) { return this.nebulae.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < (n.r * 0.9) ** 2) ?? null; }
  move(x, y) {
    const n = x < 0 ? null : this.hit(x, y);
    this.canvas.style.cursor = n ? 'pointer' : 'default';
    if (n !== this.hover) { this.hover = n; if (!this.anims.length) this.draw(); }
    this.onHover?.(n, x, y);
  }
  open(n) {
    if (this.reduceMotion()) { this.onOpen?.(n); return; }
    this.fly = { n, t: performance.now() };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.draw(t));
  }
}

function hexRgb(h) { const v = h.replace('#', ''); const n = parseInt(v.length === 3 ? v.split('').map((x) => x + x).join('') : v, 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; }
function dot(g, x, y, c, r) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r * 4);
  grd.addColorStop(0, c); grd.addColorStop(0.25, c + 'aa'); grd.addColorStop(1, c + '00');
  g.fillStyle = grd; g.beginPath(); g.arc(x, y, r * 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r * 0.45, 0, Math.PI * 2); g.fill();
}
