"use strict";

(() => {
  const orb = {
    canvas: null,
    ctx: null,
    on: false,
    phase: "idle",
    nx: 0,
    ny: 0,
    tx: 0,
    ty: 0,
    t: 0,
    raf: 0,
    last: 0,
  };

  const particles = buildParticles();

  function fract(n) {
    return n - Math.floor(n);
  }

  function hash(i) {
    return fract(Math.sin(i * 127.1 + 311.7) * 43758.5453);
  }

  function buildParticles() {
    const list = [];
    for (let band = 0; band < 2; band++) {
      for (let i = 0; i < 70; i++) {
        const seed = band * 1000 + i;
        const u = i / 69;
        const head = Math.max(0, 1 - u * 1.15);
        list.push({
          band,
          u,
          dr: (hash(seed) - 0.5) * (0.04 + 0.12 * head),
          da: (hash(seed + 17) - 0.5) * (0.05 + 0.08 * head),
          size: 0.32 + hash(seed + 31) * (0.35 + 0.55 * head),
          bright: 0.3 + hash(seed + 47) * 0.7,
          tw: hash(seed + 61) * Math.PI * 2,
        });
      }
      for (let i = 0; i < 14; i++) {
        const seed = band * 2000 + i + 400;
        const ang = hash(seed) * Math.PI * 2;
        const rad = Math.sqrt(hash(seed + 3)) * 0.1;
        list.push({
          band,
          u: hash(seed + 5) * 0.08,
          dr: Math.cos(ang) * rad,
          da: Math.sin(ang) * rad * 0.7,
          size: 0.45 + hash(seed + 7) * 0.55,
          bright: 0.55 + hash(seed + 9) * 0.4,
          tw: hash(seed + 11) * Math.PI * 2,
        });
      }
      for (let i = 0; i < 24; i++) {
        const seed = band * 3000 + i + 800;
        const u = 0.2 + hash(seed) * 0.8;
        list.push({
          band,
          u,
          dr: (hash(seed + 1) - 0.5) * 0.16,
          da: (hash(seed + 2) - 0.5) * 0.14,
          size: 0.1 + hash(seed + 3) * 0.28,
          bright: 0.12 + hash(seed + 4) * 0.38,
          tw: hash(seed + 6) * Math.PI * 2,
        });
      }
    }
    return list;
  }

  function mount(canvas) {
    if (!canvas || !canvas.getContext) return;
    orb.canvas = canvas;
    orb.ctx = canvas.getContext("2d");
    syncDpr();
    if (!orb.raf) loop(0);
    if (!mount._vis) {
      mount._vis = true;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          if (orb.raf) cancelAnimationFrame(orb.raf);
          orb.raf = 0;
        } else if (!orb.raf) {
          orb.last = 0;
          loop(0);
        }
      });
      window.addEventListener("resize", syncDpr);
    }
  }

  function syncDpr() {
    const c = orb.canvas;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = c.clientWidth || 40;
    const px = Math.max(1, Math.round(css * dpr));
    if (c.width !== px || c.height !== px) {
      c.width = px;
      c.height = px;
    }
  }

  function setState(next) {
    if (!next) return;
    if (typeof next.on === "boolean") orb.on = next.on;
    if (next.phase) orb.phase = next.phase;
  }

  function setCursor(nx, ny) {
    const x = Number(nx);
    const y = Number(ny);
    orb.tx = Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
    orb.ty = Math.max(-1, Math.min(1, Number.isFinite(y) ? y : 0));
  }

  function phaseSpeed() {
    switch (orb.phase) {
      case "listening":
        return 2.2;
      case "speaking":
        return 3.0;
      case "confirm":
        return 2.6;
      case "building":
        return 3.4;
      default:
        return orb.on ? 1.2 : 0.42;
    }
  }

  function loop(now) {
    if (document.hidden) {
      orb.raf = 0;
      return;
    }
    orb.raf = requestAnimationFrame(loop);
    const dt = orb.last ? Math.min(0.05, (now - orb.last) / 1000) : 0.016;
    orb.last = now;
    orb.t += dt * phaseSpeed();
    orb.nx += (orb.tx - orb.nx) * Math.min(1, dt * 8);
    orb.ny += (orb.ty - orb.ny) * Math.min(1, dt * 8);
    draw();
  }

  function phasePulse() {
    switch (orb.phase) {
      case "listening":
        return 1 + 0.055 * Math.sin(orb.t * 6);
      case "confirm":
        return 1 + 0.07 * Math.sin(orb.t * 5);
      case "building":
        return 1 + 0.05 * Math.sin(orb.t * 8);
      case "speaking":
        return 1 + 0.04 * Math.sin(orb.t * 4);
      default:
        return 1 + 0.02 * Math.sin(orb.t * 2);
    }
  }

  function drawTrailPath(ctx, rx, ry, headAngle, span) {
    ctx.beginPath();
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const a = headAngle - u * span;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function drawTaperedTrail(ctx, rx, ry, headAngle, span, rgb, width, alpha) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha * 0.55 + ")";
    ctx.lineWidth = width * 0.9;
    ctx.shadowColor = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + Math.min(1, alpha + 0.15) + ")";
    ctx.shadowBlur = width * 1.6;
    drawTrailPath(ctx, rx, ry, headAngle, span);
    ctx.stroke();
    ctx.shadowBlur = 0;
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const u0 = i / steps;
      const u1 = (i + 1) / steps;
      const fade = Math.pow(1 - u0, 0.65);
      const a0 = headAngle - u0 * span;
      const a1 = headAngle - u1 * span;
      ctx.strokeStyle = "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha * fade + ")";
      ctx.lineWidth = width * (0.5 + 0.5 * fade);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a0) * rx, Math.sin(a0) * ry);
      ctx.lineTo(Math.cos(a1) * rx, Math.sin(a1) * ry);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    const ctx = orb.ctx;
    const c = orb.canvas;
    if (!ctx || !c) return;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);

    const on = orb.on;
    const radius = Math.min(w, h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = on ? "#050508" : "#08080d";
    ctx.fill();

    const cx = w / 2 + orb.nx * w * 0.04;
    const cy = h / 2 + orb.ny * h * 0.04;
    const t = orb.t;
    const pulse = phasePulse();
    const scale = Math.min(w, h);
    const R = radius * 0.74 * pulse;
    const rx = R * 0.92;
    const ry = R * 0.8;
    const span = Math.PI * 1.12;
    const orangeHead = 0.18;
    const blueHead = Math.PI + 0.18;
    const dim = on ? 1 : 0.72;

    ctx.translate(cx, cy);
    ctx.rotate(t * 0.48 + orb.nx * 0.28);
    ctx.globalCompositeOperation = "lighter";

    const orange = orb.phase === "building" ? [255, 170, 70] : [255, 96, 42];
    const blue = orb.phase === "speaking" ? [90, 230, 255] : [48, 158, 255];
    drawTaperedTrail(ctx, rx, ry, orangeHead, span, orange, R * 0.2, (on ? 0.58 : 0.36) * dim);
    drawTaperedTrail(ctx, rx, ry, blueHead, span, blue, R * 0.2, (on ? 0.58 : 0.36) * dim);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const headA = p.band === 0 ? orangeHead : blueHead;
      const a = headA - p.u * span + p.da;
      const rad = 1 + p.dr;
      const x = Math.cos(a) * rx * rad;
      const y = Math.sin(a) * ry * rad;
      const fade = 0.35 + 0.65 * Math.pow(1 - p.u, 0.7);
      const twinkle = 0.78 + 0.22 * Math.sin(t * 2.6 + p.tw);
      let cr;
      let cg;
      let cb;
      if (p.band === 0) {
        cr = 255;
        cg = 70 + 140 * Math.pow(1 - p.u, 0.8);
        cb = 28 + 32 * (1 - p.u);
        if (orb.phase === "building") {
          cg = 130 + 95 * (1 - p.u);
          cb = 40 + 16 * (1 - p.u);
        }
      } else {
        cr = 30 + 50 * (1 - p.u);
        cg = 125 + 95 * (1 - p.u);
        cb = 255;
        if (orb.phase === "speaking") {
          cr = 70 + 85 * (1 - p.u);
          cg = 210 + 30 * (1 - p.u);
        }
      }
      const alpha = fade * p.bright * twinkle * dim;
      const sz = p.size * (scale / 68) * (on ? 1.06 : 0.95);
      ctx.fillStyle = "rgba(" + (cr | 0) + "," + (cg | 0) + "," + (cb | 0) + "," + alpha * 0.22 + ")";
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.4, sz * 2.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(" + (cr | 0) + "," + (cg | 0) + "," + (cb | 0) + "," + Math.min(1, alpha) + ")";
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.3, sz * 0.68), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  window.VoiceOrb = { mount, setState, setCursor };
})();
