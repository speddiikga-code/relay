# Relay: Claude × GPT orchestration

A static website that runs real multi-agent prompt pipelines across **Claude (Anthropic API)** and **GPT (OpenAI API)** from your browser. It has no backend and no build step, and it hosts on GitHub Pages as is.

## What it does

- **⚡ Kickstart**: one click (or Ctrl+Shift+Enter). It reads your task, picks the orchestration and effort level, and runs it. Start a task with `ultracode:` to force Ultra.
- **Six pipelines, all editable**
  - **Solo**: one agent.
  - **Compare**: Claude and GPT in parallel.
  - **Relay**: Claude drafts, GPT attacks the draft, Claude revises.
  - **Debate**: both answer, both cross-examine, a judge decides.
  - **Fan-out**: a planner splits the task, workers on both vendors run in parallel, a cross-vendor verifier tries to refute them, and a synthesizer merges the results. This is the ultracode workflow pattern.
  - **Ultra**: both vendors at every step. Plan, then workers, then Claude and GPT refute independently, then synthesize, then GPT attacks the result and Claude fixes it. It runs at xhigh effort and is the most expensive option.
- **Auto-router**: suggests the cheapest pipeline and effort level that fit the task.
- **OpenAI error recovery**: OpenAI's error replies can't be read by browsers, so a bad key, a missing model or no credit all look like "Failed to fetch". Relay diagnoses the real cause through the model-list endpoint, then retries without optional settings and without streaming.
- **Pipeline editor**: add, reorder or remove stages. Each stage is a single agent, a parallel group or a fan-out, and has its own models, effort, system prompt and template (`{{task}}`, `{{prev}}`, `{{s1}}`…, `{{item}}`). You can import and export pipelines as JSON.
- **Live streaming** from every agent, with Claude reasoning summaries, per-agent token counts, cost estimates and run totals.
- **Guards**: a cap on agent calls per run, a cap on fan-out items, a concurrency limit and a Stop button.
- **Demo mode**: simulates every call so you can try the flow without keys.
- **History** of past runs, kept in your browser only.

## Deploy to GitHub Pages (about 2 minutes, no git needed)

1. On github.com, click **New repository**. Name it (for example `relay`), make it **Public**, and create it.
2. On the empty repo page, click **uploading an existing file**. Drag in `index.html`, `styles.css`, `engine.js`, `providers.js`, `app.js` and `README.md`, then click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**, Branch to **main**, and folder to **/ (root)**. Click **Save**.
4. After about a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

## Using it

1. Open **Settings**, paste your Anthropic and OpenAI API keys, then click **Test & load models**.
2. Turn **Demo** off in the header.
3. Describe a task. Pick a pipeline, or click **Use suggestion**. Then press **Run pipeline** (or Ctrl + Enter).

Default models are `claude-opus-5` / `claude-sonnet-5` and `gpt-6-astra` / `gpt-5.6-terra`. Change them in Settings. Pipelines reference *slots* (Claude, Claude · fast, GPT, GPT · fast), so a model change applies everywhere.

## Security model: read this

- Your keys are stored **only in your browser**: sessionStorage by default, or localStorage if you tick *Remember*. They are sent only to the base URLs in Settings, which are `api.anthropic.com` and `api.openai.com` unless you change them.
- **Never commit keys to this repo.** The site never asks you to.
- Anyone who can run JavaScript in this page can read your keys. The page loads nothing but its own files and two pinned libraries (marked, DOMPurify), and a Content-Security-Policy blocks other scripts. Model output is sanitized before rendering.
- Use keys with **spend limits** set in each vendor's console, and don't use *Remember* on shared computers.
- If you publish the site publicly, visitors use **their own** keys. Nobody can spend yours.

## What it is not

- **It is not Claude Code's `ultracode`.** ultracode is a mode of the Claude Code CLI that runs on your machine, and it fires only from input you type yourself. That is a deliberate security boundary, so no website can trigger it. Relay runs the same plan → fan-out → verify → synthesize pattern over the public APIs. For work on a real repository, the *Hand off to the CLI* panel gives you the command for Claude Code or Codex.
- **It cannot read your files or repo.** Paste the content the agents need into the task.
- **Costs are estimates** based on the editable price table. Your vendor dashboards are the source of truth.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure and dialogs |
| `styles.css` | Styles (light and dark) |
| `engine.js` | Presets, router, templating, fan-out runner, budgets, pricing (no DOM, no network) |
| `providers.js` | Anthropic Messages API and OpenAI Responses API streaming adapters, model listing, demo provider |
| `app.js` | UI: editor, live run view, settings, history |

## Run locally

```bash
python -m http.server 8765
```

Then open http://localhost:8765. Serve it over HTTP like this rather than double-clicking `index.html`, because browsers restrict pages opened from disk.
