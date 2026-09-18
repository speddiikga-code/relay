/* Relay landing page: interactive orchestra, router ladder, tilting pipeline cards,
 * cost calculator, cloud-run and KakaoTalk simulations, confetti.
 * Uses the app's real engine (app/engine.js) for presets, prompts and routing. */
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  const E = window.Engine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const finePointer = !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
  const sleep = ms => new Promise(r => setTimeout(r, reduce ? Math.min(ms, 60) : ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };
  const oneLine = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return n && s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function h(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) [].concat(arguments[i]).forEach(k => { if (k != null && k !== false) n.append(k instanceof Node ? k : String(k)); });
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; }

  // ======================= Theme =======================
  const themeBtn = $('#theme-toggle');
  const THEMES = ['auto', 'light', 'dark'];
  let theme = store.get('relay.theme') || 'auto';
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    themeBtn.textContent = { auto: '◐', light: '☀', dark: '☾' }[theme];
    themeBtn.setAttribute('aria-label', 'Theme: ' + theme + ' (click to change)');
  }
  applyTheme();
  themeBtn.addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; store.set('relay.theme', theme); applyTheme(); });

  // ======================= Confetti =======================
  const cv = $('#confetti');
  const cx = cv.getContext('2d');
  const COLORS = ['#ff3d8b', '#ff7a1a', '#ffc233', '#6cc23a', '#00b8d4', '#2f6bff', '#8b5cf6'];
  let bits = [], raf = 0;
  function confetti(x, y, n) {
    if (reduce) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== innerWidth * dpr) { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < (n || 120); i++) {
      bits.push({ x, y, vx: rand(-7.5, 7.5), vy: rand(-12, -3), g: rand(.22, .38), w: rand(5, 11), hh: rand(3, 7), r: rand(0, 6.3), vr: rand(-.3, .3), c: COLORS[i % COLORS.length], life: 0 });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    cx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of bits) {
      p.vy += p.g; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life++;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r);
      cx.globalAlpha = Math.max(0, 1 - p.life / 120); cx.fillStyle = p.c;
      cx.fillRect(-p.w / 2, -p.hh / 2, p.w, p.hh); cx.restore();
    }
    bits = bits.filter(p => p.life < 120 && p.y < innerHeight + 40);
    if (bits.length) raf = requestAnimationFrame(tick);
    else { cx.clearRect(0, 0, innerWidth, innerHeight); raf = 0; }
  }
  const burstAt = el => { const r = el.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2); };

  // ======================= Shared pipeline data =======================
  const PROV = {
    claude: { name: 'Claude', color: 'var(--claude)' },
    gpt: { name: 'GPT', color: 'var(--gpt)' },
    gemini: { name: 'Gemini', color: 'var(--gemini)' },
    bedrock: { name: 'AWS', color: 'var(--bedrock)' },
    any: { name: 'Any API', color: 'var(--compat)' },
  };
  const ORDER = ['claude', 'gpt', 'gemini', 'bedrock', 'any'];
  const NORMAL = { 'claude-fast': 'claude', 'gpt-fast': 'gpt' };
  const META = {
    solo: { color: 'var(--orange)', calls: '1 call', flow: [['Claude', 'claude']] },
    compare: { color: 'var(--cyan)', calls: '2 calls', flow: [['Claude', 'claude'], '‖', ['GPT', 'gpt']] },
    relay: { color: 'var(--pink)', calls: '3 calls', flow: [['Draft', 'claude'], '→', ['Attack', 'gpt'], '→', ['Revise', 'claude']] },
    debate: { color: 'var(--violet)', calls: '5 calls', flow: [['Answer', 'claude'], '‖', ['Answer', 'gpt'], '→', ['Cross-examine', 'compat'], '→', ['Judge', 'claude']] },
    fanout: { color: 'var(--gpt)', calls: 'N + 3 calls', flow: [['Plan', 'claude'], '→', ['N workers', 'compat'], '→', ['Refute', 'gpt'], '→', ['Merge', 'claude']] },
    council: { color: 'var(--gemini)', calls: 'every AI + 1', flow: [['Every connected AI', 'all'], '→', ['Judge', 'claude']] },
    ultra: { color: 'rainbow', calls: 'N + 7 calls', flow: [['Plan', 'claude'], '→', ['Workers', 'compat'], '→', ['2 refuters', 'compat'], '→', ['Merge', 'claude'], '→', ['Attack', 'gpt'], '→', ['Fix', 'claude']] },
  };
  const KEYS = Object.keys(META).filter(k => E && E.PRESETS[k]);
  const colorOf = k => (META[k].color === 'rainbow' ? 'var(--pink)' : META[k].color);
  const isRainbow = k => META[k].color === 'rainbow';
  const CHIP = { claude: 'var(--claude)', gpt: 'var(--gpt)', compat: 'var(--compat)' };
  const appLink = (task, key) => 'app/?' + new URLSearchParams(Object.assign({ task: task || '' }, key ? { preset: key } : {}));

  if (!E) return; // engine failed to load: leave the static page as is

  // ======================= Orchestra =======================
  const orc = { mode: 'auto', enabled: new Set(ORDER), running: false, runId: 0, graph: null };
  const orchestra = $('#orchestra');
  const stage = $('#orc-stage');
  const svg = $('#orc-svg');
  const pop = $('#orc-pop');
  const taskInput = $('#orc-task');
  const runBtn = $('#orc-run');
  orchestra.append(pop); // position the popover against the whole card, not the scrolling stage

  const chosen = () => (orc.mode === 'auto' ? ((E.route(taskInput.value) || {}).preset || 'solo') : orc.mode);

  function renderPills() {
    const wrap = $('#orc-pills');
    wrap.textContent = '';
    const cur = chosen();
    const mk = (key, label, color, rainbow) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'pill' + (rainbow ? ' rainbow' : ''), 'aria-checked': String(orc.mode === key) }, label);
      b.style.setProperty('--pc', color);
      b.addEventListener('click', () => { orc.mode = key; refresh(); });
      return b;
    };
    const auto = mk('auto', '⚡ Auto', 'var(--violet)', true);
    if (orc.mode === 'auto') auto.append(h('span', { class: 'auto-tag' }, '→ ' + E.PRESETS[cur].name));
    wrap.append(auto);
    KEYS.forEach(k => wrap.append(mk(k, E.PRESETS[k].name, colorOf(k), isRainbow(k))));
  }

  function renderProviders() {
    const wrap = $('#orc-providers');
    wrap.textContent = '';
    ORDER.forEach(p => {
      const on = orc.enabled.has(p);
      const b = h('button', { type: 'button', class: 'prov-chip', 'aria-pressed': String(on), title: (on ? 'Disconnect ' : 'Connect ') + PROV[p].name }, PROV[p].name);
      b.style.setProperty('--pc', PROV[p].color);
      b.addEventListener('click', () => {
        if (on && orc.enabled.size === 1) { b.animate && !reduce && b.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], 200); return; }
        if (on) orc.enabled.delete(p); else orc.enabled.add(p);
        refresh();
      });
      wrap.append(b);
    });
  }

  function buildGraph(key) {
    const enabled = ORDER.filter(p => orc.enabled.has(p));
    const task = taskInput.value.trim() || 'your task';
    const cols = [[{ kind: 'task', label: 'Your task', sub: '⚡ ' + E.PRESETS[key].name, color: 'var(--text)' }]];
    let prev = []; // like the app: stand-ins avoid the previous stage's providers
    E.PRESETS[key].build().forEach((st, i) => {
      const wanted = [];
      st.models.forEach(m => { if (m === E.ALL) wanted.push(...enabled); else wanted.push(NORMAL[m] || m); });
      const base = st.type === 'map' ? Array.from({ length: 4 }, (_, j) => wanted[j % wanted.length])
        : st.type === 'agent' ? [wanted[0]] : wanted.filter((x, j) => wanted.indexOf(x) === j);
      const used = [], nodes = [];
      base.forEach(p => {
        let actual = p, standIn = false;
        if (!orc.enabled.has(p)) {
          actual = enabled.find(x => !used.includes(x) && !prev.includes(x)) || enabled.find(x => !used.includes(x)) || enabled[0];
          standIn = true;
        }
        if (st.type === 'parallel' && used.includes(actual)) return;
        used.push(actual);
        nodes.push({ kind: 'agent', slot: actual, label: PROV[actual].name, sub: standIn ? 'for ' + PROV[p].name : st.title, color: PROV[actual].color, standIn, wanted: p, stage: st, stageIndex: i + 1 });
      });
      prev = used;
      cols.push(nodes);
    });
    cols.push([{ kind: 'final', label: 'Final answer', sub: 'merged', color: 'var(--pink)' }]);
    return { key, cols, task, edges: [], nodes: [], scale: 1, vertical: false };
  }

  function render() {
    const g = orc.graph = buildGraph(chosen());
    svg.textContent = '';
    const cw = stage.clientWidth || 600;
    const vertical = g.vertical = cw < 560;
    const NW = vertical ? 104 : 120, NH = 46, P = 22;
    const n = g.cols.length, maxN = Math.max(...g.cols.map(c => c.length));
    let W, H;
    const pos = (i, j, len) => (vertical
      ? { x: W / 2 + (j - (len - 1) / 2) * 114, y: P + NH / 2 + i * 84 }
      : { x: P + NW / 2 + i * 150, y: H / 2 + (j - (len - 1) / 2) * 58 });
    if (vertical) { W = P * 2 + NW + (maxN - 1) * 114; H = P * 2 + NH + (n - 1) * 84; }
    else { W = P * 2 + NW + (n - 1) * 150; H = P * 2 + NH + (maxN - 1) * 58; }
    const scale = g.scale = Math.min(vertical ? 1 : 1.3, Math.max(cw / W, vertical ? .74 : .8));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = Math.round(W * scale) + 'px';
    svg.style.margin = W * scale < cw ? '0 auto' : '0';

    const gE = s('g', {}), gN = s('g', {}), gP = s('g', {});
    g.parts = gP;
    g.cols.forEach((col, i) => col.forEach((node, j) => { Object.assign(node, pos(i, j, col.length), { col: i }); g.nodes.push(node); }));
    for (let i = 1; i < n; i++) {
      for (const a of g.cols[i - 1]) for (const b of g.cols[i]) {
        const d = vertical
          ? `M${a.x} ${a.y + NH / 2} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y - NH / 2}`
          : `M${a.x + NW / 2} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x - NW / 2} ${b.y}`;
        const el = s('path', { d, class: 'edge' });
        el.style.stroke = b.color;
        gE.append(el);
        g.edges.push({ from: a, to: b, col: i, el });
      }
    }
    for (const node of g.nodes) {
      const grp = s('g', { class: 'onode' + (node.kind === 'final' ? ' final' : ''), tabindex: '0', role: 'button', 'data-state': 'idle',
        'aria-label': node.kind === 'agent' ? `${node.label}: ${node.stage.title}. Show its instructions` : node.label });
      grp.style.setProperty('--nc', node.color);
      const ring = s('rect', { class: 'ring', x: node.x - NW / 2 - 4, y: node.y - NH / 2 - 4, width: NW + 8, height: NH + 8, rx: 15 });
      ring.style.stroke = node.color;
      const rect = s('rect', { x: node.x - NW / 2, y: node.y - NH / 2, width: NW, height: NH, rx: 12 });
      rect.style.stroke = node.color;
      const t1 = s('text', { class: 'n1', x: node.x, y: node.y - 3 }); t1.textContent = node.label;
      const t2 = s('text', { class: 'n2' + (node.standIn ? ' standin' : ''), x: node.x, y: node.y + 13 }); t2.textContent = oneLine(node.sub, 17);
      const badge = s('circle', { class: 'badge', cx: node.x + NW / 2 - 3, cy: node.y - NH / 2 + 3, r: 8 });
      const check = s('text', { class: 'check', x: node.x + NW / 2 - 3, y: node.y - NH / 2 + 7 }); check.textContent = '✓';
      grp.append(ring, rect, t1, t2, badge, check);
      grp.addEventListener('click', e => { e.stopPropagation(); showPop(node); });
      grp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPop(node); } });
      node.el = grp;
      gN.append(grp);
    }
    svg.append(gE, gN, gP);
  }

  const setState = (node, st) => node.el && node.el.setAttribute('data-state', st);

  function showPop(node) {
    const g = orc.graph;
    const name = E.PRESETS[g.key].name;
    pop.textContent = '';
    pop.style.setProperty('--nc', node.color);
    let title, meta, body;
    if (node.kind === 'task') {
      title = 'Your task'; meta = `Routed to ${name}${orc.mode === 'auto' ? ' by ⚡ Kickstart' : ''}`; body = g.task;
    } else if (node.kind === 'final') {
      title = 'Final answer'; meta = 'What you get back';
      body = "The last stage's output. In the app it streams live, with Copy, Download .md and a one-tap KakaoTalk button.";
    } else {
      const st = node.stage;
      title = `${node.label} · ${st.title}`;
      meta = `Stage s${node.stageIndex} · ${E.TYPES[st.type]}` + (node.standIn ? ` · stands in for ${PROV[node.wanted].name}, which isn't connected` : '');
      const vars = { task: g.task, prev: '‹previous stage output›', maxItems: 12, item: '‹one subtask from the plan›', index: 1, count: 4 };
      for (let k = 1; k <= 7; k++) vars['s' + k] = `‹stage ${k} output›`;
      body = (st.system ? 'System: ' + st.system + '\n\n' : '') + E.render(st.prompt, vars);
    }
    pop.append(
      h('button', { type: 'button', class: 'x', 'aria-label': 'Close', onclick: hidePop }, '×'),
      h('h4', {}, title), h('div', { class: 'meta' }, meta), h('pre', {}, body.slice(0, 900)));
    pop.hidden = false;
    const or = orchestra.getBoundingClientRect(), nr = node.el.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = nr.left - or.left + nr.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, or.width - pw - 8));
    let top = nr.bottom - or.top + 8;
    if (top + ph > or.height - 8) top = Math.max(8, nr.top - or.top - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function hidePop() { pop.hidden = true; }
  document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) hidePop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePop(); });

  function flow(edges, g) {
    edges.forEach(e => e.el.classList.add('hot'));
    if (reduce) return sleep(60).then(() => edges.forEach(e => e.el.classList.remove('hot')));
    const dur = 620;
    return new Promise(res => {
      const parts = [];
      edges.forEach((e, k) => {
        const len = e.el.getTotalLength();
        for (let q = 0; q < 2; q++) {
          const c = s('circle', { r: 4.5, class: 'particle' });
          c.style.fill = e.to.color;
          g.parts.append(c);
          parts.push({ c, e, len, delay: q * 150 + (k % 4) * 35 });
        }
      });
      const t0 = performance.now();
      (function step(t) {
        let alive = false;
        for (const p of parts) {
          const u = Math.min(1, Math.max(0, (t - t0 - p.delay) / dur));
          const eased = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          const pt = p.e.el.getPointAtLength(p.len * eased);
          p.c.setAttribute('cx', pt.x); p.c.setAttribute('cy', pt.y);
          p.c.style.opacity = u >= 1 ? 0 : 1;
          if (u < 1) alive = true;
        }
        if (alive) requestAnimationFrame(step);
        else { parts.forEach(p => p.c.remove()); edges.forEach(e => e.el.classList.remove('hot')); res(); }
      })(t0);
    });
  }

  function focusCol(g, i) {
    if (g.vertical || stage.scrollWidth <= stage.clientWidth + 4) return;
    const x = g.cols[i][0].x * g.scale;
    stage.scrollTo({ left: Math.max(0, x - stage.clientWidth / 2), behavior: reduce ? 'auto' : 'smooth' });
  }

  function bump(sel, value) {
    const el = $(sel);
    el.textContent = typeof value === 'number' ? value.toLocaleString() : value;
    if (!reduce && el.animate) el.animate([{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], 260);
  }

  function log(text, color) {
    const ul = $('#orc-log');
    const li = h('li', {}, text);
    li.style.setProperty('--lc', color || 'var(--muted)');
    ul.append(li);
    while (ul.children.length > 5) ul.firstChild.remove();
  }

  function resetRunUi() {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run';
  }

  async function run() {
    if (orc.running) return;
    hidePop();
    render();
    const g = orc.graph, id = ++orc.runId;
    const name = E.PRESETS[g.key].name;
    orc.running = true;
    runBtn.disabled = true;
    runBtn.textContent = '● Running…';
    $('#orc-final').hidden = true;
    $('#orc-log').textContent = '';
    bump('#st-calls', 0); bump('#st-tokens', 0);
    let calls = 0, tokens = 0;
    const t0 = performance.now();
    const timer = setInterval(() => { $('#st-time').textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
    const alive = () => { if (id !== orc.runId) { clearInterval(timer); return false; } return true; };

    setState(g.cols[0][0], 'done');
    log(`⚡ Routed to ${name}`, colorOf(g.key));
    for (let i = 1; i < g.cols.length; i++) {
      focusCol(g, i);
      await flow(g.edges.filter(e => e.col === i), g);
      if (!alive()) return;
      const nodes = g.cols[i];
      if (nodes[0].kind === 'final') { setState(nodes[0], 'done'); break; }
      nodes.forEach(nd => setState(nd, 'work'));
      await Promise.all(nodes.map(async (nd, j) => {
        await sleep(rand(450, 1250) + j * 90);
        if (id !== orc.runId) return;
        calls++; tokens += Math.round(rand(350, 1500));
        bump('#st-calls', calls); bump('#st-tokens', tokens);
        setState(nd, 'done');
        log(`s${nd.stageIndex} ${nd.stage.title} · ${nd.label}${nd.standIn ? ' (stand-in)' : ''} ✓`, nd.color);
      }));
      if (!alive()) return;
    }
    clearInterval(timer);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('#st-time').textContent = secs + 's';
    log(`✅ ${name} finished in ${secs}s`, 'var(--pink)');
    const fin = g.cols[g.cols.length - 1][0];
    if (fin.el) burstAt(fin.el);
    showFinal(g, calls);
    orc.running = false;
    runBtn.disabled = false;
    runBtn.textContent = '↺ Run again';
  }

  function showFinal(g, calls) {
    const f = $('#orc-final');
    const name = E.PRESETS[g.key].name;
    f.textContent = '';
    f.append(
      h('h4', {}, `✅ ${name} finished (simulated)`),
      h('p', {}, `${calls} agent call${calls === 1 ? '' : 's'} across ${g.cols.length - 2} stage${g.cols.length === 3 ? '' : 's'} on “${oneLine(g.task, 80)}”. In the app, each agent streams its real answer live, and the merged answer lands here, ready to copy or send to KakaoTalk.`),
      h('div', { class: 'row' },
        h('a', { href: appLink(g.task, g.key) }, 'Open this in the app →'),
        h('button', { type: 'button', onclick: run }, '↺ Replay')));
    f.hidden = false;
  }

  function refresh() {
    if (orc.running) { orc.runId++; orc.running = false; resetRunUi(); }
    hidePop();
    $('#orc-final').hidden = true;
    renderPills();
    renderProviders();
    render();
  }

  // Other sections call this to show a pipeline in the orchestra.
  function playInOrchestra(key, task) {
    if (task && task.trim()) taskInput.value = task.trim();
    orc.mode = key || 'auto';
    refresh();
    orchestra.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    setTimeout(run, reduce ? 0 : 650);
  }

  runBtn.addEventListener('click', run);
  taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  let tt = null;
  taskInput.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(refresh, 250); });
  document.addEventListener('keydown', e => {
    if ((e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) {
      e.preventDefault();
      const r = orchestra.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight) orchestra.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: r.height > innerHeight ? 'start' : 'center' });
      run();
    }
  });
  let rt = null, lastW = stage.clientWidth;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!orc.running && Math.abs(stage.clientWidth - lastW) > 20) { lastW = stage.clientWidth; render(); } }, 200);
  });
  refresh();

  // ======================= Router + ladder =======================
  const LADDER = ['solo', 'compare', 'relay', 'debate', 'fanout', 'council', 'ultra'].filter(k => KEYS.includes(k));
  const ladder = $('.ladder');
  const ladderList = $('#ladder');
  const marker = $('#ladder-marker');
  const rtInput = $('#rt-input');
  LADDER.forEach(k => {
    const li = h('li', { 'data-key': k, class: isRainbow(k) ? 'rainbow' : null, title: 'Watch ' + E.PRESETS[k].name + ' in the orchestra' },
      h('i'), h('b', {}, E.PRESETS[k].name), h('span', {}, META[k].calls));
    li.style.setProperty('--pc', colorOf(k));
    li.addEventListener('click', () => playInOrchestra(k, rtInput.value));
    ladderList.append(li);
  });

  function showRoute(text) {
    const r = E.route(text);
    const out = $('#rt-result');
    out.textContent = '';
    $$('#ladder li').forEach(li => li.classList.toggle('on', !!r && li.dataset.key === r.preset));
    if (!r) { marker.style.opacity = 0; out.append(h('p', { class: 'rt-blurb' }, 'Type a task, or pick an example.')); return; }
    const li = $(`#ladder li[data-key="${r.preset}"]`);
    if (li) { marker.style.opacity = 1; marker.style.top = (li.getBoundingClientRect().top - ladder.getBoundingClientRect().top) + 'px'; }
    const card = h('div', { class: 'rt-card' + (isRainbow(r.preset) ? ' rainbow' : '') });
    card.style.setProperty('--pc', colorOf(r.preset));
    card.append(
      h('div', { class: 'rt-head' }, h('span', { class: 'rt-kind' }, r.kind), h('span', { class: 'rt-name' }, '→ ' + E.PRESETS[r.preset].name), h('span', { class: 'rt-tag' }, 'effort: ' + r.effort)),
      h('p', { class: 'rt-blurb' }, E.PRESETS[r.preset].blurb),
      h('ul', { class: 'rt-why' }, r.reasons.map(x => h('li', {}, x))),
      r.warnings.length ? h('ul', { class: 'rt-warn' }, r.warnings.map(x => h('li', {}, x))) : null,
      h('div', { class: 'rt-actions' },
        h('button', { type: 'button', onclick: () => playInOrchestra(r.preset, text) }, '▶ Watch it in the orchestra'),
        h('a', { href: appLink(E.cleanTask(text), r.preset) }, 'Open in the app →')));
    out.append(card);
  }

  const EXAMPLES = [
    ['fix a typo in the README', 'var(--orange)'],
    ['ask all the models which database a startup should use', 'var(--gemini)'],
    ['audit this login function for security bugs', 'var(--violet)'],
    ['migrate every component under src/ to TypeScript, about 40 files', 'var(--gpt)'],
    ['compare Postgres vs MongoDB for our marketplace', 'var(--cyan)'],
    ['change the production billing configuration', 'var(--pink)'],
    ['ultracode: design a production-ready rate limiter with tests', 'var(--compat)'],
  ];
  EXAMPLES.forEach(([ex, c]) => {
    const b = h('button', { type: 'button' }, ex);
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { rtInput.value = ex; showRoute(ex); });
    $('#rt-examples').append(b);
  });
  let rtt = null;
  rtInput.addEventListener('input', () => { clearTimeout(rtt); rtt = setTimeout(() => showRoute(rtInput.value), 120); });
  rtInput.value = EXAMPLES[3][0];
  requestAnimationFrame(() => showRoute(rtInput.value));
  window.addEventListener('resize', () => showRoute(rtInput.value));

  // ======================= Pipeline cards (tilt + play) =======================
  const cards = $('#pcards');
  KEYS.forEach(k => {
    const card = h('article', { class: 'pcard' + (isRainbow(k) ? ' rainbow' : ''), 'data-reveal': '' });
    card.style.setProperty('--pc', colorOf(k));
    const flowline = h('div', { class: 'flowline' });
    META[k].flow.forEach(part => {
      if (typeof part === 'string') { flowline.append(h('span', { class: 'arr' }, part)); return; }
      const [label, kind] = part;
      const chip = h('span', { class: 'chip' + (kind === 'all' ? ' all' : '') }, label);
      if (kind !== 'all') chip.style.setProperty('--cc', CHIP[kind]);
      flowline.append(chip);
    });
    card.append(
      h('header', {}, h('h3', {}, E.PRESETS[k].name), h('span', { class: 'calls' }, META[k].calls)),
      flowline,
      h('p', {}, E.PRESETS[k].blurb),
      h('button', { type: 'button', class: 'play', onclick: () => playInOrchestra(k) }, '▶ Watch it'));
    if (finePointer && !reduce) {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.setProperty('--ry', ((px - .5) * 12).toFixed(2) + 'deg');
        card.style.setProperty('--rx', ((.5 - py) * 10).toFixed(2) + 'deg');
        card.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
        card.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
      });
      card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
    }
    cards.append(card);
  });

  // ======================= Cost calculator =======================
  const TIER = { top: { claude: [5, 25], gpt: [10, 50] }, fast: { claude: [2, 10], gpt: [2, 12] } };
  let tier = 'top';
  const ctl = { in: $('#c-in'), out: $('#c-out'), items: $('#c-items'), ais: $('#c-ais') };
  function estimate(key, inW, outW, items, ais) {
    const inT = inW * 1.33, outT = outW * 1.33, price = TIER[tier];
    const mix = [(price.claude[0] + price.gpt[0]) / 2, (price.claude[1] + price.gpt[1]) / 2];
    let calls = 0, cost = 0, prevWidth = 0;
    E.PRESETS[key].build().forEach((st, i) => {
      const width = st.type === 'agent' ? 1 : st.type === 'map' ? items : st.models.reduce((n, m) => n + (m === E.ALL ? ais : 1), 0);
      const models = st.type === 'map' ? ['claude', 'gpt'] : st.models.map(m => (m === E.ALL ? 'mix' : (NORMAL[m] || m)));
      for (let c = 0; c < width; c++) {
        const m = models[c % models.length];
        const p = price[m] || mix;
        const input = st.type === 'map' ? inT * .5 + 250 : inT + (i ? prevWidth * outT : 0);
        cost += (input * p[0] + outT * p[1]) / 1e6;
      }
      calls += width;
      prevWidth = width;
    });
    return { calls, cost };
  }
  const bars = $('#cost-bars');
  const barEls = {};
  KEYS.forEach(k => {
    const fill = h('div', { class: 'bar-fill' });
    const val = h('span');
    const row = h('div', { class: 'bar' + (isRainbow(k) ? ' rainbow' : '') },
      h('div', { class: 'bar-top' }, h('b', {}, E.PRESETS[k].name), val),
      h('div', { class: 'bar-track' }, fill));
    row.style.setProperty('--pc', colorOf(k));
    barEls[k] = { fill, val };
    bars.append(row);
  });
  const fmtUsd = n => (n < .01 ? '$' + n.toFixed(4) : n < 1 ? '$' + n.toFixed(3) : '$' + n.toFixed(2));
  function updateCost() {
    const v = { in: +ctl.in.value, out: +ctl.out.value, items: +ctl.items.value, ais: +ctl.ais.value };
    $('#o-in').textContent = v.in.toLocaleString(); $('#o-out').textContent = v.out.toLocaleString();
    $('#o-items').textContent = v.items; $('#o-ais').textContent = v.ais;
    const res = {};
    KEYS.forEach(k => { res[k] = estimate(k, v.in, v.out, v.items, v.ais); });
    const max = Math.max(...KEYS.map(k => res[k].cost));
    const solo = res.solo ? res.solo.cost : 0;
    KEYS.forEach(k => {
      const r = res[k];
      barEls[k].fill.style.width = Math.max(2, (r.cost / max) * 100) + '%';
      barEls[k].val.textContent = `${fmtUsd(r.cost)} · ${r.calls} call${r.calls === 1 ? '' : 's'}` + (k !== 'solo' && solo ? ` · ${(r.cost / solo).toFixed(1)}× Solo` : '');
    });
  }
  Object.values(ctl).forEach(i => i.addEventListener('input', updateCost));
  $$('.seg button').forEach(b => b.addEventListener('click', () => {
    tier = b.dataset.tier;
    $$('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    updateCost();
  }));
  updateCost();

  // ======================= Cloud run simulation =======================
  const SCRIPT = [
    { av: '🚀', c: 'var(--violet)', title: 'github-actions · started', text: 'Working in parallel: Claude Code (ultracode), OpenAI Codex, Gemini CLI. Claude merges every answer at the end.', wait: 900 },
    { av: 'C', c: 'var(--claude)', title: '🟠 Claude Code (ultracode)', text: 'Ran a workflow: three agents drafted a token-bucket design, and two verifiers attacked the burst edge cases. Includes a Redis Lua script and tests.', wait: 2300 },
    { av: 'X', c: 'var(--gpt)', title: '🟢 OpenAI Codex', text: 'Sliding-window limiter with per-key quotas, 429 + Retry-After headers, and a load-test plan. Effort: xhigh.', wait: 1600 },
    { av: 'G', c: 'var(--gemini)', title: '🔵 Google Gemini CLI', text: 'Compared token bucket, sliding log and fixed window. Recommends a token bucket at the edge with an in-process fallback.', wait: 1400 },
    { av: '✅', c: 'var(--lime)', title: '✅ Final answer (Claude merged every answer)', text: 'All three agree on a token bucket. It takes the headers from Codex, the edge-case tests from Claude Code and the fallback from Gemini, then gives the merged design.', wait: 1900 },
  ];
  const thread = $('#thread');
  const simBtn = $('#cloud-sim');
  simBtn.addEventListener('click', async () => {
    simBtn.disabled = true;
    thread.textContent = '';
    $('#issue-labels').textContent = '';
    $('#issue-labels').append(h('span', { class: 'gh-label l-run' }, 'agent-run'));
    for (const step of SCRIPT) {
      const typing = h('li', { class: 'comment' }, h('span', { class: 'avatar' }, step.av), h('span', { class: 'cbody typing' }, h('i'), h('i'), h('i')));
      typing.style.setProperty('--c', step.c);
      thread.append(typing);
      thread.scrollTop = thread.scrollHeight;
      await sleep(step.wait);
      const c = h('li', { class: 'comment' }, h('span', { class: 'avatar' }, step.av),
        h('div', { class: 'cbody' }, h('b', {}, step.title), step.text, h('br'), h('small', {}, 'simulated example')));
      c.style.setProperty('--c', step.c);
      typing.replaceWith(c);
      thread.scrollTop = thread.scrollHeight;
    }
    $('#issue-labels').append(h('span', { class: 'gh-label l-done' }, 'agent-done'));
    burstAt(simBtn);
    simBtn.disabled = false;
    simBtn.textContent = '↺ Replay the cloud run';
  });

  // ======================= KakaoTalk simulation =======================
  const chat = $('#chat');
  const kkBtn = $('#kakao-sim');
  const kkBadge = $('#kk-badge');
  let kkCount = 0;
  const KK = [
    ['✅ Relay finished (Ultra)', 'design a rate limiter', 'Token bucket at the edge, an in-process fallback, 429 + Retry-After headers, and tests for bursts.'],
    ['✅ Relay finished (Council)', 'which database for a startup?', '4 of 5 models pick Postgres. The judge agrees: relational data, strong tooling, and room to grow.'],
    ['✅ Relay finished (Relay)', 'write the launch email', 'The draft was attacked by GPT and revised by Claude. Two review points were rejected, with reasons.'],
  ];
  kkBtn.addEventListener('click', async () => {
    kkBtn.disabled = true;
    const typing = h('div', { class: 'bubble typing-b' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
    chat.append(typing);
    chat.scrollTop = chat.scrollHeight;
    await sleep(1100);
    const [head, task, body] = KK[kkCount % KK.length];
    typing.replaceWith(h('div', { class: 'bubble card' },
      h('div', { class: 'kc-body' }, h('b', {}, head), h('small', {}, task), h('br'), h('br'), body),
      h('span', { class: 'kc-btn' }, 'Open Relay')));
    kkCount++;
    while (chat.querySelectorAll('.bubble').length > 7) chat.querySelector('.bubble').remove();
    chat.scrollTop = chat.scrollHeight;
    kkBadge.hidden = false;
    kkBadge.textContent = String(kkCount);
    if (!reduce && kkBadge.animate) kkBadge.animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], 300);
    kkBtn.disabled = false;
    kkBtn.textContent = 'Send another result';
  });

  // ======================= Hero spotlight, magnetic buttons, party =======================
  const hero = $('#hero');
  if (finePointer && !reduce) {
    hero.addEventListener('pointermove', e => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      hero.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
    $$('.magnetic').forEach(b => {
      b.addEventListener('pointermove', e => {
        const r = b.getBoundingClientRect();
        b.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * .18).toFixed(1)}px, ${((e.clientY - r.top - r.height / 2) * .3).toFixed(1)}px)`;
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; });
    });
  }
  $('#party').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    confetti(r.left + r.width / 2, r.top, 160);
    setTimeout(() => confetti(innerWidth * .2, innerHeight * .4, 90), 180);
    setTimeout(() => confetti(innerWidth * .8, innerHeight * .4, 90), 320);
  });

  // ======================= Scroll reveal + count-up =======================
  const reveal = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add('in'); reveal.unobserve(en.target); }
  }), { threshold: .12, rootMargin: '0px 0px -40px 0px' });
  $$('[data-reveal]').forEach(el => reveal.observe(el));

  $$('[data-count]').forEach(el => {
    const to = +el.dataset.count;
    const obs = new IntersectionObserver(([en]) => {
      if (!en.isIntersecting) return;
      obs.disconnect();
      if (reduce) { el.textContent = to; return; }
      const t0 = performance.now();
      (function f(t) {
        const p = Math.min(1, (t - t0) / 1100);
        el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(f);
      })(t0);
    });
    el.textContent = '0';
    obs.observe(el);
  });

  // First impression: play the orchestra once when it scrolls into view.
  const firstPlay = new IntersectionObserver(([en]) => {
    if (en.isIntersecting) { firstPlay.disconnect(); setTimeout(() => { if (!orc.running) run(); }, reduce ? 0 : 700); }
  }, { threshold: .5 });
  firstPlay.observe(orchestra);
})();
