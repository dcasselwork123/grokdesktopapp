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
        return 2.4;
      case "speaking":
        return 3.2;
      case "confirm":
        return 2.8;
      case "building":
        return 3.6;
      default:
        return orb.on ? 1.35 : 0.45;
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

  function draw() {
    const ctx = orb.ctx;
    const c = orb.canvas;
    if (!ctx || !c) return;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2 + orb.nx * w * 0.08;
    const cy = h / 2 + orb.ny * h * 0.08;
    const t = orb.t;
    const on = orb.on;
    const pulse =
      orb.phase === "listening"
        ? 1 + 0.08 * Math.sin(t * 6)
        : orb.phase === "confirm"
          ? 1 + 0.1 * Math.sin(t * 5)
          : orb.phase === "building"
            ? 1 + 0.07 * Math.sin(t * 8)
            : 1 + 0.03 * Math.sin(t * 2);
    const r = (Math.min(w, h) / 2) * (on ? 0.86 : 0.74) * pulse;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.35 + orb.nx * 0.4);

    const g = ctx.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.1, 0, 0, r);
    if (orb.phase === "building") {
      g.addColorStop(0, "rgba(255, 210, 140, 0.95)");
      g.addColorStop(0.45, "rgba(224, 80, 90, 0.9)");
      g.addColorStop(1, "rgba(20, 160, 190, 0.2)");
    } else if (on) {
      g.addColorStop(0, "rgba(255, 120, 130, 0.95)");
      g.addColorStop(0.4, "rgba(230, 50, 80, 0.88)");
      g.addColorStop(0.72, "rgba(40, 190, 210, 0.7)");
      g.addColorStop(1, "rgba(20, 80, 140, 0.15)");
    } else {
      g.addColorStop(0, "rgba(230, 110, 120, 0.9)");
      g.addColorStop(0.5, "rgba(170, 45, 70, 0.85)");
      g.addColorStop(1, "rgba(30, 130, 160, 0.45)");
    }

    blobPath(ctx, r, t);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.globalCompositeOperation = "lighter";
    const shine = ctx.createRadialGradient(-r * 0.35, -r * 0.4, 0, -r * 0.2, -r * 0.2, r * 0.7);
    shine.addColorStop(0, orb.phase === "speaking" ? "rgba(180, 255, 255, 0.55)" : "rgba(255, 220, 230, 0.35)");
    shine.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = shine;
    ctx.beginPath();
    ctx.arc(-r * 0.15, -r * 0.2, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function blobPath(ctx, r, t) {
    ctx.beginPath();
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wobble =
        0.08 * Math.sin(a * 3 + t * 1.7) + 0.05 * Math.sin(a * 5 - t * 1.1);
      const rr = r * (1 + wobble);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  window.VoiceOrb = { mount, setState, setCursor };
})();
