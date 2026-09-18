/* Relay — provider adapters.
 * The browser talks to each vendor's API directly (all verified to allow CORS).
 * API keys go only to the base URL configured in Settings (the vendor, by default). */
(function () {
  'use strict';

  const { oneLine, abortError } = window.Engine;

  // Claude models that take adaptive thinking + output_config.effort.
  const ANTHROPIC_ADAPTIVE = /claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable|mythos)/;
  // Claude models where server-side refusal fallback ("fallbacks": "default") applies.
  const ANTHROPIC_FALLBACK = /claude-(opus-5|fable-5)/;

  // Minimal SSE parser over a fetch Response body.
  async function* sse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const sep = /\r?\n\r?\n/;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = sep.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let event = 'message', data = '';
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
        }
        if (!data || data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch (_) { continue; }
        yield { event, data: json };
      }
    }
  }

  async function httpError(res, vendor) {
    let detail = '';
    try {
      const j = await res.json();
      const e = Array.isArray(j) ? j[0] && j[0].error : j && j.error;
      detail = (e && (e.message || e.type)) || (j && (j.message || j.Message || j.detail || j.msg || j.error_description)) || JSON.stringify(j);
    } catch (_) {
      try { detail = await res.text(); } catch (__) { /* ignore */ }
    }
    const e = new Error(`${vendor} HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    e.status = res.status;
    return e;
  }

  function emptyUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
  function isNetworkError(e) { return !!e && e.name === 'TypeError'; }

  // POST, and if the API rejects one of our *optional* parameters with a 400
  // (a beta the account lacks, an effort level the model doesn't support…),
  // drop that parameter and retry. Each optional param is dropped at most once.
  async function postWithDowngrade(url, headers, body, o, vendor, optional) {
    for (;;) {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
      if (res.ok) return res;
      const err = await httpError(res, vendor);
      const opt = res.status === 400 && optional.find(p => p.present() && p.match.test(err.message));
      if (!opt) throw err;
      opt.drop();
      o.onNote && o.onNote(`${vendor} rejected ${opt.name} for ${o.model}, so it retried without it. (${err.message})`);
    }
  }

  // ---------- Anthropic Messages API ----------
  async function callAnthropic(o) {
    const body = { model: o.model, max_tokens: o.maxTokens, stream: true, messages: [{ role: 'user', content: o.prompt }] };
    if (o.system) body.system = o.system;
    const headers = {
      'content-type': 'application/json',
      'x-api-key': o.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (ANTHROPIC_ADAPTIVE.test(o.model)) {
      if (o.showThinking) body.thinking = { type: 'adaptive', display: 'summarized' };
      if (o.effort && o.effort !== 'default') body.output_config = { effort: o.effort };
    }
    if (o.fallbacks && ANTHROPIC_FALLBACK.test(o.model)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }

    const res = await postWithDowngrade(`${o.baseUrl}/v1/messages`, headers, body, o, 'Anthropic', [
      { name: 'the refusal-fallback beta', match: /fallback|beta/i, present: () => 'fallbacks' in body,
        drop: () => { delete body.fallbacks; delete headers['anthropic-beta']; } },
      { name: 'reasoning summaries', match: /thinking|display|adaptive/i, present: () => 'thinking' in body,
        drop: () => { delete body.thinking; } },
      { name: `effort "${o.effort}"`, match: /effort|output_config/i, present: () => 'output_config' in body,
        drop: () => { delete body.output_config; } },
    ]);

    const usage = emptyUsage();
    let text = '', stop = null, model = o.model;
    for await (const { data } of sse(res)) {
      switch (data.type) {
        case 'message_start': {
          const u = (data.message && data.message.usage) || {};
          usage.input = u.input_tokens || 0;
          usage.output = u.output_tokens || 0;
          usage.cacheRead = u.cache_read_input_tokens || 0;
          usage.cacheWrite = u.cache_creation_input_tokens || 0;
          if (data.message && data.message.model) model = data.message.model;
          break;
        }
        case 'content_block_start':
          if (data.content_block && data.content_block.type === 'fallback') {
            const to = data.content_block.to && data.content_block.to.model;
            o.onNote && o.onNote(`Refusal fallback: continued on ${to || 'another model'}.`);
            if (to) model = to;
          }
          break;
        case 'content_block_delta':
          if (data.delta.type === 'text_delta') { text += data.delta.text; o.onText && o.onText(data.delta.text); }
          else if (data.delta.type === 'thinking_delta') { o.onThinking && o.onThinking(data.delta.thinking); }
          break;
        case 'message_delta':
          if (data.usage) {
            if (data.usage.output_tokens != null) usage.output = data.usage.output_tokens;
            if (data.usage.input_tokens != null) usage.input = data.usage.input_tokens;
          }
          if (data.delta && data.delta.stop_reason) stop = data.delta.stop_reason;
          break;
        case 'error':
          throw new Error('Anthropic stream error: ' + ((data.error && data.error.message) || 'unknown'));
        default:
          break;
      }
    }
    if (stop === 'refusal') o.onNote && o.onNote('The model declined this request (stop_reason: refusal).');
    if (stop === 'max_tokens') o.onNote && o.onNote('Hit max_tokens, so the output is truncated. Raise it in Settings.');
    return { text, usage, stop, model };
  }

  // ---------- OpenAI Responses API ----------
  async function callOpenAI(o) {
    const body = { model: o.model, input: o.prompt, stream: true, store: false };
    if (o.system) body.instructions = o.system;
    if (o.effort && o.effort !== 'default') body.reasoning = { effort: o.effort === 'max' ? 'xhigh' : o.effort };

    const headers = { 'content-type': 'application/json', authorization: `Bearer ${o.key}` };
    const url = `${o.baseUrl}/v1/responses`;
    let res;
    try {
      res = await postWithDowngrade(url, headers, body, o, 'OpenAI', [
        { name: `reasoning effort "${body.reasoning && body.reasoning.effort}"`, match: /reasoning|effort/i, present: () => 'reasoning' in body,
          drop: () => { delete body.reasoning; } },
        { name: 'store: false', match: /\bstore\b/i, present: () => 'store' in body,
          drop: () => { delete body.store; } },
      ]);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      res = await openaiRecover(url, headers, body, o, e);
    }
    if (!body.stream) return readOpenAIJson(res, o);

    const usage = emptyUsage();
    let text = '', stop = null, model = o.model;
    for await (const { event, data } of sse(res)) {
      const t = data.type || event;
      if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        text += data.delta; o.onText && o.onText(data.delta);
      } else if (t === 'response.reasoning_summary_text.delta') {
        o.onThinking && o.onThinking(data.delta);
      } else if (t === 'response.completed' || t === 'response.incomplete') {
        const r = data.response || {};
        const u = r.usage || {};
        // OpenAI's input_tokens includes cached tokens; normalize to Anthropic's shape (uncached + cacheRead).
        usage.cacheRead = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
        usage.input = Math.max(0, (u.input_tokens || 0) - usage.cacheRead);
        usage.output = u.output_tokens || 0;
        if (r.model) model = r.model;
        stop = t === 'response.completed' ? 'completed' : 'incomplete';
        if (t === 'response.incomplete') {
          o.onNote && o.onNote(`Response incomplete: ${(r.incomplete_details && r.incomplete_details.reason) || 'unknown reason'}.`);
        }
      } else if (t === 'response.failed') {
        const err = data.response && data.response.error;
        throw new Error('OpenAI: ' + ((err && err.message) || 'response failed'));
      } else if (t === 'error') {
        throw new Error('OpenAI stream error: ' + (data.message || (data.error && data.error.message) || 'unknown'));
      }
    }
    return { text, usage, stop, model };
  }

  // OpenAI's *error* responses to POST /v1/responses carry no CORS headers, so the
  // browser hides them and fetch() just throws "Failed to fetch": a bad key, an
  // unknown model, a 400 or a 429 all look like a network failure. GET /v1/models
  // does send CORS headers on errors, so use it to find the real cause, then retry
  // the variants that commonly fix it.
  async function openaiRecover(url, headers, body, o, netErr) {
    let ids;
    try { ids = await fetchOpenAIModelIds(o.key, o.baseUrl, o.signal); }
    catch (e) { throw e.status ? e : netErr; } // 401 → real "key rejected"; otherwise truly unreachable
    if (!ids.includes(o.model)) {
      const chat = ids.filter(id => /^(gpt|o\d|chatgpt)/.test(id)).sort().reverse();
      const e = new Error(`OpenAI HTTP 404: model "${o.model}" is not available to this API key. Pick one in Settings → Models. This key has: ${chat.slice(0, 8).join(', ') || 'no chat models'}${chat.length > 8 ? ', …' : ''}`);
      e.status = 404;
      throw e;
    }
    const attempts = [
      { what: 'without optional settings (reasoning effort, store)', apply: () => { delete body.reasoning; delete body.store; } },
      { what: 'without streaming (some models require a verified organization to stream)', apply: () => { body.stream = false; } },
    ];
    for (const a of attempts) {
      a.apply();
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
        if (!res.ok) throw await httpError(res, 'OpenAI');
        o.onNote && o.onNote(`OpenAI rejected the first request without saying why (browsers hide its error details), so Relay retried ${a.what}, and that worked.`);
        return res;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }
    const e = new Error(`OpenAI rejected the request. Your key works and "${o.model}" is available to it, so the cause is on the account side. The most common is no credit or a spending limit reached (platform.openai.com → Settings → Billing), then rate limits. The browser hides OpenAI's exact error, so check the usage page to confirm.`);
    e.status = 429;
    throw e;
  }

  async function readOpenAIJson(res, o) {
    const r = await res.json();
    let text = '';
    for (const item of r.output || []) {
      for (const c of item.content || []) {
        if (c.type === 'output_text') text += c.text || '';
        else if (c.type === 'refusal') text += c.refusal || '';
      }
    }
    if (text) o.onText && o.onText(text);
    const u = r.usage || {};
    const cacheRead = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
    if (r.status === 'incomplete') o.onNote && o.onNote(`Response incomplete: ${(r.incomplete_details && r.incomplete_details.reason) || 'unknown reason'}.`);
    return {
      text,
      usage: { input: Math.max(0, (u.input_tokens || 0) - cacheRead), output: u.output_tokens || 0, cacheRead, cacheWrite: 0 },
      stop: r.status,
      model: r.model || o.model,
    };
  }

  // ---------- Google Gemini API (generateContent, SSE) ----------
  const GEMINI_LEVEL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

  async function callGemini(o) {
    const body = { contents: [{ role: 'user', parts: [{ text: o.prompt }] }] };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    const thinking = {};
    if (o.showThinking) thinking.includeThoughts = true;
    if (o.effort && o.effort !== 'default') thinking.thinkingLevel = GEMINI_LEVEL[o.effort] || 'high';
    if (Object.keys(thinking).length) body.generationConfig = { thinkingConfig: thinking };
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': o.key };
    const url = `${o.baseUrl}/v1beta/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`;

    const res = await postWithDowngrade(url, headers, body, o, 'Gemini', [
      { name: 'thinking settings', match: /thinking|thought/i, present: () => 'generationConfig' in body,
        drop: () => { delete body.generationConfig; } },
    ]);

    const usage = emptyUsage();
    let text = '', stop = null, model = o.model;
    for await (const { data } of sse(res)) {
      if (data.error) throw new Error('Gemini stream error: ' + (data.error.message || 'unknown'));
      if (data.promptFeedback && data.promptFeedback.blockReason) {
        throw new Error(`Gemini blocked the prompt (${data.promptFeedback.blockReason}).`);
      }
      const cand = (data.candidates || [])[0];
      for (const part of (cand && cand.content && cand.content.parts) || []) {
        if (!part.text) continue;
        if (part.thought) { o.onThinking && o.onThinking(part.text); }
        else { text += part.text; o.onText && o.onText(part.text); }
      }
      if (cand && cand.finishReason) stop = cand.finishReason;
      const u = data.usageMetadata;
      if (u) {
        usage.cacheRead = u.cachedContentTokenCount || 0;
        usage.input = Math.max(0, (u.promptTokenCount || 0) - usage.cacheRead);
        usage.output = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
      }
      if (data.modelVersion) model = data.modelVersion;
    }
    if (stop === 'MAX_TOKENS') o.onNote && o.onNote('Gemini hit its output limit, so the answer is truncated.');
    else if (stop && !/^(STOP|FINISH_REASON_UNSPECIFIED)$/.test(stop)) o.onNote && o.onNote(`Gemini stopped early: ${stop}.`);
    return { text, usage, stop, model };
  }

  // ---------- Amazon Bedrock (Converse API, Bedrock API key) ----------
  async function callBedrock(o) {
    const body = { messages: [{ role: 'user', content: [{ text: o.prompt }] }], inferenceConfig: { maxTokens: o.maxTokens } };
    if (o.system) body.system = [{ text: o.system }];
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${o.key}` };
    const url = `https://bedrock-runtime.${o.region}.amazonaws.com/model/${encodeURIComponent(o.model)}/converse`;

    const res = await postWithDowngrade(url, headers, body, o, 'AWS Bedrock', [
      { name: `maxTokens ${o.maxTokens}`, match: /max_?tokens|maxTokens|inferenceConfig/i, present: () => 'inferenceConfig' in body,
        drop: () => { delete body.inferenceConfig; } },
    ]);
    const r = await res.json();
    let text = '';
    for (const c of (r.output && r.output.message && r.output.message.content) || []) {
      if (c.text) text += c.text;
      else if (c.reasoningContent && c.reasoningContent.reasoningText) o.onThinking && o.onThinking(c.reasoningContent.reasoningText.text || '');
    }
    if (text) o.onText && o.onText(text);
    const u = r.usage || {};
    if (r.stopReason === 'max_tokens') o.onNote && o.onNote('Hit max tokens, so the output is truncated.');
    else if (/guardrail|content_filtered/.test(r.stopReason || '')) o.onNote && o.onNote(`Bedrock stopped the answer: ${r.stopReason}.`);
    return {
      text,
      usage: { input: u.inputTokens || 0, output: u.outputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, cacheWrite: u.cacheWriteInputTokens || 0 },
      stop: r.stopReason,
      model: o.model,
    };
  }

  // ---------- Any OpenAI-compatible API (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together…) ----------
  async function callCompat(o) {
    if (!o.model) throw new Error('Any API: no model chosen. Open Settings → Any API → Test & load models, then pick one.');
    const messages = [];
    if (o.system) messages.push({ role: 'system', content: o.system });
    messages.push({ role: 'user', content: o.prompt });
    const body = { model: o.model, messages, stream: true, stream_options: { include_usage: true } };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${o.key}` };
    if (/openrouter\.ai/.test(o.baseUrl)) { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Relay'; }

    const res = await postWithDowngrade(`${o.baseUrl}/chat/completions`, headers, body, o, o.vendorName || 'Any API', [
      { name: 'stream_options', match: /stream_options|include_usage/i, present: () => 'stream_options' in body,
        drop: () => { delete body.stream_options; } },
    ]);

    const usage = emptyUsage();
    let text = '', stop = null, model = o.model;
    for await (const { data } of sse(res)) {
      if (data.error) throw new Error(`${o.vendorName || 'Any API'} stream error: ` + (data.error.message || JSON.stringify(data.error)));
      const ch = (data.choices || [])[0];
      const d = ch && ch.delta;
      if (d) {
        const reasoning = d.reasoning_content || d.reasoning;
        if (reasoning && typeof reasoning === 'string') o.onThinking && o.onThinking(reasoning);
        if (d.content) { text += d.content; o.onText && o.onText(d.content); }
      }
      if (ch && ch.finish_reason) stop = ch.finish_reason;
      if (data.usage) {
        const cached = (data.usage.prompt_tokens_details && data.usage.prompt_tokens_details.cached_tokens) || 0;
        usage.cacheRead = cached;
        usage.input = Math.max(0, (data.usage.prompt_tokens || 0) - cached);
        usage.output = data.usage.completion_tokens || 0;
      }
      if (data.model) model = data.model;
    }
    if (stop === 'length') o.onNote && o.onNote('Hit the output limit, so the answer is truncated.');
    return { text, usage, stop, model };
  }

  // ---------- Model discovery ----------
  async function getJson(url, headers, vendor, signal) {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw await httpError(res, vendor);
    return res.json();
  }

  async function listAnthropicModels(key, baseUrl) {
    const j = await getJson(`${baseUrl}/v1/models?limit=100`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, 'Anthropic');
    return (j.data || []).map(m => m.id);
  }

  async function fetchOpenAIModelIds(key, baseUrl, signal) {
    const j = await getJson(`${baseUrl}/v1/models`, { authorization: `Bearer ${key}` }, 'OpenAI', signal);
    return (j.data || []).map(m => m.id);
  }

  async function listOpenAIModels(key, baseUrl) {
    return (await fetchOpenAIModelIds(key, baseUrl)).filter(id => /^(gpt|o\d|chatgpt|codex)/.test(id)).sort().reverse();
  }

  async function listGeminiModels(key, baseUrl) {
    const j = await getJson(`${baseUrl}/v1beta/models?pageSize=200`, { 'x-goog-api-key': key }, 'Gemini');
    return (j.models || [])
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(id => /^gemini/.test(id)).sort().reverse();
  }

  async function listBedrockModels(key, region) {
    const h = { authorization: `Bearer ${key}` };
    const base = `https://bedrock.${region}.amazonaws.com`;
    const [profiles, models] = await Promise.allSettled([
      getJson(`${base}/inference-profiles?maxResults=1000`, h, 'AWS Bedrock'),
      getJson(`${base}/foundation-models?byOutputModality=TEXT`, h, 'AWS Bedrock'),
    ]);
    const ids = [];
    if (profiles.status === 'fulfilled') ids.push(...(profiles.value.inferenceProfileSummaries || []).map(p => p.inferenceProfileId));
    if (models.status === 'fulfilled') ids.push(...(models.value.modelSummaries || []).map(m => m.modelId));
    if (!ids.length) throw (profiles.reason || models.reason);
    return [...new Set(ids)].sort();
  }

  async function listCompatModels(key, baseUrl, vendorName) {
    const j = await getJson(`${baseUrl}/models`, { authorization: `Bearer ${key}` }, vendorName || 'Any API');
    return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
  }

  // ---------- Demo provider (no network) ----------
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
  }

  function mockText(label, model, prompt) {
    const m = prompt.match(/(?:^|\n)(?:Overall task[^\n:]*|Task):\s*\n([\s\S]*?)(?:\n\n|$)/);
    const task = oneLine(m ? m[1] : prompt, 110);
    if (/JSON array/i.test(prompt)) {
      return '```json\n' + JSON.stringify([
        `Clarify requirements and constraints for: ${task}`,
        `Produce the core deliverable for: ${task}`,
        `List risks, edge cases and failure modes for: ${task}`,
        `Write a short verification checklist for: ${task}`,
      ], null, 2) + '\n```';
    }
    const role = /Try to refute|Review the draft|Critique both/i.test(prompt) ? 'critique'
      : /final (deliverable|answer)|final judge|You are the judge/i.test(prompt) ? 'final'
      : /Your subtask/i.test(prompt) ? 'worker' : 'answer';
    const body = {
      answer: ['- Restated the goal and the constraints that matter.', '- Proposed a concrete approach with the main trade-off called out.', '- Listed the one assumption most likely to be wrong.'],
      critique: ['1. **Unsupported claim** in the second point: needs a source or a test.', '2. **Gap**: the edge case with empty input is not handled.', '3. OK: the overall structure holds up.'],
      worker: ['- Completed only this subtask, with the context it was given.', '- Result is self-contained so the synthesizer can merge it.'],
      final: ['**Final answer.** The drafts were merged, the valid critiques were applied, and the rejected ones were noted.', '', '- Point one, corrected per the review.', '- Point two, unchanged (the review was wrong here).'],
    }[role];
    return `#### ${label} · ${role} (demo)\n\n${body.join('\n')}\n\n> **Demo mode**: no API call was made. Live, \`${model || 'the model'}\` would receive a ${prompt.length.toLocaleString()}-character prompt beginning:\n>\n> ${oneLine(prompt, 170).replace(/[`*_]/g, '')}`;
  }

  async function callMock(o) {
    await sleep(250 + Math.random() * 450, o.signal);
    const out = mockText(o.label, o.model, o.prompt);
    const chunks = out.match(/[\s\S]{1,14}/g) || [];
    for (const c of chunks) { await sleep(14, o.signal); o.onText && o.onText(c); }
    return {
      text: out,
      usage: { input: Math.ceil(((o.system || '').length + o.prompt.length) / 4), output: Math.ceil(out.length / 4), cacheRead: 0, cacheWrite: 0 },
      stop: 'end_turn',
      model: o.model,
    };
  }

  window.Providers = {
    callAnthropic, callOpenAI, callGemini, callBedrock, callCompat, callMock,
    listAnthropicModels, listOpenAIModels, listGeminiModels, listBedrockModels, listCompatModels,
  };
})();
