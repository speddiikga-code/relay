/* Relay — UI wiring. State, settings, pipeline editor, live run view, history,
 * cloud agents and KakaoTalk. */
(function () {
  'use strict';

  const { SLOTS, MAIN_SLOTS, ALL, SWAP, EFFORTS, TYPES, PRESETS, DEFAULT_PRICES, oneLine, isAbort } = window.Engine;
  const P = window.Providers;
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

  const VENDORS = {
    anthropic: { name: 'Claude', short: 'Claude' },
    openai: { name: 'GPT', short: 'GPT' },
    gemini: { name: 'Gemini', short: 'Gemini' },
    bedrock: { name: 'AWS Bedrock', short: 'AWS' },
    compat: { name: 'Any API', short: 'Any API' },
  };

  const COMPAT = {
    openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
    groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: '' },
    mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
    xai: { name: 'xAI', base: 'https://api.x.ai/v1', model: '' },
    together: { name: 'Together AI', base: 'https://api.together.xyz/v1', model: '' },
    custom: { name: 'Custom API', base: '', model: '' },
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
    modelGemini: 'gemini-3.8-flash',
    modelBedrock: 'us.anthropic.claude-opus-5',
    bedrockRegion: 'us-east-1',
    compatProvider: 'openrouter',
    compatBase: COMPAT.openrouter.base,
    modelCompat: COMPAT.openrouter.model,
    maxCalls: 30,
    maxItems: 12,
    concurrency: 4,
    maxTokens: 64000,
    showThinking: true,
    fallbacks: true,
    anthropicBase: 'https://api.anthropic.com',
    openaiBase: 'https://api.openai.com',
    geminiBase: 'https://generativelanguage.googleapis.com',
    prices: DEFAULT_PRICES,
    effortOverride: 'stage',
    kakaoNotify: false,
    remember: false,
    demo: null,
  };
  const EMPTY_KEYS = { anthropic: '', openai: '', gemini: '', bedrock: '', compat: '', kakaoRest: '', kakaoSecret: '', kakaoToken: null };

  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('relay.settings', {}));
  let keys = Object.assign({}, EMPTY_KEYS, store.get('relay.keys', null) || store.get('relay.keys', null, SS) || {});
  if (settings.demo == null) settings.demo = !Object.keys(VENDORS).some(v => keys[v]);

  const state = {
    pipeline: store.get('relay.pipeline', null) || fromPreset('relay'),
    running: false,
    ctrl: null,
    run: null,
    lastFinal: '',
    lastTask: '',
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
    if (!Object.keys(keys).some(k => keys[k])) return;
    store.set('relay.keys', keys, settings.remember ? LS : SS);
  }

  // ---------- Providers: which are connected, and who stands in for whom ----------
  function connected(vendor) {
    if (vendor === 'compat') return !!(keys.compat && settings.compatBase && settings.modelCompat);
    return !!keys[vendor];
  }
  function connectedMain() { return settings.demo ? MAIN_SLOTS.slice() : MAIN_SLOTS.filter(s => connected(SLOTS[s].vendor)); }

  // Expand "@all" to every connected provider, and swap unconnected slots for connected ones.
  // A stand-in prefers a provider the previous stage didn't use, so a "cross-vendor review"
  // doesn't end up with a model reviewing its own draft.
  function resolveModels(models, type, avoid) {
    const avail = connectedMain();
    const prevVendors = (avoid || []).map(s => SLOTS[s] && SLOTS[s].vendor);
    const out = [], notes = [];
    for (const m of models) {
      if (m === ALL) { avail.forEach(s => out.push(s)); continue; }
      if (!SLOTS[m]) continue;
      if (settings.demo || connected(SLOTS[m].vendor)) { out.push(m); continue; }
      const sub = avail.find(s => !out.includes(s) && !prevVendors.includes(SLOTS[s].vendor))
        || avail.find(s => !out.includes(s)) || avail[0];
      if (sub) {
        out.push(sub);
        notes.push(`${VENDORS[SLOTS[m].vendor].name} isn't connected, so ${SLOTS[sub].label} stands in.`);
      }
    }
    const models2 = type === 'map' ? out : out.filter((s, i) => out.indexOf(s) === i);
    return { models: type === 'agent' ? models2.slice(0, 1) : models2, notes };
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
    return el('pre', { class: 'plain' }, String(text || '')).outerHTML;
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
    const wrap = $('#pills');
    wrap.textContent = '';
    for (const v of Object.keys(VENDORS)) {
      const ok = connected(v);
      wrap.append(el('span', {
        class: 'pill v-' + v, 'data-state': settings.demo ? 'demo' : ok ? 'ok' : 'off',
        title: settings.demo ? 'Demo mode: calls are simulated' : ok ? `${VENDORS[v].name}: connected` : `${VENDORS[v].name}: no key (Settings)`,
      }, el('i'), VENDORS[v].short));
    }
    if (kakaoConnected()) wrap.append(el('span', { class: 'pill v-kakao', 'data-state': 'ok', title: 'KakaoTalk connected' }, el('i'), 'Kakao'));
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
      r.scale && r.scale > settings.maxItems && (r.preset === 'fanout' || r.preset === 'ultra')
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
    const { min, max } = window.Engine.estimateCalls(state.pipeline.stages, settings.maxItems, connectedMain().length);
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
      onchange: e => {
        st.type = e.target.value;
        if (st.type === 'agent') st.models = [st.models.find(m => m !== ALL) || 'claude'];
        structural();
      },
    }, Object.keys(TYPES).map(t => el('option', { value: t }, TYPES[t])));
    typeSel.value = st.type;

    const models = el('div', { class: 'chips', role: 'group', 'aria-label': 'Models for this stage' });
    const chips = Object.keys(SLOTS).map(slot => [slot, SLOTS[slot].label, SLOTS[slot].vendor]);
    if (st.type !== 'agent') chips.unshift([ALL, 'All connected', 'all']);
    for (const [slot, label, vendor] of chips) {
      const on = st.models.includes(slot);
      const dim = slot !== ALL && !settings.demo && !connected(vendor);
      models.append(el('button', {
        type: 'button', class: 'chip v-' + vendor + (on ? ' on' : '') + (dim ? ' dim' : ''), 'aria-pressed': on ? 'true' : 'false',
        title: slot === ALL ? 'Every connected provider' : (settings[SLOTS[slot].setting] || '') + (dim ? ' (not connected: another provider will stand in)' : ''),
        onclick: () => {
          if (st.type === 'agent') st.models = [slot];
          else if (on) { if (st.models.length > 1) st.models = st.models.filter(m => m !== slot); }
          else st.models = st.models.concat(slot);
          structural();
        },
      }, label));
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
        if (!stopped && !panes.children.length) notes.append(el('p', { class: 'note err' }, friendly(e)));
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

    let buf = '', tbuf = '', timer = null, ticker = null, t0 = 0;
    const flush = () => {
      timer = null;
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.innerHTML = md(buf);
      if (stick) body.scrollTop = body.scrollHeight;
      if (tbuf) thinkBody.textContent = tbuf;
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, 80); };

    return {
      start(model) {
        pane.dataset.status = 'running';
        modelCode.textContent = model;
        t0 = performance.now();
        meta.textContent = 'thinking…';
        ticker = setInterval(() => { meta.textContent = (buf ? 'streaming · ' : 'thinking · ') + fmtMs(performance.now() - t0); }, 1000);
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
    const common = { model, system, prompt, effort, signal, onText: pane.text, onThinking: pane.thinking, onNote: pane.note };
    try {
      let r;
      if (settings.demo) {
        r = await P.callMock(Object.assign({ label: info.label }, common));
      } else {
        if (!connected(info.vendor)) throw new Error(`${VENDORS[info.vendor].name} is not connected. Add its key in Settings, or turn on Demo.`);
        switch (info.vendor) {
          case 'anthropic':
            r = await P.callAnthropic(Object.assign({ key: keys.anthropic, baseUrl: settings.anthropicBase.replace(/\/+$/, ''),
              maxTokens: settings.maxTokens, showThinking: settings.showThinking, fallbacks: settings.fallbacks }, common));
            break;
          case 'openai':
            r = await P.callOpenAI(Object.assign({ key: keys.openai, baseUrl: settings.openaiBase.replace(/\/+$/, '') }, common));
            break;
          case 'gemini':
            r = await P.callGemini(Object.assign({ key: keys.gemini, baseUrl: settings.geminiBase.replace(/\/+$/, ''), showThinking: settings.showThinking }, common));
            break;
          case 'bedrock':
            r = await P.callBedrock(Object.assign({ key: keys.bedrock, region: settings.bedrockRegion, maxTokens: settings.maxTokens }, common));
            break;
          case 'compat':
            r = await P.callCompat(Object.assign({ key: keys.compat, baseUrl: settings.compatBase.replace(/\/+$/, ''),
              vendorName: (COMPAT[settings.compatProvider] || COMPAT.custom).name }, common));
            break;
          default:
            throw new Error('Unknown provider ' + info.vendor);
        }
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
    if (!settings.demo && !connectedMain().length) {
      banner('No AI provider is connected yet. Add at least one key (Claude, GPT, Gemini, AWS Bedrock or Any API) in Settings, or switch on Demo to try the flow.', 'warn');
      openSettings();
      return;
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
        task, stages: state.pipeline.stages, settings: Object.assign({}, settings, { resolveModels }),
        signal: state.ctrl.signal, ui: { stageStart: stageView }, call: callSlot,
      });
      state.run.status = 'done';
      record.status = 'done';
      record.final = res.final;
      showFinal(res.final, task);
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
      if (settings.kakaoNotify && kakaoConnected() && record.status !== 'stopped') {
        const head = record.status === 'done' ? `✅ Relay finished (${record.preset})` : `⚠️ Relay run failed (${record.preset})`;
        const tail = record.status === 'done' ? oneLine(record.final, 150) : oneLine(record.error, 150);
        kakaoSend(`${head}\n${oneLine(task, 50)}\n\n${tail}`).catch(err => banner('KakaoTalk notification failed: ' + err.message, 'warn'));
      }
    }
  }

  function showFinal(text, task) {
    state.lastFinal = text || '';
    state.lastTask = task || '';
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
            if (h.final) { showFinal(h.final, h.task); banner(`Loaded a ${h.preset} run from ${new Date(h.date).toLocaleString()}.`, 'info'); }
            else banner(`That run ended "${h.status}"${h.error ? ': ' + h.error : ''}. The task has been restored.`, 'warn');
          },
        },
        el('span', { class: 'h-top' }, el('b', {}, h.preset), el('span', { class: 'tag s-' + h.status }, h.status), el('span', { class: 'hint' }, new Date(h.date).toLocaleString())),
        el('span', { class: 'h-task' }, oneLine(h.task, 160)),
        el('span', { class: 'hint' }, `${h.totals ? h.totals.calls : 0} calls · ${cost}`))));
    }
  }

  // ---------- Settings ----------
  // [input id, read current value, write value from the form]
  const str = v => String(v || '').trim();
  const FIELDS = [
    ['key-anthropic', () => keys.anthropic, v => { keys.anthropic = str(v); }],
    ['key-openai', () => keys.openai, v => { keys.openai = str(v); }],
    ['key-gemini', () => keys.gemini, v => { keys.gemini = str(v); }],
    ['key-bedrock', () => keys.bedrock, v => { keys.bedrock = str(v); }],
    ['key-compat', () => keys.compat, v => { keys.compat = str(v); }],
    ['kakao-rest', () => keys.kakaoRest, v => { keys.kakaoRest = str(v); }],
    ['kakao-secret', () => keys.kakaoSecret, v => { keys.kakaoSecret = str(v); }],
    ['m-claude', () => settings.modelClaude, v => { settings.modelClaude = str(v) || DEFAULT_SETTINGS.modelClaude; }],
    ['m-claude-fast', () => settings.modelClaudeFast, v => { settings.modelClaudeFast = str(v) || DEFAULT_SETTINGS.modelClaudeFast; }],
    ['m-gpt', () => settings.modelGpt, v => { settings.modelGpt = str(v) || DEFAULT_SETTINGS.modelGpt; }],
    ['m-gpt-fast', () => settings.modelGptFast, v => { settings.modelGptFast = str(v) || DEFAULT_SETTINGS.modelGptFast; }],
    ['m-gemini', () => settings.modelGemini, v => { settings.modelGemini = str(v) || DEFAULT_SETTINGS.modelGemini; }],
    ['m-bedrock', () => settings.modelBedrock, v => { settings.modelBedrock = str(v) || DEFAULT_SETTINGS.modelBedrock; }],
    ['bedrock-region', () => settings.bedrockRegion, v => { settings.bedrockRegion = /^[a-z]{2}(-[a-z]+)+-\d$/.test(str(v)) ? str(v) : DEFAULT_SETTINGS.bedrockRegion; }],
    ['compat-provider', () => settings.compatProvider, v => { settings.compatProvider = COMPAT[v] ? v : 'custom'; }],
    ['compat-base', () => settings.compatBase, v => { settings.compatBase = str(v).replace(/\/+$/, ''); }],
    ['m-compat', () => settings.modelCompat, v => { settings.modelCompat = str(v); }],
    ['max-calls', () => settings.maxCalls, v => { settings.maxCalls = clampInt(v, 1, 500, DEFAULT_SETTINGS.maxCalls); }],
    ['max-items', () => settings.maxItems, v => { settings.maxItems = clampInt(v, 1, 200, DEFAULT_SETTINGS.maxItems); }],
    ['concurrency', () => settings.concurrency, v => { settings.concurrency = clampInt(v, 1, 32, DEFAULT_SETTINGS.concurrency); }],
    ['max-tokens', () => settings.maxTokens, v => { settings.maxTokens = clampInt(v, 256, 128000, DEFAULT_SETTINGS.maxTokens); }],
    ['base-anthropic', () => settings.anthropicBase, v => { settings.anthropicBase = str(v) || DEFAULT_SETTINGS.anthropicBase; }],
    ['base-openai', () => settings.openaiBase, v => { settings.openaiBase = str(v) || DEFAULT_SETTINGS.openaiBase; }],
    ['cloud-repo', () => settings.cloudRepo, v => {
      const repo = str(v).replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
      settings.cloudRepo = validRepo(repo) ? repo : (repo ? settings.cloudRepo : '');
    }],
  ];
  const CHECKS = [
    ['remember', 'remember'], ['show-thinking', 'showThinking'], ['fallbacks', 'fallbacks'], ['kakao-notify', 'kakaoNotify'],
  ];

  function clampInt(v, lo, hi, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; }

  function openSettings() {
    for (const [id, get] of FIELDS) $('#' + id).value = get() == null ? '' : get();
    for (const [id, k] of CHECKS) $('#' + id).checked = !!settings[k];
    $('#prices').value = '{\n' + Object.keys(settings.prices)
      .map(k => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(settings.prices[k]).replace(/,/g, ', '))
      .join(',\n') + '\n}';
    for (const v of Object.keys(VENDORS)) $('#st-' + v).textContent = '';
    $('#kakao-domain').textContent = location.origin;
    $('#kakao-redirect').textContent = kakaoRedirectUri();
    renderKakaoStatus();
    if (!$('#settings').open) $('#settings').showModal();
  }

  function readSettingsForm() {
    const hadKeys = Object.keys(VENDORS).some(v => keys[v]);
    for (const [id, , set] of FIELDS) set($('#' + id).value);
    for (const [id, k] of CHECKS) settings[k] = $('#' + id).checked;
    try {
      const p = JSON.parse($('#prices').value);
      if (p && typeof p === 'object' && !Array.isArray(p)) settings.prices = p;
    } catch (_) { banner('Prices JSON is invalid, so the previous prices were kept.', 'warn'); }
    // First time keys appear, switch from demo to live.
    if (!hadKeys && Object.keys(VENDORS).some(v => keys[v])) settings.demo = false;
  }

  function persistForm() { readSettingsForm(); saveSettings(); saveKeys(); }

  const MODEL_INPUTS = {
    anthropic: ['m-claude', 'm-claude-fast'], openai: ['m-gpt', 'm-gpt-fast'], gemini: ['m-gemini'], bedrock: ['m-bedrock'], compat: ['m-compat'],
  };

  async function testKey(vendor) {
    const key = $('#key-' + vendor).value.trim();
    const out = $('#st-' + vendor);
    if (!key) { out.textContent = 'Paste a key first.'; out.className = 'hint warn'; return; }
    out.textContent = 'Checking…'; out.className = 'hint';
    try {
      let ids;
      if (vendor === 'anthropic') ids = await P.listAnthropicModels(key, ($('#base-anthropic').value.trim() || DEFAULT_SETTINGS.anthropicBase).replace(/\/+$/, ''));
      else if (vendor === 'openai') ids = await P.listOpenAIModels(key, ($('#base-openai').value.trim() || DEFAULT_SETTINGS.openaiBase).replace(/\/+$/, ''));
      else if (vendor === 'gemini') ids = await P.listGeminiModels(key, settings.geminiBase);
      else if (vendor === 'bedrock') ids = await P.listBedrockModels(key, $('#bedrock-region').value.trim() || DEFAULT_SETTINGS.bedrockRegion);
      else ids = await P.listCompatModels(key, $('#compat-base').value.trim().replace(/\/+$/, ''), (COMPAT[$('#compat-provider').value] || COMPAT.custom).name);
      const dl = $('#dl-' + vendor);
      dl.textContent = '';
      ids.forEach(id => dl.append(el('option', { value: id })));
      const inputs = MODEL_INPUTS[vendor].map(id => $('#' + id));
      if (vendor === 'compat' && !inputs[0].value && ids.length) inputs[0].value = ids[0];
      const missing = inputs.map(i => i.value).filter(m => m && ids.length && !ids.includes(m));
      out.textContent = `Key works. ${ids.length} models available.` + (missing.length ? ` Not in your list: ${missing.join(', ')}.` : '') +
        (vendor === 'openai' ? ' (This test does not check credit or billing.)' : '');
      out.className = 'hint ' + (missing.length ? 'warn' : 'ok');
    } catch (e) {
      if (vendor === 'bedrock' && e.status === 403 && !/invalid|format|signature/i.test(e.message)) {
        out.textContent = 'The key was accepted but may not be allowed to list models. That is fine: type a model ID (for example us.anthropic.claude-opus-5) and run.';
        out.className = 'hint warn';
      } else {
        out.textContent = friendly(e);
        out.className = 'hint err';
      }
    }
  }

  // ---------- Cloud agents (Claude Code ultracode + Codex + Gemini CLI in GitHub Actions) ----------
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
        const done = (it.labels || []).some(l => l.name === 'agent-done');
        ul.append(el('li', {}, el('a', { href: it.html_url, target: '_blank', rel: 'noopener' },
          el('span', { class: 'num' }, '#' + it.number),
          el('span', { class: 't' }, it.title),
          el('span', { class: 'hint' }, `${done ? '✅ finished' : '⏳ working'} · ${it.comments} updates · ${ago(it.created_at)}`))));
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
    let note = 'GitHub opened in a new tab with your task filled in. Click "Create" there to start the cloud agents. Results arrive as comments on that issue, and the list here updates.';
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

  // ---------- KakaoTalk ("send to me" via Kakao REST API; OAuth code flow in the browser) ----------
  const KAUTH = 'https://kauth.kakao.com';
  const KAPI = 'https://kapi.kakao.com';
  // Must match the Redirect URI registered in the Kakao app exactly, so drop a trailing index.html.
  function kakaoRedirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  function kakaoConnected() { return !!(keys.kakaoToken && (keys.kakaoToken.access || keys.kakaoToken.refresh)); }

  function renderKakaoStatus() {
    const s = $('#st-kakao');
    if (!s) return;
    s.textContent = kakaoConnected() ? 'KakaoTalk is connected.' : 'Not connected.';
    s.className = 'hint ' + (kakaoConnected() ? 'ok' : '');
  }

  function kakaoConnect() {
    persistForm();
    if (!keys.kakaoRest) { const s = $('#st-kakao'); s.textContent = 'Paste the Kakao REST API key first.'; s.className = 'hint warn'; return; }
    const stateTok = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('relay.kakaoState', stateTok, SS);
    location.href = `${KAUTH}/oauth/authorize?` + new URLSearchParams({
      client_id: keys.kakaoRest, redirect_uri: kakaoRedirectUri(), response_type: 'code', scope: 'talk_message', state: stateTok,
    });
  }

  async function kakaoToken(params) {
    const body = new URLSearchParams(Object.assign({ client_id: keys.kakaoRest }, params));
    if (keys.kakaoSecret) body.set('client_secret', keys.kakaoSecret);
    const res = await fetch(`${KAUTH}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`Kakao ${res.status}: ${j.error_description || j.error || 'token request failed'}${j.error_code ? ' (' + j.error_code + ')' : ''}`);
    const prev = keys.kakaoToken || {};
    keys.kakaoToken = { access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + (j.expires_in || 0) * 1000 };
    saveKeys();
  }

  // Finish the OAuth round trip when Kakao redirects back with ?code=…
  async function kakaoHandleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has('code') && !p.has('error')) return;
    const expected = store.get('relay.kakaoState', null, SS);
    if (!expected) return; // not our redirect
    store.del('relay.kakaoState', SS);
    history.replaceState(null, '', location.pathname);
    if (p.get('error')) { banner('KakaoTalk connection cancelled: ' + (p.get('error_description') || p.get('error')), 'warn'); return; }
    if (p.get('state') !== expected) { banner('KakaoTalk connection rejected (state mismatch). Press Connect again.', 'error'); return; }
    try {
      await kakaoToken({ grant_type: 'authorization_code', redirect_uri: kakaoRedirectUri(), code: p.get('code') });
      renderStatus();
      banner('KakaoTalk connected. Results can now be sent to your own KakaoTalk chat (Settings → KakaoTalk → turn on "Message me when a run finishes").', 'info');
    } catch (e) { banner('KakaoTalk connection failed: ' + e.message, 'error'); }
  }

  async function kakaoSend(text) {
    if (!kakaoConnected()) throw new Error('KakaoTalk is not connected (Settings → KakaoTalk → Connect).');
    const t = keys.kakaoToken;
    if (!t.access || (t.exp && Date.now() > t.exp - 60000)) {
      if (!t.refresh) throw new Error('KakaoTalk session expired. Press Connect again.');
      await kakaoToken({ grant_type: 'refresh_token', refresh_token: t.refresh });
    }
    const link = location.origin + location.pathname;
    const template = { object_type: 'text', text: String(text).slice(0, 200), link: { web_url: link, mobile_web_url: link }, button_title: 'Open Relay' };
    const send = () => fetch(`${KAPI}/v2/api/talk/memo/default/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.kakaoToken.access}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
    let res = await send();
    if (res.status === 401 && keys.kakaoToken.refresh) {
      await kakaoToken({ grant_type: 'refresh_token', refresh_token: keys.kakaoToken.refresh });
      res = await send();
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.result_code !== 0) {
      const hint = j.code === -402 ? ' Enable the "Send message in KakaoTalk" consent item in your Kakao app, then Connect again.' : '';
      throw new Error(`Kakao ${res.status}: ${j.msg || 'send failed'}${hint}`);
    }
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
    // ?demo=1 (the landing page's "Try the demo" link) opens straight into demo mode.
    const qs = new URLSearchParams(location.search);
    // ?task=…&preset=… (the landing page's "Open in the app" links) prefill the task and pipeline.
    const qTask = qs.get('task');
    const qPreset = qs.get('preset');
    if (qs.get('demo') === '1') { settings.demo = true; saveSettings(); }
    if (qPreset && PRESETS[qPreset]) { state.pipeline = fromPreset(qPreset); savePipeline(); }
    if (qTask) store.set('relay.draft', qTask.slice(0, 20000));
    ['demo', 'task', 'preset'].forEach(k => qs.delete(k));
    if (location.search && !qs.has('code') && !qs.has('error')) history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : ''));
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
    $('#demo-toggle').addEventListener('change', e => { settings.demo = e.target.checked; saveSettings(); renderAll(); });

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
        const okSlot = m => m === ALL || !!SLOTS[m];
        const stages = (j.stages || []).filter(s => s && TYPES[s.type] && Array.isArray(s.models) && s.models.length && s.models.every(okSlot) && typeof s.prompt === 'string')
          .map(s => window.Engine.stage(String(s.title || 'Stage'), s.type, s.type === 'agent' ? [s.models.find(m => m !== ALL) || 'claude'] : s.models, s.prompt,
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
    $('#kakao-final').addEventListener('click', async e => {
      if (!kakaoConnected()) { banner('Connect KakaoTalk first (Settings → KakaoTalk).', 'warn'); openSettings(); return; }
      const btn = e.currentTarget;
      try {
        await kakaoSend(`${oneLine(state.lastTask, 60)}\n\n${oneLine(state.lastFinal, 180)}`);
        btn.textContent = 'Sent ✓'; setTimeout(() => { btn.textContent = 'KakaoTalk'; }, 1500);
      } catch (err) { banner('KakaoTalk: ' + err.message, 'error'); }
    });
    $$('[data-copy]').forEach(b => b.addEventListener('click', () => copyText($('#' + b.dataset.copy).textContent, b)));

    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-history').addEventListener('click', () => { renderHistory(); $('#history').showModal(); });
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
    for (const v of Object.keys(VENDORS)) $('#load-' + v).addEventListener('click', () => testKey(v));
    $('#compat-provider').addEventListener('change', e => {
      const c = COMPAT[e.target.value] || COMPAT.custom;
      $('#compat-base').value = c.base;
      $('#m-compat').value = c.model;
      $('#dl-compat').textContent = '';
    });
    $('#kakao-connect').addEventListener('click', kakaoConnect);
    $('#kakao-disconnect').addEventListener('click', () => { keys.kakaoToken = null; saveKeys(); renderKakaoStatus(); renderStatus(); });
    // The cloud workflow needs this token as a repository secret, and it was
    // previously stored but never shown — so the documented setup step could
    // not actually be carried out.
    $('#kakao-copy-refresh').addEventListener('click', ev => {
      const refresh = keys.kakaoToken && keys.kakaoToken.refresh;
      if (!refresh) { banner('Connect KakaoTalk first — there is no refresh token yet.', 'warn'); return; }
      copyText(refresh, ev.currentTarget);
      banner('Refresh token copied. Add it as the KAKAO_REFRESH_TOKEN repository secret (Settings → Secrets and variables → Actions). Treat it like a password.', 'ok');
    });
    $('#kakao-test').addEventListener('click', async () => {
      const s = $('#st-kakao');
      try { await kakaoSend('👋 Relay is connected to your KakaoTalk. Run results will arrive here.'); s.textContent = 'Test message sent. Check KakaoTalk ("나와의 채팅").'; s.className = 'hint ok'; }
      catch (err) { s.textContent = err.message; s.className = 'hint err'; }
    });
    $('#save-settings').addEventListener('click', () => {
      persistForm();
      $('#settings').close(); renderAll(); loadCloudRuns();
      const n = connectedMain().length;
      banner(settings.demo ? 'Settings saved. Demo is still on; switch it off in the header to go live.'
        : `Settings saved. ${n} provider${n === 1 ? '' : 's'} connected; runs are live and bill your keys.`, 'info');
    });
    $('#clear-keys').addEventListener('click', () => {
      keys = Object.assign({}, EMPTY_KEYS); saveKeys();
      for (const [id] of FIELDS.filter(f => /^key-|^kakao-/.test(f[0]))) $('#' + id).value = '';
      renderStatus(); renderKakaoStatus();
    });
    $('#reset-settings').addEventListener('click', () => {
      const keep = { remember: settings.remember };
      Object.assign(settings, DEFAULT_SETTINGS, keep, { demo: !Object.keys(VENDORS).some(v => keys[v]) });
      saveSettings(); openSettings(); renderAll();
    });
    $('#clear-history').addEventListener('click', () => { store.del('relay.history'); renderHistory(); });

    window.addEventListener('beforeunload', e => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });

    renderAll();
    loadCloudRuns();
    kakaoHandleRedirect();
  }

  init();
})();
