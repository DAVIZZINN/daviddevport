/* David Dev · céu interativo: galáxia que gira com a rolagem, o seu D virando constelação, estrelas cadentes.
   Roda num trabalhador separado do navegador (Web Worker), sem disputar o processador com a página.
   Em navegador sem suporte, o mesmo código desenha na própria página. */
(function (G) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (e0, e1, p) => { const t = clamp((p - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

  // os vértices do logo D (as duas peças), em coordenadas de 0 a 600
  const LOGO = [
    [[100, 140], [245, 86], [238, 410], [262, 412], [260, 498], [82, 486]],
    [[262, 108], [448, 46], [505, 96], [508, 372], [452, 428], [258, 455], [256, 410], [398, 400], [400, 140], [292, 148], [290, 186], [266, 190]]
  ];

  function makeCanvas(w, h) {
    if (typeof document !== 'undefined') { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
    return new OffscreenCanvas(w, h);
  }

  function createSky(canvas, notify) {
    const ctx = canvas.getContext('2d');
    const raf = G.requestAnimationFrame ? G.requestAnimationFrame.bind(G) : fn => setTimeout(() => fn(performance.now()), 16);
    const caf = G.cancelAnimationFrame ? G.cancelAnimationFrame.bind(G) : clearTimeout;

    // o que a página conta para o céu: tamanho da tela, rolagem, ponteiro, brilho e se deve desenhar
    const S = { w: 0, h: 0, y: 0, max: 0, px: 0, py: 0, cx: 0, cy: 0, drag: 0, on: false, alpha: 1, coarse: false, run: false };
    let parts = [], tiles = [], cons = [];
    const shocks = [], meteors = [];
    let rafId = null, last = 0, clock = 0, frame = 0, acc = 0, vel = 0, skyY = null, lastSY = null;
    // se o aparelho estiver lento, o céu se adapta: menos estrelas e meio ritmo de atualização
    let ema = 16.7, low = false, skip = false, busyUntil = 0;
    // com a pessoa parada, o céu desenha 1 a cada 3 quadros; ao mexer o mouse, rolar ou tocar, volta ao ritmo cheio
    const wake = () => { busyUntil = performance.now() + 1500; };

    // um carimbo de brilho desenhado uma vez: cada estrela vira um drawImage barato em vez de um círculo novo
    const glow = makeCanvas(32, 32);
    (() => {
      const g = glow.getContext('2d');
      const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.12, 'rgba(235,242,255,.95)');
      rg.addColorStop(0.3, 'rgba(200,220,255,.28)');
      rg.addColorStop(1, 'rgba(200,220,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, 32, 32);
    })();

    function build() {
      const SW = S.w, SH = S.h;
      canvas.width = SW;
      canvas.height = SH;
      // estrelas soltas espalhadas num disco que cobre a tela inteira, para a galáxia poder girar sem buracos
      const r = rng(77);
      const n = Math.round((SW < 760 ? 60 : 160) * (low ? 0.6 : 1));
      const R = Math.hypot(SW, SH) * 0.56;
      parts = [];
      for (let i = 0; i < n; i++) {
        const rad = Math.sqrt(r()) * R, ang = r() * 6.283;
        parts.push({ rad, ang, x: SW / 2 + Math.cos(ang) * rad, y: SH / 2 + Math.sin(ang) * rad, vx: 0, vy: 0, size: 0.5 + r() * 1.3, a: 0.35 + r() * 0.55, ph: r() * 6.283, sp: 0.4 + r() * 1.1 });
      }
      // três profundidades de estrelas fixas, do tamanho da tela, que se repetem enquanto a página anda
      const rt = rng(11);
      const few = SW < 760 ? 0.5 : 1;
      const mk = (n, sMin, sMax, aMin, aMax) => Array.from({ length: Math.round(n * few) }, () => ({ x: rt() * SW, y: rt() * SH, s: sMin + rt() * (sMax - sMin), a: aMin + rt() * (aMax - aMin), ph: rt() * 6.283 }));
      tiles = [
        { list: mk(170, 0.3, 0.75, 0.25, 0.75), speed: 0.025, shift: 7 },
        { list: mk(95, 0.55, 1.1, 0.4, 0.9), speed: 0.07, shift: 16 },
        { list: mk(34, 0.9, 1.7, 0.6, 1), speed: 0.15, shift: 30, glow: true }
      ];
      // as duas camadas distantes não piscam: são pré-desenhadas uma vez numa imagem e só deslizam a cada quadro
      tiles.forEach(L => {
        if (L.glow) return;
        const cv = makeCanvas(SW, SH);
        const g = cv.getContext('2d');
        g.fillStyle = '#E6EEFF';
        for (const st of L.list) { g.globalAlpha = st.a; g.fillRect(st.x - st.s, st.y - st.s, st.s * 2, st.s * 2); }
        L.img = cv;
      });
      // a constelação: cada vértice começa num ponto qualquer do céu e vai para o seu lugar no D
      // no computador o D termina no espaço livre embaixo das camadas da chamada final; no celular, no alto da tela
      const wide = SW >= 981;
      const Sz = wide ? Math.min(SH * 0.3, SW * 0.19, 250) : Math.min(SW * 0.5, 220);
      const cx = wide ? SW * 0.235 : SW * 0.5, cy = SH * (wide ? 0.575 : 0.24);
      const rc = rng(91);
      cons = LOGO.map(poly => poly.map(([vx, vy]) => ({
        sx: rc() * SW, sy: rc() * SH,
        tx: cx + (vx - 300) / 600 * Sz, ty: cy + (vy - 300) / 600 * Sz,
        ph: rc() * 6.283
      })));
    }

    function drawGlowDot(x, y, size, alpha) {
      const g = size * 5;
      ctx.globalAlpha = alpha;
      ctx.drawImage(glow, x - g, y - g, g * 2, g * 2);
    }

    function tick(now) {
      frame++;
      const busy = now < busyUntil || shocks.length > 0 || meteors.length > 0 || Math.abs(vel) > 0.5;
      if (!busy && frame % 3 !== 0) { rafId = raf(tick); return; }
      if ((low || S.coarse) && busy) {
        skip = !skip;
        if (skip) { rafId = raf(tick); return; }
      }
      const dt = Math.min(50, now - (last || now));
      last = now;
      if (busy) ema = ema * 0.95 + dt * 0.05;
      if (!low && clock > 3000 && ema > 26) { low = true; parts.length = Math.round(parts.length * 0.6); notify({ t: 'low' }); }
      clock += dt;
      const f = dt / 16.667;
      const SW = S.w, SH = S.h, sAlpha = S.alpha;
      ctx.clearRect(0, 0, SW, SH);
      const pg = S.max > 0 ? clamp(S.y / S.max, 0, 1) : 0;
      if (skyY === null) skyY = lastSY = S.y;
      const dy = S.y - skyY;
      skyY = S.y;
      // a rolagem dá impulso: as estrelas de perto deixam um rastro como numa viagem
      vel += clamp(S.y - lastSY, -160, 160) * 0.35;
      lastSY = S.y;
      // a galáxia gira devagar sozinha e bem mais quando a pessoa rola
      const theta = S.y * 0.00016 + clock * 0.000006;
      const R = SW < 760 ? 110 : 150, R2 = R * R;
      const damp = Math.pow(0.88, f);
      for (let s = shocks.length - 1; s >= 0; s--) if ((now - shocks[s].t0) > 1300) shocks.splice(s, 1);
      // estrelas fixas: andam com a rolagem (as de perto mais rápido), deslizam ao contrário do mouse
      vel *= Math.pow(0.9, f);
      const kk = 1 + S.drag * 1.6;
      const trail = clamp((Math.abs(vel) - 6) / 50, 0, 0.75);
      ctx.fillStyle = '#E6EEFF';
      for (const L of tiles) {
        const ox = -S.cx * L.shift * kk, oy = -S.y * L.speed - S.cy * L.shift * kk;
        if (L.img) {
          let x0 = ox % SW; if (x0 > 0) x0 -= SW;
          let y0 = oy % SH; if (y0 > 0) y0 -= SH;
          ctx.globalAlpha = sAlpha;
          ctx.drawImage(L.img, x0, y0);
          ctx.drawImage(L.img, x0 + SW, y0);
          ctx.drawImage(L.img, x0, y0 + SH);
          ctx.drawImage(L.img, x0 + SW, y0 + SH);
          continue;
        }
        for (const st of L.list) {
          let x = (st.x + ox) % SW; if (x < 0) x += SW;
          let y = (st.y + oy) % SH; if (y < 0) y += SH;
          if (L.glow) {
            drawGlowDot(x, y, st.s, st.a * (0.75 + 0.25 * Math.sin(now * 0.0012 + st.ph)) * sAlpha);
            if (trail > 0) {
              const len = st.s * 14 * trail / 0.75;
              ctx.globalAlpha = st.a * trail * 0.6 * sAlpha;
              ctx.fillRect(x - st.s * 0.45, vel > 0 ? y : y - len, st.s * 0.9, len);
            }
          } else {
            ctx.globalAlpha = st.a * sAlpha;
            ctx.fillRect(x - st.s, y - st.s, st.s * 2, st.s * 2);
          }
        }
      }
      ctx.fillStyle = '#DCE8FF';
      for (const p of parts) {
        const hx = SW / 2 + Math.cos(p.ang + theta) * p.rad;
        const hy = SH / 2 + Math.sin(p.ang + theta) * p.rad * 0.86;
        let ax = (hx - p.x) * 0.012, ay = (hy - p.y) * 0.012;
        if (S.on) {
          const ddx = p.x - S.px, ddy = p.y - S.py, d2 = ddx * ddx + ddy * ddy;
          if (d2 < R2) { const d = Math.sqrt(d2) || 1, k = (1 - d / R) ** 2 * 1.5; ax += ddx / d * k; ay += ddy / d * k; }
        }
        for (const sh of shocks) {
          const age = Math.max(0, (now - sh.t0) / 1000), rad = age * 620;
          const ddx = p.x - sh.x, ddy = p.y - sh.y, d = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          if (Math.abs(d - rad) < 46) { const k = (1 - age) * 1.8; ax += ddx / d * k; ay += ddy / d * k; }
        }
        p.vx = (p.vx + ax * f) * damp;
        p.vy = (p.vy + ay * f) * damp;
        p.x += p.vx * f;
        p.y += p.vy * f;
        if (p.x < -20 || p.x > SW + 20 || p.y < -20 || p.y > SH + 20) continue;
        const tw = 0.62 + 0.38 * Math.sin(now * 0.001 * p.sp + p.ph);
        if (p.size > 1.35) drawGlowDot(p.x, p.y, p.size, p.a * tw * sAlpha);
        else {
          ctx.globalAlpha = p.a * tw * sAlpha;
          ctx.fillRect(p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
        }
      }

      // o seu D se forma no céu conforme a página desce, e as linhas da constelação se desenham no fim
      const form = easeIO(sstep(0.04, 0.82, pg));
      const lines = sstep(0.4, 0.94, pg);
      const done = sstep(0.9, 1, pg);
      const conAlpha = Math.max(sAlpha, 0.55 + done * 0.45);
      const pts = cons.map(poly => poly.map(v => ({
        x: lerp(v.sx, v.tx, form) + Math.sin(now * 0.0011 + v.ph) * 1.2 * (1 - form * 0.6),
        y: lerp(v.sy, v.ty, form) + Math.cos(now * 0.0013 + v.ph) * 1.2 * (1 - form * 0.6),
        ph: v.ph
      })));
      if (lines > 0) {
        const total = pts.reduce((n, poly) => n + poly.length, 0);
        let budget = lines * total;
        ctx.strokeStyle = '#8AB2FF';
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = (0.22 + done * (0.2 + 0.08 * Math.sin(now * 0.002))) * conAlpha;
        ctx.beginPath();
        for (const poly of pts) {
          for (let i = 0; i < poly.length && budget > 0; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const k = Math.min(1, budget);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
            budget -= 1;
          }
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#E6EEFF';
      for (const poly of pts) {
        for (const v of poly) {
          const tw = 0.7 + 0.3 * Math.sin(now * 0.0017 + v.ph);
          drawGlowDot(v.x, v.y, 1.1 + form * 0.6 + done * 0.4, (0.35 + form * 0.6) * tw * conAlpha);
        }
      }

      // estrelas cadentes: a cada trecho rolado, uma risca o céu
      acc += Math.abs(dy);
      if (acc > 1100 && meteors.length < 3) {
        acc = 0;
        const ang = (150 + Math.random() * 14) * Math.PI / 180;
        meteors.push({ x: SW * (0.35 + Math.random() * 0.6), y: SH * (0.04 + Math.random() * 0.36), ang, len: 140 + Math.random() * 120, t0: now });
      }
      for (let m = meteors.length - 1; m >= 0; m--) {
        const mt = meteors[m];
        const age = (now - mt.t0) / 1000;
        if (age > 0.9) { meteors.splice(m, 1); continue; }
        if (age < 0) continue;
        const dist = age * 950;
        const hx = mt.x + Math.cos(mt.ang) * dist, hy = mt.y + Math.sin(mt.ang) * dist;
        const tx = hx - Math.cos(mt.ang) * mt.len, ty = hy - Math.sin(mt.ang) * mt.len;
        const gr = ctx.createLinearGradient(tx, ty, hx, hy);
        gr.addColorStop(0, 'rgba(190,215,255,0)');
        gr.addColorStop(1, 'rgba(225,236,255,1)');
        ctx.globalAlpha = (age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.75) * 0.9;
        ctx.strokeStyle = gr;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }

      // um clique (ou toque) manda uma onda pelo céu
      for (const sh of shocks) {
        const age = (now - sh.t0) / 1000;
        if (age <= 0 || age > 1.1) continue;
        ctx.globalAlpha = 0.28 * (1 - age / 1.1) * sAlpha;
        ctx.strokeStyle = '#8AB2FF';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, age * 620, 0, 6.283);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      rafId = raf(tick);
    }

    function start() { S.run = true; if (rafId === null && S.w) { last = 0; rafId = raf(tick); } }
    function stop() { S.run = false; if (rafId !== null) { caf(rafId); rafId = null; } ctx.clearRect(0, 0, S.w, S.h); }

    function msg(m) {
      switch (m.t) {
        case 'size': S.w = m.w; S.h = m.h; build(); if (S.run) start(); break;
        case 'scroll': S.y = m.y; if (m.max !== undefined) S.max = m.max; wake(); break;
        case 'ptr': S.px = m.x; S.py = m.y; S.cx = m.cx; S.cy = m.cy; S.drag = m.drag; S.on = m.on; wake(); break;
        case 'shock': shocks.push({ x: m.x, y: m.y, t0: performance.now() }); if (shocks.length > 4) shocks.shift(); wake(); break;
        case 'alpha': S.alpha = m.a; break;
        case 'coarse': S.coarse = m.on; break;
        case 'run': if (m.on) start(); else stop(); break;
      }
    }
    return { msg };
  }

  if (typeof window === 'undefined') {
    // dentro do trabalhador: a página manda o canvas e depois só mensagens curtas
    let sky = null;
    G.onmessage = e => {
      const m = e.data;
      if (m.t === 'init') { sky = createSky(m.canvas, d => G.postMessage(d)); G.postMessage({ t: 'ready' }); return; }
      if (sky) sky.msg(m);
    };
  } else {
    G.DDSky = createSky;
  }
})(self);
