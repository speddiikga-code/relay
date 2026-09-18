/* Relay — UI wiring. State, settings, pipeline editor, live run view, history. */
(function () {
  'use strict';

  const { SLOTS, SWAP, EFFORTS, TYPES, PRESETS, DEFAULT_PRICES, oneLine, isAbort } = window.Engine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------- Storage (every access guarded: private windows can throw) ----------
  const LS = (() => { try { return window.localStorage; } catch (_) { return null; } })();
  const SS = (() => { try { return window.sessionStorage; } catch (_) { return null; } })();
  const store = {
    get(k, fb, s) { try { const v = (s || LS).getItem(k); return v == null ? fb : JSON.parse(v); } catch (_) { return fb; } },
    set(k, v, s) { try { (s || LS).setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k, s) { try { (s || LS).removeItem(k); } catch (_) { /* ignore */ } },
  };

  // On <owner>.github.io/<repo>/ the site's own repo is the natural cloud-agents repo.
  function detectRepo() {
    const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!m) return '';
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m[1] + '/' + (seg && !/\.html?$/i.test(seg) ? seg : `${m[1]}.github.io`);
  }
  const validRepo = r => /^[\w.-]+\/[\w.-]+$/.test(r || '');

  const DEFAULT_SETTINGS = {
    cloudRepo: detectRepo(),
    modelClaude: 'claude-opus-5',
    modelClaudeFast: 'claude-sonnet-5',
    modelGpt: 'gpt-6-astra',
    modelGptFast: 'gpt-5.6-terra',
    maxCalls: 30,
    maxItems: 12,
    concurrency: 4,
    maxTokens: 64000,
    showThinking: true,
    fallbacks: true,
    anthropicBase: 'https://api.anthropic.com',
    openaiBase: 'https://api.openai.com',
    prices: DEFAULT_PRICES,
    effortOverride: 'stage',
    remember: false,
    demo: null,
  };

  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('relay.settings', {}));
  let keys = store.get('relay.keys', null) || store.get('relay.keys', null, SS) || { anthropic: '', openai: '' };
  if (settings.demo == null) settings.demo = !(keys.anthropic || keys.openai);

  const state = {
    pipeline: store.get('relay.pipeline', null) || fromPreset('relay'),
    running: false,
    ctrl: null,
    run: null,
    lastFinal: '',
    raw: false,
  };

  function fromPreset(key, opts) {
    const p = PRESETS[key];
    const stages = p.build();
    if (opts && opts.effort) stages.forEach(s => { s.effort = opts.effort; });
    if (opts && opts.slot && stages[0].type === 'agent') stages[0].models = [opts.slot];
    return { preset: key, name: p.name, edited: false, stages };
  }

  function saveSettings() { store.set('relay.settings', settings); }
  function savePipeline() { store.set('relay.pipeline', state.pipeline); }
  function saveKeys() {
    store.del('relay.keys'); store.del('relay.keys', SS);
    if (!keys.anthropic && !keys.openai) return;
    store.set('relay.keys', keys, settings.remember ? LS : SS);
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs) {
    const n = document.createElement(tag);
    let value;
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'value') value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const k of kids) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    }
    if (value !== undefined) n.value = value;
    return n;
  }

  let purifyHooked = false;
  function md(text) {
    if (window.marked && window.DOMPurify) {
      if (!purifyHooked) {
        window.DOMPurify.addHook('afterSanitizeAttributes', node => {
          if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
        });
        purifyHooked = true;
      }
      try { return window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { gfm: true })); } catch (_) { /* fall through */ }
    }
    const pre = el('pre', { class: 'plain' }, String(text || ''));
    return pre.outerHTML;
  }

  const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  const fmtUsd = n => (n == null ? 'n/a' : n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(n < 1 ? 3 : 2));
  const fmtMs = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };

  function friendly(e) {
    const m = String((e && e.message) || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return m + '. The browser could not reach the API (offline, ad-blocker, or a network blocking it). You can set a proxy base URL in Settings → Advanced.';
    if (/HTTP 401/.test(m)) return m + ' (the API key was rejected; check it in Settings).';
    if (/HTTP 403/.test(m)) return m + ' (this key has no access to that model or feature).';
    if (/HTTP 404/.test(m)) return m + ' (model not found for this key; use Settings → Test & load models).';
    if (/HTTP 429/.test(m)) return m + ' (rate-limited or out of credit; lower concurrency or wait).';
    if (/HTTP 529|overloaded/i.test(m)) return m + ' (the API is overloaded; try again shortly).';
    return m;
  }

  function banner(msg, kind) {
    const b = $('#banner');
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.className = 'banner ' + (kind || 'info');
    b.textContent = msg;
    b.hidden = false;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1200); }
    } catch (_) { banner('Clipboard blocked by the browser. Select the text and copy it manually.', 'warn'); }
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/markdown' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Header status ----------
  function renderStatus() {
    const set = (id, has) => {
      const p = $(id);
      p.dataset.state = settings.demo ? 'demo' : has ? 'ok' : 'off';
      p.title = settings.demo ? 'Demo mode: calls are simulated' : has ? 'Key set' : 'No key. Add one in Settings.';
    };
    set('#pill-anthropic', !!keys.anthropic);
    set('#pill-openai', !!keys.openai);
    $('#demo-toggle').checked = !!settings.demo;
    document.body.classList.toggle('is-demo', !!settings.demo);
    $('#run').textContent = settings.demo ? 'Run (demo)' : 'Run pipeline';
    $('#kickstart').textContent = settings.demo ? '⚡ Kickstart (demo)' : '⚡ Kickstart';
  }

  // ---------- Presets & router ----------
  function renderPresets() {
    const wrap = $('#presets');
    wrap.textContent = '';
    for (const key of Object.keys(PRESETS)) {
      const p = PRESETS[key];
      const active = state.pipeline.preset === key;
      wrap.append(el('button', {
        type: 'button', role: 'radio', 'aria-checked': active ? 'true' : 'false', 'aria-label': `${p.name}: ${p.blurb}`,
        class: 'preset' + (active ? ' on' : ''),
        onclick: () => { state.pipeline = fromPreset(key); savePipeline(); renderAll(); },
      }, el('b', {}, p.name, active && state.pipeline.edited ? el('em', {}, ' · edited') : null), el('span', {}, p.blurb)));
    }
  }

  let routeTimer = null;
  function renderRoute() {
    const task = $('#task').value;
    const box = $('#route');
    $('#task-count').textContent = task.length ? task.length.toLocaleString() + ' chars' : '';
    const r = window.Engine.route(task);
    if (!r) { box.hidden = true; return; }
    const same = state.pipeline.preset === r.preset && !state.pipeline.edited;
    box.textContent = '';
    box.append(...[
      el('div', { class: 'route-head' },
        el('span', { class: 'route-kind' }, r.kind),
        el('span', { class: 'route-arrow' }, '→'),
        el('b', {}, PRESETS[r.preset].name),
        el('span', { class: 'tag' }, 'effort: ' + r.effort),
        same ? el('span', { class: 'hint' }, 'in use') :
          el('button', { type: 'button', class: 'btn small', onclick: () => { state.pipeline = fromPreset(r.preset, r); savePipeline(); renderAll(); } }, 'Use suggestion')),
      el('ul', { class: 'route-why' }, r.reasons.map(x => el('li', {}, x))),
      r.warnings.length ? el('ul', { class: 'route-warn' }, r.warnings.map(x => el('li', {}, x))) : null,
      r.scale && r.scale > settings.maxItems && r.preset === 'fanout'
        ? el('p', { class: 'route-warn-p' }, `Stated scale (~${r.scale}) is above your fan-out cap of ${settings.maxItems}. Raise it in Settings or split the job.`) : null,
    ].filter(Boolean));
    box.hidden = false;
  }

  // ---------- Pipeline editor ----------
  function markEdited() {
    state.pipeline.edited = true;
    savePipeline();
    renderPresets();
    renderEstimate();
    renderRoute();
  }

  function renderEstimate() {
    const { min, max } = window.Engine.estimateCalls(state.pipeline.stages, settings.maxItems);
    const n = state.pipeline.stages.length;
    $('#calls-est').textContent = `${n} stage${n === 1 ? '' : 's'} · ${min === max ? min : min + '–' + max} call${max === 1 ? '' : 's'}`;
  }

  function renderStages() {
    const wrap = $('#stages');
    wrap.textContent = '';
    state.pipeline.stages.forEach((st, i) => wrap.append(stageEditor(st, i)));
    renderEstimate();
  }

  function stageEditor(st, i) {
    const stages = state.pipeline.stages;
    const structural = () => { markEdited(); renderStages(); };

    const typeSel = el('select', {
      'aria-label': 'Stage type',
      onchange: e => { st.type = e.target.value; if (st.type === 'agent') st.models = [st.models[0] || 'claude']; structural(); },
    }, Object.keys(TYPES).map(t => el('option', { value: t }, TYPES[t])));
    typeSel.value = st.type;

    const models = el('div', { class: 'chips', role: 'group', 'aria-label': 'Models for this stage' });
    for (const slot of Object.keys(SLOTS)) {
      const info = SLOTS[slot];
      const on = st.models.includes(slot);
      models.append(el('button', {
        type: 'button', class: 'chip v-' + info.vendor + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
        title: settings[info.setting],
        onclick: () => {
          if (st.type === 'agent') st.models = [slot];
          else if (on) { if (st.models.length > 1) st.models = st.models.filter(m => m !== slot); }
          else st.models = st.models.concat(slot);
          structural();
        },
      }, info.label));
    }

    const effortSel = el('select', { 'aria-label': 'Effort', onchange: e => { st.effort = e.target.value; markEdited(); } },
      EFFORTS.map(x => el('option', { value: x }, x === 'default' ? 'effort: model default' : 'effort: ' + x)));
    effortSel.value = st.effort || 'default';

    let fromSel = null;
    if (st.type === 'map') {
      fromSel = el('select', { 'aria-label': 'Fan out over', onchange: e => { st.mapFrom = e.target.value; markEdited(); } },
        el('option', { value: '' }, 'items from: previous stage'),
        stages.slice(0, i).map((_, j) => el('option', { value: 's' + (j + 1) }, 'items from: s' + (j + 1))));
      fromSel.value = st.mapFrom || '';
    }

    const move = (d) => { const j = i + d; if (j < 0 || j >= stages.length) return; stages.splice(j, 0, stages.splice(i, 1)[0]); structural(); };

    return el('div', { class: 'stage' },
      el('div', { class: 'stage-head' },
        el('span', { class: 'num' }, 's' + (i + 1)),
        el('input', { class: 'stage-title', value: st.title, 'aria-label': 'Stage name', oninput: e => { st.title = e.target.value; markEdited(); } }),
        el('div', { class: 'stage-tools' },
          el('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
          el('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === stages.length - 1, onclick: () => move(1) }, '↓'),
          el('button', { type: 'button', class: 'icon', title: 'Remove stage', 'aria-label': 'Remove stage', disabled: stages.length === 1, onclick: () => { stages.splice(i, 1); structural(); } }, '✕'))),
      el('div', { class: 'stage-row' }, typeSel, effortSel, fromSel),
      models,
      el('details', { class: 'stage-prompt' },
        el('summary', {}, 'Prompt', el('span', { class: 'hint' }, ' · ' + oneLine(st.prompt, 60))),
        el('label', { class: 'label' }, 'System prompt (optional)',
          el('textarea', { rows: 2, spellcheck: 'false', value: st.system || '', oninput: e => { st.system = e.target.value; markEdited(); } })),
        el('label', { class: 'label' }, 'Prompt template',
          el('textarea', { rows: 7, spellcheck: 'false', value: st.prompt, oninput: e => { st.prompt = e.target.value; markEdited(); } })))
    );
  }

  // ---------- Run view ----------
  function stageView(st, i) {
    const status = el('span', { class: 'rs-status' }, 'running');
    const meta = el('span', { class: 'rs-meta' });
    const panes = el('div', { class: 'panes' + (st.type === 'agent' ? ' single' : '') });
    const notes = el('div', { class: 'rs-notes' });
    const art = el('article', { class: 'run-stage', 'data-status': 'running' },
      el('header', { class: 'rs-head' },
        el('span', { class: 'num' }, 's' + (i + 1)),
        el('h3', {}, st.title || 'Stage'),
        el('span', { class: 'tag' }, st.type === 'agent' ? 'agent' : st.type === 'parallel' ? 'parallel' : 'fan-out'),
        status, meta),
      notes, panes);
    $('#timeline').append(art);
    const t0 = performance.now();
    const agg = { tokens: 0, cost: 0, hasCost: false };
    const tick = () => { meta.textContent = [fmtMs(performance.now() - t0), fmtTok(agg.tokens) + ' tok', agg.hasCost ? fmtUsd(agg.cost) : ''].filter(Boolean).join(' · '); };
    const timer = setInterval(tick, 1000);
    tick();
    return {
      addPane(slot, item) {
        return paneView(panes, slot, item, (u, c) => {
          agg.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
          if (c != null) { agg.cost += c; agg.hasCost = true; }
          tick();
        });
      },
      note(msg) { notes.append(el('p', { class: 'note' }, msg)); },
      done() { clearInterval(timer); tick(); art.dataset.status = 'done'; status.textContent = 'done'; },
      fail(e) {
        clearInterval(timer); tick();
        const stopped = isAbort(e);
        art.dataset.status = stopped ? 'stopped' : 'error';
        status.textContent = stopped ? 'stopped' : 'failed';
      },
    };
  }

  function paneView(container, slot, item, onUsage) {
    const info = SLOTS[slot];
    const modelCode = el('code', {}, settings[info.setting]);
    const meta = el('span', { class: 'pane-meta' }, 'queued');
    const thinkBody = el('div', { class: 'think-body' });
    const think = el('details', { class: 'think', hidden: true }, el('summary', {}, 'Reasoning summary'), thinkBody);
    const body = el('div', { class: 'md pane-body' });
    const notes = el('div', { class: 'pane-notes' });
    const expand = el('button', { type: 'button', class: 'pane-expand', 'aria-expanded': 'false' }, 'Expand');
    const pane = el('div', { class: 'pane v-' + info.vendor, 'data-status': 'queued' },
      el('div', { class: 'pane-head' }, el('span', { class: 'dot' }), el('b', {}, info.label), modelCode, meta),
      item ? el('div', { class: 'pane-item', title: item }, oneLine(item, 200)) : null,
      think, body, notes, expand);
    expand.addEventListener('click', () => {
      const open = pane.classList.toggle('open');
      expand.textContent = open ? 'Collapse' : 'Expand';
      expand.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    container.append(pane);

    let buf = '', tbuf = '', timer = null;
    const flush = () => {
      timer = null;
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.innerHTML = md(buf);
      if (stick) body.scrollTop = body.scrollHeight;
      if (tbuf) thinkBody.textContent = tbuf;
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, 80); };
    const t0 = { v: 0 };
    let ticker = null;

    return {
      start(model) {
        pane.dataset.status = 'running';
        modelCode.textContent = model;
        t0.v = performance.now();
        meta.textContent = 'thinking…';
        ticker = setInterval(() => { meta.textContent = (buf ? 'streaming · ' : 'thinking · ') + fmtMs(performance.now() - t0.v); }, 1000);
      },
      text(d) { buf += d; schedule(); },
      thinking(d) { tbuf += d; think.hidden = false; schedule(); },
      note(m) { notes.append(el('p', { class: 'note' }, m)); },
      done(r) {
        clearInterval(ticker); clearTimeout(timer); flush();
        pane.dataset.status = 'done';
        if (r.model) modelCode.textContent = r.model;
        meta.textContent = `${fmtMs(r.ms)} · ${fmtTok(r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)} in · ${fmtTok(r.usage.output)} out` + (r.cost != null ? ' · ' + fmtUsd(r.cost) : '');
        onUsage(r.usage, r.cost);
      },
      fail(e) {
        clearInterval(ticker); clearTimeout(timer); flush();
        const stopped = isAbort(e);
        pane.dataset.status = stopped ? 'stopped' : 'error';
        meta.textContent = stopped ? 'stopped' : 'failed';
        if (!stopped) notes.append(el('p', { class: 'note err' }, friendly(e)));
      },
    };
  }

  function renderTotals() {
    const r = state.run;
    const t = $('#totals');
    if (!r) { t.hidden = true; return; }
    t.hidden = false;
    t.textContent = '';
    const cell = (k, v) => el('div', {}, el('span', {}, k), el('b', {}, v));
    t.append(
      cell('Status', r.status),
      cell('Agent calls', String(r.calls)),
      cell('Tokens in / out', fmtTok(r.input) + ' / ' + fmtTok(r.output)),
      cell('Est. cost', r.demo ? '$0 (demo)' : r.costKnown ? fmtUsd(r.cost) : 'n/a'),
      cell('Elapsed', fmtMs((r.end || performance.now()) - r.t0))
    );
  }

  // The one place a stage's agent is actually executed.
  async function callSlot(slot, system, prompt, effort, pane, signal) {
    const info = SLOTS[slot];
    const model = settings[info.setting];
    const run = state.run;
    pane.start(model);
    run.calls += 1;
    renderTotals();
    const t0 = performance.now();
    const hooks = { onText: pane.text, onThinking: pane.thinking, onNote: pane.note };
    try {
      let r;
      if (settings.demo) {
        r = await window.Providers.callMock(Object.assign({ label: info.label, model, system, prompt, signal }, hooks));
      } else if (info.vendor === 'anthropic') {
        if (!keys.anthropic) throw new Error('No Anthropic API key. Add one in Settings, or turn on Demo.');
        r = await window.Providers.callAnthropic(Object.assign({
          model, system, prompt, effort, signal, key: keys.anthropic, baseUrl: settings.anthropicBase.replace(/\/+$/, ''),
          maxTokens: settings.maxTokens, showThinking: settings.showThinking, fallbacks: settings.fallbacks,
        }, hooks));
      } else {
        if (!keys.openai) throw new Error('No OpenAI API key. Add one in Settings, or turn on Demo.');
        r = await window.Providers.callOpenAI(Object.assign({
          model, system, prompt, effort, signal, key: keys.openai, baseUrl: settings.openaiBase.replace(/\/+$/, ''),
        }, hooks));
      }
      const c = settings.demo ? null : window.Engine.cost(r.model || model, r.usage, settings.prices);
      run.input += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
      run.output += r.usage.output;
      if (c != null) { run.cost += c; run.costKnown = true; }
      pane.done({ ms: performance.now() - t0, usage: r.usage, cost: c, model: r.model });
      renderTotals();
      return r;
    } catch (e) {
      pane.fail(e);
      throw e;
    }
  }

  function vendorsUsed() {
    const v = new Set();
    for (const st of state.pipeline.stages) for (const m of st.models) v.add(SLOTS[m].vendor);
    return v;
  }

  // One click: route the task, load the suggested pipeline, run it.
  function kickstart() {
    if (state.running) return;
    const r = window.Engine.route($('#task').value);
    if (!r) { banner('Write a task first.', 'warn'); $('#task').focus(); return; }
    state.pipeline = fromPreset(r.preset, r);
    savePipeline();
    renderAll();
    const override = settings.effortOverride && settings.effortOverride !== 'stage' ? ` (your effort override "${settings.effortOverride}" applies)` : '';
    run({ note: `⚡ Kickstart → ${PRESETS[r.preset].name} · ${r.kind} · effort ${r.effort}${override}. ${r.reasons[0]}.` });
  }

  async function run(opts) {
    if (state.running) return;
    const raw = $('#task').value.trim();
    if (!raw) { banner('Write a task first.', 'warn'); $('#task').focus(); return; }
    const task = window.Engine.cleanTask(raw);
    if (!settings.demo) {
      const v = vendorsUsed();
      const missing = [];
      if (v.has('anthropic') && !keys.anthropic) missing.push('Anthropic');
      if (v.has('openai') && !keys.openai) missing.push('OpenAI');
      if (missing.length) {
        banner(`This pipeline uses ${missing.join(' and ')} but no key is set. Add it in Settings, or switch on Demo to try the flow.`, 'warn');
        openSettings();
        return;
      }
    }

    banner(opts && opts.note ? opts.note : null, 'info');
    $('#empty').hidden = true;
    $('#final').hidden = true;
    $('#timeline').textContent = '';
    state.running = true;
    state.ctrl = new AbortController();
    state.run = { status: 'running', calls: 0, input: 0, output: 0, cost: 0, costKnown: false, t0: performance.now(), end: 0, demo: !!settings.demo };
    document.body.classList.add('is-running');
    $('#run').disabled = true;
    $('#kickstart').disabled = true;
    $('#stop').disabled = false;
    const tick = setInterval(renderTotals, 1000);
    renderTotals();

    const record = {
      id: String(Date.now()), date: new Date().toISOString(), task: raw, preset: state.pipeline.name + (state.pipeline.edited ? ' (edited)' : ''),
      demo: !!settings.demo, status: 'running',
    };
    try {
      const res = await window.Engine.runPipeline({
        task, stages: state.pipeline.stages, settings, signal: state.ctrl.signal, ui: { stageStart: stageView }, call: callSlot,
      });
      state.run.status = 'done';
      record.status = 'done';
      record.final = res.final;
      showFinal(res.final);
    } catch (e) {
      if (isAbort(e)) { state.run.status = 'stopped'; record.status = 'stopped'; banner('Stopped. Anything already streamed stays visible below.', 'info'); }
      else { state.run.status = 'failed'; record.status = 'failed'; record.error = e.message; banner(friendly(e), 'error'); }
    } finally {
      clearInterval(tick);
      state.run.end = performance.now();
      renderTotals();
      state.running = false;
      state.ctrl = null;
      document.body.classList.remove('is-running');
      $('#run').disabled = false;
      $('#kickstart').disabled = false;
      $('#stop').disabled = true;
      record.totals = { calls: state.run.calls, input: state.run.input, output: state.run.output, cost: state.run.costKnown ? state.run.cost : null, ms: state.run.end - state.run.t0 };
      addHistory(record);
    }
  }

  function showFinal(text) {
    state.lastFinal = text || '';
    state.raw = false;
    $('#raw-final').setAttribute('aria-pressed', 'false');
    $('#final-body').innerHTML = md(state.lastFinal);
    $('#final').hidden = false;
    $('#empty').hidden = true;
    $('#final').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- History ----------
  function addHistory(rec) {
    const list = store.get('relay.history', []);
    if (rec.final && rec.final.length > 150000) rec.final = rec.final.slice(0, 150000) + '\n\n…(truncated)';
    list.unshift(rec);
    // Keep the newest 25; if storage is full, drop the oldest until it fits.
    let keep = list.slice(0, 25);
    while (keep.length && !store.set('relay.history', keep)) keep = keep.slice(0, -1);
  }

  function renderHistory() {
    const ul = $('#history-list');
    ul.textContent = '';
    const list = store.get('relay.history', []);
    if (!list.length) { ul.append(el('li', { class: 'hint' }, 'No runs yet.')); return; }
    for (const h of list) {
      const cost = h.demo ? 'demo' : h.totals && h.totals.cost != null ? fmtUsd(h.totals.cost) : 'n/a';
      ul.append(el('li', {},
        el('button', {
          type: 'button', class: 'history-item',
          onclick: () => {
            $('#task').value = h.task;
            renderRoute(); renderHandoff();
            $('#history').close();
            $('#timeline').textContent = '';
            state.run = null; renderTotals();
            if (h.final) { showFinal(h.final); banner(`Loaded a ${h.preset} run from ${new Date(h.date).toLocaleString()}.`, 'info'); }
            else banner(`That run ended "${h.status}"${h.error ? ': ' + h.error : ''}. The task has been restored.`, 'warn');
          },
        },
        el('span', { class: 'h-top' }, el('b', {}, h.preset), el('span', { class: 'tag s-' + h.status }, h.status), el('span', { class: 'hint' }, new Date(h.date).toLocaleString())),
        el('span', { class: 'h-task' }, oneLine(h.task, 160)),
        el('span', { class: 'hint' }, `${h.totals ? h.totals.calls : 0} calls · ${cost}`))));
    }
  }

  // ---------- Settings ----------
  const F = {
    'key-anthropic': () => keys.anthropic, 'key-openai': () => keys.openai,
    'm-claude': () => settings.modelClaude, 'm-claude-fast': () => settings.modelClaudeFast,
    'm-gpt': () => settings.modelGpt, 'm-gpt-fast': () => settings.modelGptFast,
    'max-calls': () => settings.maxCalls, 'max-items': () => settings.maxItems,
    concurrency: () => settings.concurrency, 'max-tokens': () => settings.maxTokens,
    'base-anthropic': () => settings.anthropicBase, 'base-openai': () => settings.openaiBase,
    'cloud-repo': () => settings.cloudRepo,
  };

  function openSettings() {
    for (const id of Object.keys(F)) $('#' + id).value = F[id]() || '';
    $('#remember').checked = !!settings.remember;
    $('#show-thinking').checked = !!settings.showThinking;
    $('#fallbacks').checked = !!settings.fallbacks;
    $('#prices').value = '{\n' + Object.keys(settings.prices)
      .map(k => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(settings.prices[k]).replace(/,/g, ', '))
      .join(',\n') + '\n}';
    $('#st-anthropic').textContent = '';
    $('#st-openai').textContent = '';
    if (!$('#settings').open) $('#settings').showModal();
  }

  function clampInt(v, lo, hi, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; }

  function readSettingsForm() {
    const hadKeys = !!(keys.anthropic || keys.openai);
    keys = { anthropic: $('#key-anthropic').value.trim(), openai: $('#key-openai').value.trim() };
    settings.modelClaude = $('#m-claude').value.trim() || DEFAULT_SETTINGS.modelClaude;
    settings.modelClaudeFast = $('#m-claude-fast').value.trim() || DEFAULT_SETTINGS.modelClaudeFast;
    settings.modelGpt = $('#m-gpt').value.trim() || DEFAULT_SETTINGS.modelGpt;
    settings.modelGptFast = $('#m-gpt-fast').value.trim() || DEFAULT_SETTINGS.modelGptFast;
    settings.maxCalls = clampInt($('#max-calls').value, 1, 500, DEFAULT_SETTINGS.maxCalls);
    settings.maxItems = clampInt($('#max-items').value, 1, 200, DEFAULT_SETTINGS.maxItems);
    settings.concurrency = clampInt($('#concurrency').value, 1, 32, DEFAULT_SETTINGS.concurrency);
    settings.maxTokens = clampInt($('#max-tokens').value, 256, 128000, DEFAULT_SETTINGS.maxTokens);
    settings.anthropicBase = $('#base-anthropic').value.trim() || DEFAULT_SETTINGS.anthropicBase;
    settings.openaiBase = $('#base-openai').value.trim() || DEFAULT_SETTINGS.openaiBase;
    const repo = $('#cloud-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    settings.cloudRepo = validRepo(repo) ? repo : (repo ? settings.cloudRepo : '');
    settings.remember = $('#remember').checked;
    settings.showThinking = $('#show-thinking').checked;
    settings.fallbacks = $('#fallbacks').checked;
    try {
      const p = JSON.parse($('#prices').value);
      if (p && typeof p === 'object' && !Array.isArray(p)) settings.prices = p;
    } catch (_) { banner('Prices JSON is invalid, so the previous prices were kept.', 'warn'); }
    // First time keys appear, switch from demo to live.
    if (!hadKeys && (keys.anthropic || keys.openai)) settings.demo = false;
  }

  async function testKey(vendor) {
    const key = $('#key-' + vendor).value.trim();
    const out = $('#st-' + vendor);
    if (!key) { out.textContent = 'Paste a key first.'; out.className = 'hint warn'; return; }
    out.textContent = 'Checking…'; out.className = 'hint';
    try {
      const base = ($('#base-' + vendor).value.trim() || (vendor === 'anthropic' ? DEFAULT_SETTINGS.anthropicBase : DEFAULT_SETTINGS.openaiBase)).replace(/\/+$/, '');
      const ids = vendor === 'anthropic' ? await window.Providers.listAnthropicModels(key, base) : await window.Providers.listOpenAIModels(key, base);
      const dl = $('#dl-' + vendor);
      dl.textContent = '';
      ids.forEach(id => dl.append(el('option', { value: id })));
      const want = vendor === 'anthropic' ? [$('#m-claude').value, $('#m-claude-fast').value] : [$('#m-gpt').value, $('#m-gpt-fast').value];
      const missing = want.filter(m => m && ids.length && !ids.includes(m));
      out.textContent = `Key works. ${ids.length} models available.` + (missing.length ? ` Not in your list: ${missing.join(', ')}.` : '') +
        (vendor === 'openai' ? ' (This test does not check credit or billing.)' : '');
      out.className = 'hint ' + (missing.length ? 'warn' : 'ok');
    } catch (e) {
      out.textContent = friendly(e);
      out.className = 'hint err';
    }
  }

  // ---------- Cloud agents (Claude Code ultracode + Codex in GitHub Actions) ----------
  function renderCloud() {
    const repo = settings.cloudRepo;
    const ok = validRepo(repo);
    $('#cloud-repo-tag').textContent = ok ? repo : 'repository not set';
    $('#cloud-runs-link').href = ok ? `https://github.com/${repo}/issues?q=label%3Aagent-run` : '#';
    $('#cloud-setup-link').href = ok ? `https://github.com/${repo}/settings/secrets/actions` : '#';
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  async function loadCloudRuns() {
    const ul = $('#cloud-runs');
    const repo = settings.cloudRepo;
    if (!validRepo(repo)) { ul.textContent = ''; return; }
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues?labels=agent-run&state=all&per_page=6`, { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
      const list = await res.json();
      ul.textContent = '';
      if (!list.length) { ul.append(el('li', { class: 'hint' }, 'No cloud runs yet.')); return; }
      for (const it of list) {
        // Each run posts 4 comments: started, Claude Code, Codex, merged answer.
        const state = it.comments >= 4 ? 'finished' : `working (${it.comments}/4)`;
        ul.append(el('li', {}, el('a', { href: it.html_url, target: '_blank', rel: 'noopener' },
          el('span', { class: 'num' }, '#' + it.number),
          el('span', { class: 't' }, it.title),
          el('span', { class: 'hint' }, `${state} · ${ago(it.created_at)}`))));
      }
    } catch (e) {
      ul.textContent = '';
      ul.append(el('li', { class: 'hint' }, `Could not load cloud runs (${e.message}).`));
    }
  }

  async function cloudSend() {
    const raw = $('#task').value.trim();
    if (!raw) { banner('Write a task first.', 'warn'); $('#task').focus(); return; }
    if (!validRepo(settings.cloudRepo)) { banner('Set the cloud agents repository (owner/repo) in Settings first.', 'warn'); openSettings(); return; }
    const task = window.Engine.cleanTask(raw);
    const base = `https://github.com/${settings.cloudRepo}/issues/new?`;
    const title = 'Cloud run: ' + oneLine(task, 70);
    let url = base + new URLSearchParams({ labels: 'agent-run', title, body: task });
    let note = 'GitHub opened in a new tab with your task filled in. Click "Create" there to start Claude Code (ultracode) and Codex. Results arrive as comments on that issue, and the list here updates.';
    if (url.length > 7500) {
      // Too long for a URL: prefill the title and label, and put the task on the clipboard.
      url = base + new URLSearchParams({ labels: 'agent-run', title });
      try { await navigator.clipboard.writeText(task); note = 'Your task is too long for a link, so it has been copied to the clipboard. In the GitHub tab, paste it into the description (Ctrl+V), then click "Create".'; }
      catch (_) { note = 'Your task is too long for a link. Copy it from the Task box, paste it into the GitHub description, then click "Create".'; }
    }
    window.open(url, '_blank', 'noopener');
    banner(note, 'info');
    setTimeout(loadCloudRuns, 30000);
  }

  // ---------- CLI handoff ----------
  function renderHandoff() {
    const task = oneLine(window.Engine.cleanTask($('#task').value), 2000) || '<your task>';
    $('#cmd-claude').textContent = 'ultracode: ' + task;
    $('#cmd-codex').textContent = `codex exec -m ${settings.modelGpt} -c model_reasoning_effort="xhigh" "${task.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  // ---------- Wiring ----------
  function renderAll() {
    renderStatus();
    renderPresets();
    renderStages();
    renderRoute();
    renderHandoff();
    renderCloud();
    $('#effort-override').value = settings.effortOverride || 'stage';
  }

  function init() {
    const draft = store.get('relay.draft', '');
    if (draft) $('#task').value = draft;

    $('#task').addEventListener('input', () => {
      clearTimeout(routeTimer);
      routeTimer = setTimeout(() => { renderRoute(); renderHandoff(); store.set('relay.draft', $('#task').value); }, 180);
    });
    $('#task').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (e.shiftKey) kickstart(); else run(); }
    });
    $('#run').addEventListener('click', () => run());
    $('#kickstart').addEventListener('click', kickstart);
    $('#cloud-send').addEventListener('click', cloudSend);
    $('#cloud-refresh').addEventListener('click', loadCloudRuns);
    $('#stop').addEventListener('click', () => { if (state.ctrl) state.ctrl.abort(); });
    $('#effort-override').addEventListener('change', e => { settings.effortOverride = e.target.value; saveSettings(); });
    $('#demo-toggle').addEventListener('change', e => { settings.demo = e.target.checked; saveSettings(); renderStatus(); });

    $('#add-stage').addEventListener('click', () => {
      const n = state.pipeline.stages.length;
      state.pipeline.stages.push(window.Engine.stage('Stage ' + (n + 1), 'agent', ['gpt'], 'Task:\n{{task}}\n\nPrevious stage output:\n{{prev}}\n\nImprove on the previous output.'));
      markEdited(); renderStages();
    });
    $('#swap-vendors').addEventListener('click', () => {
      state.pipeline.stages.forEach(s => { s.models = s.models.map(m => SWAP[m] || m); });
      markEdited(); renderStages();
    });
    $('#export-pipeline').addEventListener('click', () => {
      download('relay-pipeline.json', JSON.stringify({ relay: 1, name: state.pipeline.name, stages: state.pipeline.stages }, null, 2), 'application/json');
    });
    $('#import-pipeline').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const stages = (j.stages || []).filter(s => s && TYPES[s.type] && Array.isArray(s.models) && s.models.length && s.models.every(m => SLOTS[m]) && typeof s.prompt === 'string')
          .map(s => window.Engine.stage(String(s.title || 'Stage'), s.type, s.type === 'agent' ? [s.models[0]] : s.models, s.prompt,
            { system: String(s.system || ''), effort: EFFORTS.includes(s.effort) ? s.effort : 'default', mapFrom: /^s\d+$/.test(s.mapFrom || '') ? s.mapFrom : '' }));
        if (!stages.length) throw new Error('No valid stages found.');
        state.pipeline = { preset: null, name: String(j.name || 'Imported'), edited: true, stages };
        savePipeline(); renderAll();
        banner(`Imported "${state.pipeline.name}" (${stages.length} stages).`, 'info');
      } catch (err) { banner('Import failed: ' + err.message, 'error'); }
    });

    $('#copy-final').addEventListener('click', e => copyText(state.lastFinal, e.currentTarget));
    $('#dl-final').addEventListener('click', () => download('relay-output.md', state.lastFinal));
    $('#raw-final').addEventListener('click', e => {
      state.raw = !state.raw;
      e.currentTarget.setAttribute('aria-pressed', state.raw ? 'true' : 'false');
      const body = $('#final-body');
      if (state.raw) { body.textContent = ''; body.append(el('pre', { class: 'plain' }, state.lastFinal)); }
      else body.innerHTML = md(state.lastFinal);
    });
    $$('[data-copy]').forEach(b => b.addEventListener('click', () => copyText($('#' + b.dataset.copy).textContent, b)));

    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-history').addEventListener('click', () => { renderHistory(); $('#history').showModal(); });
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
    $('#load-anthropic').addEventListener('click', () => testKey('anthropic'));
    $('#load-openai').addEventListener('click', () => testKey('openai'));
    $('#save-settings').addEventListener('click', () => {
      readSettingsForm(); saveSettings(); saveKeys();
      $('#settings').close(); renderAll();
      banner(settings.demo ? 'Settings saved. Demo is still on; switch it off in the header to go live.' : 'Settings saved. Runs are live now and will bill your API keys.', 'info');
    });
    $('#clear-keys').addEventListener('click', () => {
      keys = { anthropic: '', openai: '' }; saveKeys();
      $('#key-anthropic').value = ''; $('#key-openai').value = '';
      renderStatus();
    });
    $('#reset-settings').addEventListener('click', () => {
      const keep = { remember: settings.remember };
      Object.assign(settings, DEFAULT_SETTINGS, keep, { demo: !(keys.anthropic || keys.openai) });
      saveSettings(); openSettings(); renderAll();
    });
    $('#clear-history').addEventListener('click', () => { store.del('relay.history'); renderHistory(); });

    window.addEventListener('beforeunload', e => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });

    renderAll();
    loadCloudRuns();
  }

  init();
})();
