/* Relay — orchestration engine.
 * Presets, auto-router, prompt templating, fan-out, budgets and pricing.
 * No DOM access and no network access: the UI injects `ui` and `call`. */
(function () {
  'use strict';

  // Model "slots". Pipelines reference slots, never raw model IDs, so changing
  // a model in Settings updates every pipeline at once.
  const SLOTS = {
    claude:        { vendor: 'anthropic', label: 'Claude',        setting: 'modelClaude' },
    'claude-fast': { vendor: 'anthropic', label: 'Claude · fast', setting: 'modelClaudeFast' },
    gpt:           { vendor: 'openai',    label: 'GPT',           setting: 'modelGpt' },
    'gpt-fast':    { vendor: 'openai',    label: 'GPT · fast',    setting: 'modelGptFast' },
    gemini:        { vendor: 'gemini',    label: 'Gemini',        setting: 'modelGemini' },
    bedrock:       { vendor: 'bedrock',   label: 'AWS Bedrock',   setting: 'modelBedrock' },
    any:           { vendor: 'compat',    label: 'Any API',       setting: 'modelCompat' },
  };
  // One "main" slot per provider, in the order Council and substitution prefer them.
  const MAIN_SLOTS = ['claude', 'gpt', 'gemini', 'bedrock', 'any'];
  const ALL = '@all'; // pseudo-slot: every connected provider
  const SWAP = { claude: 'gpt', gpt: 'claude', 'claude-fast': 'gpt-fast', 'gpt-fast': 'claude-fast' };
  const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  const TYPES = {
    agent: 'Single agent',
    parallel: 'Parallel — same prompt, several models',
    map: 'Fan-out — one agent per item',
  };

  // $ per 1M tokens [input, output]. Estimates; editable in Settings.
  const DEFAULT_PRICES = {
    'claude-fable-5-1': [10, 50],
    'claude-fable-5': [10, 50],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-4-5': [1, 5],
    'gpt-6-astra': [10, 50],
    'gpt-5.6-sol': [5, 30],
    'gpt-5.6-terra': [2, 12],
    'gpt-5.6-luna': [0.2, 1.2],
    'gemini-3.5-flash': [1.5, 9],
  };

  function stage(title, type, models, prompt, extra) {
    return Object.assign({ title, type, models, prompt, system: '', effort: 'default', mapFrom: '' }, extra || {});
  }

  // ---------- Prompt building blocks (shared by presets) ----------
  const REVIEWER_SYSTEM = 'You are a rigorous reviewer from a different lab than the author. Your job is to find what is wrong, missing, or risky, not to be agreeable.';
  const PLANNER_SYSTEM = 'You are the planner in a multi-agent workflow. You never do the work yourself; you split it.';
  const VERIFIER_SYSTEM = 'You are a skeptical verifier. Assume there are mistakes until you have checked.';

  const PLAN = `Split the task below into independent subtasks for separate worker agents that run in parallel and cannot see each other or this conversation. Each subtask must be self-contained: include every piece of context the worker needs, and say exactly what to produce. Use between 2 and {{maxItems}} subtasks; fewer is better when the task is small.

Task:
{{task}}

Respond with ONLY a JSON array of strings, one string per subtask.`;

  const WORK = `You are one worker in a larger job. Other workers handle the other parts.

Overall task (context only):
{{task}}

Your subtask ({{index}} of {{count}}):
{{item}}

Complete only your subtask, fully and concretely.`;

  const REFUTE = `Overall task:
{{task}}

Worker results:
{{s2}}

Try to refute each result. Report factual errors, contradictions between workers, gaps against the overall task, and unsupported claims, as a numbered list with the fix for each. Mark results that survive scrutiny as OK.`;

  const SYNTH = `Overall task:
{{task}}

Worker results:
{{s2}}

Verifier findings:
{{s3}}

Write the single final deliverable for the overall task: merge the worker results, apply the verifiers' valid fixes, resolve contradictions, and remove duplication. Output only the final deliverable.`;

  const review = src => `Task:
{{task}}

Draft answer:
{{${src}}}

Review the draft against the task. List concrete problems (errors, gaps, unsupported claims, risky assumptions, unclear parts), most important first. Quote what you object to and say how to fix it. Do not rewrite the whole answer and do not praise what is fine.`;

  const revise = (draft, rev) => `Task:
{{task}}

Your draft:
{{${draft}}}

Independent review from another model:
{{${rev}}}

Write the final answer. Apply every review point that is correct; ignore any that are wrong. Output the final deliverable only, then a short section "Review points rejected" listing any you ignored and why (omit that section if there are none).`;

  const PRESETS = {
    solo: {
      name: 'Solo',
      blurb: 'One agent. The lowest rung, and enough for most tasks.',
      build: () => [stage('Answer', 'agent', ['claude'], '{{task}}')],
    },
    compare: {
      name: 'Compare',
      blurb: 'Claude and GPT answer in parallel, side by side.',
      build: () => [stage('Both answer', 'parallel', ['claude', 'gpt'], '{{task}}')],
    },
    relay: {
      name: 'Relay',
      blurb: 'Claude drafts → GPT attacks the draft → Claude revises.',
      build: () => [
        stage('Draft', 'agent', ['claude'], '{{task}}'),
        stage('Cross-vendor review', 'agent', ['gpt'], review('s1'), { system: REVIEWER_SYSTEM }),
        stage('Revise', 'agent', ['claude'], revise('s1', 's2')),
      ],
    },
    debate: {
      name: 'Debate',
      blurb: 'Both answer, both cross-examine, then a judge decides.',
      build: () => [
        stage('Independent answers', 'parallel', ['claude', 'gpt'], '{{task}}'),
        stage('Cross-examination', 'parallel', ['claude', 'gpt'],
`Task:
{{task}}

Two independent answers, from different models:
{{s1}}

Critique both answers, including the one that may be yours. For each point where they disagree or either is wrong, decide what is correct and why. Then give your best improved answer.`),
        stage('Judge', 'agent', ['claude'],
`Task:
{{task}}

Two models have answered and then cross-examined each other:
{{s2}}

You are the final judge. Produce the single best answer to the task. Where the models still disagree, pick a side and justify it in one sentence. Output the final answer only.`),
      ],
    },
    fanout: {
      name: 'Fan-out',
      blurb: 'Plan → parallel workers on both vendors → adversarial verify → synthesize.',
      build: () => [
        stage('Plan', 'agent', ['claude'], PLAN, { system: PLANNER_SYSTEM }),
        stage('Workers', 'map', ['claude', 'gpt'], WORK, { mapFrom: 's1' }),
        stage('Adversarial verify', 'agent', ['gpt'], REFUTE, { system: VERIFIER_SYSTEM }),
        stage('Synthesize', 'agent', ['claude'], SYNTH),
      ],
    },
    council: {
      name: 'Council',
      blurb: 'Every connected AI (Claude, GPT, Gemini, AWS, Any API) answers at once, then a judge merges them.',
      build: () => [
        stage('Every model answers', 'parallel', [ALL], '{{task}}'),
        stage('Judge', 'agent', ['claude'],
`Task:
{{task}}

Independent answers from different AI models:
{{s1}}

You are the judge. Where the answers agree, that is likely right; where they disagree, decide who is right and say why in one line each. Then write the single best final answer to the task.`),
      ],
    },
    ultra: {
      name: 'Ultra',
      blurb: 'Both vendors at every step: plan → workers → two refuters → synthesize → attack → fix.',
      build: () => {
        const s = [
          stage('Plan', 'agent', ['claude'], PLAN, { system: PLANNER_SYSTEM }),
          stage('Workers', 'map', ['claude', 'gpt'], WORK, { mapFrom: 's1' }),
          stage('Two-vendor refute', 'parallel', ['gpt', 'claude'], REFUTE, { system: VERIFIER_SYSTEM }),
          stage('Synthesize', 'agent', ['claude'], SYNTH),
          stage('Final attack', 'agent', ['gpt'], review('s4'), { system: REVIEWER_SYSTEM }),
          stage('Final fix', 'agent', ['claude'], revise('s4', 's5')),
        ];
        s.forEach(x => { x.effort = 'xhigh'; });
        return s;
      },
    },
  };

  // ---------- Auto-router: cheapest rung that fits the task ----------
  const NOUNS = 'files?|components?|pages?|endpoints?|routes?|items?|modules?|tests?|tickets?|repos?|functions?|services?|documents?|docs?|urls?|rows?|products?|questions?|topics?|sections?|chapters?|articles?|emails?|records?|screens?|tables?';
  const ULTRA_PREFIX = /^\s*(ultra(code)?|ultra ?codex)\s*:\s*/i;

  function route(task) {
    const t = (task || '').toLowerCase();
    if (!t.trim()) return null;
    const reasons = [];
    const warnings = [];
    // "40 files", "about 12 React components", "6 microservices"
    const scaleHits = [...t.matchAll(new RegExp(`\\b(\\d{1,5})\\s*\\+?\\s*(?:[\\w-]+\\s)?[\\w-]*?(?:${NOUNS})\\b`, 'g'))];
    const scale = scaleHits.length ? Math.max(...scaleHits.map(m => +m[1])) : null;
    const ultra = ULTRA_PREFIX.test(t) || /\b(ultra(code)?|max(imum)? (effort|quality)|most thorough|best possible|no matter (the )?cost)\b/.test(t);
    const council = /\b(all (the )?(models|ais|apis|providers|clouds)|every (model|ai|provider|cloud)|council|consensus|ask everyone|gemini and|and gemini)\b/.test(t);
    const fanWords = /\b(every|each|all (the |of the )?|across the (whole|entire)|sweep|in bulk|batch|for each)\b/.test(t);
    const fanNouns = new RegExp(`(${NOUNS})\\b`).test(t);
    const risky = /\b(prod|production|live (data|db|database)|migrat\w*|drop table|delete|payments?|billing|auth\w*|credentials?|secrets?|security|deploy\w*|infra\w*|terraform|kubernetes|money|legal|medical|compliance)\b/.test(t);
    const audit = /\b(audit|verify|verified|review|prove|fact[- ]?check|double[- ]?check|correctness|find (bugs|issues|errors|flaws)|vulnerab\w*)\b/.test(t);
    const compare = /\b(compare|comparison|vs\.?|versus|second opinion|which is better|pros and cons)\b/.test(t);
    const trivial = t.length < 100 && /\b(typo|spelling|rename|one[- ]liner|quick|simple|small|tiny|reformat|translate|define|what is|convert|summari[sz]e this)\b/.test(t);
    const needsRepo = /\b(repo|repository|codebase|src\/|pull request|my files|directory|folder)\b/.test(t);

    let r;
    if (ultra) {
      reasons.push('You asked for maximum orchestration: Claude and GPT at every step, each checking the other');
      warnings.push('Ultra is the most expensive rung: about (subtasks + 7) agent calls at xhigh effort.');
      r = { kind: 'ultra', preset: 'ultra', effort: 'xhigh' };
    } else if (council) {
      reasons.push('You asked for every model: all connected providers answer in parallel, then a judge merges them');
      r = { kind: 'council', preset: 'council', effort: 'high' };
    } else if ((fanWords && (fanNouns || (scale && scale >= 4))) || (scale && scale >= 8)) {
      reasons.push('Fan-out shape: many items treated the same way');
      r = { kind: 'fan-out', preset: 'fanout', effort: 'xhigh' };
    } else if (risky) {
      reasons.push('High blast radius: a second vendor should attack the draft');
      warnings.push('Nothing here touches your systems, but review the output yourself before acting on it.');
      r = { kind: 'high blast radius', preset: 'relay', effort: 'max' };
    } else if (audit) {
      reasons.push('Verification task: independent answers + cross-examination beat one confident pass');
      r = { kind: 'audit, verified', preset: 'debate', effort: 'high' };
    } else if (compare) {
      reasons.push('You asked for a comparison or second opinion');
      r = { kind: 'comparison', preset: 'compare', effort: 'high' };
    } else if (trivial) {
      reasons.push('Small, well-specified task: one fast agent at low effort');
      r = { kind: 'trivial', preset: 'solo', effort: 'low', slot: 'claude-fast' };
    } else {
      reasons.push('Ordinary task: one agent is enough, so don\'t pay for orchestration');
      r = { kind: 'ordinary', preset: 'solo', effort: 'high' };
    }
    if (scale && (r.preset === 'fanout' || r.preset === 'ultra')) reasons.push(`Stated scale ~${scale} items`);
    if (needsRepo) warnings.push('Relay cannot read your files or repo. Paste the relevant code into the task, or hand off to the CLI (bottom of the panel).');
    return Object.assign(r, { reasons, warnings, scale });
  }

  // The "ultracode:" prefix is a routing hint for Relay, not something the models need to see.
  function cleanTask(task) {
    const t = String(task || '').replace(ULTRA_PREFIX, '').trim();
    return t || String(task || '').trim();
  }

  // ---------- Helpers ----------
  function render(tpl, vars) {
    return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : m));
  }

  function oneLine(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return n && t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // Pull a list of work items out of a model's output: JSON array first, then bullets.
  function extractItems(text) {
    const src = String(text || '');
    const candidates = [];
    const fence = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1]);
    const a = src.indexOf('['), b = src.lastIndexOf(']');
    if (a !== -1 && b > a) candidates.push(src.slice(a, b + 1));
    for (const c of candidates) {
      try {
        const arr = JSON.parse(c);
        if (Array.isArray(arr)) {
          const items = arr.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).map(s => s.trim()).filter(Boolean);
          if (items.length) return items;
        }
      } catch (_) { /* try next candidate */ }
    }
    const bullets = src.split('\n')
      .map(l => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/))
      .filter(Boolean).map(m => m[1].trim()).filter(Boolean);
    if (bullets.length) return bullets;
    return src.trim() ? [src.trim()] : [];
  }

  async function pool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
  }

  function isAbort(e) { return !!e && (e.name === 'AbortError'); }

  function priceFor(model, prices) {
    if (!model || !prices) return null;
    // Bedrock IDs like "us.anthropic.claude-opus-5" price like "claude-opus-5".
    model = model.replace(/^((us|eu|apac|jp|au|global|us-gov)\.)?anthropic\./, '').replace(/-v\d+:\d+$/, '');
    if (prices[model]) return prices[model];
    const key = Object.keys(prices).filter(p => model.startsWith(p)).sort((x, y) => y.length - x.length)[0];
    return key ? prices[key] : null;
  }

  // usage is normalized by the providers: input = uncached input tokens.
  // Cache reads bill at ~10% of input, cache writes at 125%.
  function cost(model, usage, prices) {
    const p = priceFor(model, prices);
    if (!p || !usage) return null;
    const [pin, pout] = p;
    const inTok = usage.input + usage.cacheRead * 0.1 + usage.cacheWrite * 1.25;
    return (inTok * pin + usage.output * pout) / 1e6;
  }

  function estimateCalls(stages, maxItems, allCount) {
    let min = 0, max = 0;
    const width = models => models.reduce((n, m) => n + (m === ALL ? (allCount || 1) : 1), 0);
    for (const s of stages) {
      if (s.type === 'agent') { min += 1; max += 1; }
      else if (s.type === 'parallel') { min += width(s.models); max += width(s.models); }
      else if (s.type === 'map') { min += 1; max += maxItems; }
    }
    return { min, max };
  }

  // ---------- Runner ----------
  // ui.stageStart(stage, index, total) -> { addPane(slot, item), note(msg), done(output), fail(err) }
  // call(slot, system, prompt, effort, pane, signal) -> { text, usage, model }
  async function runPipeline({ task, stages, settings, signal, ui, call }) {
    const outputs = {};
    let prev = '';
    let calls = 0;
    let prevModels = []; // models the previous stage ran on; stand-ins avoid them so reviews stay cross-vendor
    const vars = extra => Object.assign({ task, prev, maxItems: settings.maxItems }, outputs, extra || {});

    const guarded = async (slot, system, prompt, effort, pane) => {
      if (signal.aborted) throw abortError();
      calls += 1;
      if (calls > settings.maxCalls) {
        const e = new Error(`Call budget reached (${settings.maxCalls} calls per run). Raise "Max agent calls per run" in Settings.`);
        pane.fail(e);
        throw e;
      }
      return call(slot, system, prompt, effort, pane, signal);
    };

    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const sid = 's' + (i + 1);
      const sv = ui.stageStart(st, i, stages.length);
      const effort = settings.effortOverride && settings.effortOverride !== 'stage' ? settings.effortOverride : st.effort;
      const system = render(st.system, vars());
      try {
        // Expand "@all" and stand in connected providers for unconnected ones.
        const resolved = settings.resolveModels ? settings.resolveModels(st.models, st.type, prevModels) : { models: st.models, notes: [] };
        resolved.notes.forEach(n => sv.note(n));
        const models = resolved.models;
        prevModels = models;
        if (!models.length) throw new Error('No AI provider is connected for this stage. Add a key in Settings, or turn on Demo.');
        let out;
        if (st.type === 'agent') {
          const slot = models[0];
          const r = await guarded(slot, system, render(st.prompt, vars()), effort, sv.addPane(slot));
          out = r.text;
        } else if (st.type === 'parallel') {
          const prompt = render(st.prompt, vars());
          const panes = models.map(m => sv.addPane(m));
          const res = await Promise.allSettled(models.map((m, j) => guarded(m, system, prompt, effort, panes[j])));
          const aborted = res.find(r => r.status === 'rejected' && isAbort(r.reason));
          if (aborted) throw aborted.reason;
          const ok = res.map((r, j) => (r.status === 'fulfilled' ? `### ${SLOTS[models[j]].label}\n\n${r.value.text}` : null)).filter(Boolean);
          if (!ok.length) throw res[0].reason;
          if (ok.length < res.length) sv.note(`${res.length - ok.length} of ${res.length} models failed; continuing with the rest.`);
          out = ok.join('\n\n---\n\n');
        } else if (st.type === 'map') {
          const src = st.mapFrom && outputs[st.mapFrom] != null ? outputs[st.mapFrom] : prev;
          let items = extractItems(src);
          if (!items.length) throw new Error('Nothing to fan out over: the source stage produced no items.');
          if (items.length > settings.maxItems) {
            sv.note(`Source produced ${items.length} items; capped at ${settings.maxItems} (Settings → Max fan-out items).`);
            items = items.slice(0, settings.maxItems);
          }
          const slotFor = j => models[j % models.length];
          const panes = items.map((it, j) => sv.addPane(slotFor(j), `${j + 1}. ${it}`));
          const res = await pool(items, settings.concurrency, (it, j) =>
            guarded(slotFor(j), system, render(st.prompt, vars({ item: it, index: j + 1, count: items.length })), effort, panes[j])
              .catch(e => { if (isAbort(e) || /Call budget/.test(e.message)) throw e; return null; }));
          const okCount = res.filter(Boolean).length;
          if (!okCount) throw new Error('Every worker in this fan-out failed.');
          if (okCount < items.length) sv.note(`${items.length - okCount} of ${items.length} workers failed; their items are marked and excluded.`);
          out = items.map((it, j) => `### ${j + 1}. ${oneLine(it, 120)}\n\n${res[j] ? res[j].text : '_(worker failed; excluded)_'}`).join('\n\n');
        } else {
          throw new Error(`Unknown stage type "${st.type}".`);
        }
        outputs[sid] = out;
        prev = out;
        sv.done(out);
      } catch (e) {
        sv.fail(e);
        throw e;
      }
    }
    return { final: prev, outputs, calls };
  }

  function abortError() {
    try { return new DOMException('Aborted', 'AbortError'); } catch (_) { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
  }

  window.Engine = {
    SLOTS, MAIN_SLOTS, ALL, SWAP, EFFORTS, TYPES, PRESETS, DEFAULT_PRICES,
    stage, route, cleanTask, render, oneLine, extractItems, pool, isAbort, abortError, cost, estimateCalls, runPipeline,
  };
})();
