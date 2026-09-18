/* Relay landing page: the "Try the router" box runs the app's real router (app/engine.js). */
(function () {
  'use strict';

  const input = document.getElementById('rt-input');
  const result = document.getElementById('rt-result');
  const examples = document.getElementById('rt-examples');
  if (!input || !result || !examples || !window.Engine) return;

  const { route, PRESETS } = window.Engine;
  const EXAMPLES = [
    'fix a typo in the README',
    'ask all the models which database a small startup should use',
    'audit this login function for security bugs',
    'migrate every component under src/ to TypeScript, about 40 files',
    'compare Postgres vs MongoDB for our marketplace',
    'change the production billing configuration',
    'ultracode: design a production-ready rate limiter with tests',
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function show(text) {
    const r = route(text);
    result.textContent = '';
    if (!r) { result.append(el('p', 'rt-empty', 'Type a task, or pick an example.')); return; }
    const p = PRESETS[r.preset];
    const head = el('div', 'rt-head');
    head.append(el('span', 'rt-kind', r.kind), el('span', 'rt-name', '→ ' + p.name), el('span', 'rt-tag', 'effort: ' + r.effort));
    result.append(head, el('p', 'rt-blurb', p.blurb));
    const why = el('ul', 'rt-why');
    r.reasons.forEach(x => why.append(el('li', null, x)));
    result.append(why);
    if (r.warnings.length) {
      const warn = el('ul', 'rt-warn');
      r.warnings.forEach(x => warn.append(el('li', null, x)));
      result.append(warn);
    }
    const open = el('a', 'rt-open', 'Run it in the app →');
    open.href = 'app/';
    result.append(open);
  }

  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => show(input.value), 120); });
  for (const ex of EXAMPLES) {
    const b = el('button', null, ex);
    b.type = 'button';
    b.addEventListener('click', () => { input.value = ex; show(ex); });
    examples.append(b);
  }
  // Start with a worked example so the box is never empty on first view.
  input.value = EXAMPLES[3];
  show(input.value);
})();
