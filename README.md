# Relay: multi-AI orchestration

A static website that runs real multi-agent prompt pipelines across **Claude**, **GPT**, **Google Gemini**, **Amazon Bedrock (AWS)**, and **any OpenAI-compatible API** (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together…), straight from your browser. It can send results to your **KakaoTalk**. It has no backend and no build step, and it hosts on GitHub Pages as is.

**Live:** https://speddiikga-code.github.io/relay/

## Connected providers

| Provider | API used from the browser | Key |
|---|---|---|
| Claude | Anthropic Messages API (streaming) | Anthropic API key |
| GPT | OpenAI Responses API (streaming) | OpenAI API key |
| Google Gemini | Gemini API `streamGenerateContent` | Gemini API key ([AI Studio](https://aistudio.google.com/apikey)) |
| Amazon Bedrock | Bedrock Converse API, any region | Bedrock API key ([console](https://console.aws.amazon.com/bedrock/home#/api-keys)) |
| Any API | OpenAI-compatible Chat Completions (streaming) | That service's key |
| KakaoTalk | Kakao Login + "send to me" (`talk_message`) | Kakao app REST API key |

Every one of these APIs was checked to accept direct browser calls (CORS), including on error responses. OpenAI's errors are the exception: Relay recovers them through the model-list endpoint.

**Connect any subset.** If a pipeline asks for a provider you haven't connected, a connected one stands in automatically, and the stage says so. **Council** sends the task to every connected provider at once, then a judge merges the answers.

### KakaoTalk setup (one time)

1. Go to [developers.kakao.com](https://developers.kakao.com/console/app) and create an app.
2. Under **Platform → Web**, add the site domain `https://speddiikga-code.github.io`.
3. Under **Kakao Login**, turn it on and add the Redirect URI `https://speddiikga-code.github.io/relay/`.
4. Under **Consent items**, enable "Send message in KakaoTalk" (`talk_message`).
5. In Relay, open **Settings → KakaoTalk**, paste the app's REST API key (plus the client secret if you enabled one), and press **Connect KakaoTalk**.
6. Turn on "Message me on KakaoTalk when a run finishes". Every final result also gets a **KakaoTalk** button.

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

## Cloud agents: real Claude Code (ultracode) + Codex + Gemini CLI

The **☁ Claude Code ultracode + Codex** panel sends your task to [`.github/workflows/cloud-agents.yml`](.github/workflows/cloud-agents.yml), which runs in GitHub Actions. These agents run in parallel:

1. **Claude Code** (the real CLI) runs your task with the `ultracode` setting on: xhigh effort plus dynamic multi-agent workflows. It uses the Anthropic API, or **AWS Bedrock** when only a Bedrock key is set.
2. **OpenAI Codex** (`openai/codex-action`) runs the same task at xhigh effort. If the model rejects xhigh, it retries at high.
3. **Google Gemini CLI** (`google-github-actions/run-gemini-cli`) runs the same task.

Then **Claude merges** every answer: what each got right or wrong, then the single best final answer. Each step posts a comment on the task's GitHub issue, and the issue gets the `agent-done` label when finished. The panel lists recent runs.

**One-time setup:** in the repo, go to **Settings → Secrets and variables → Actions** and add any of these repository secrets. Each agent runs only if its secret exists:

| Secret | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code and the merge step |
| `AWS_BEARER_TOKEN_BEDROCK` | Claude Code through AWS Bedrock, used when there's no Anthropic key |
| `OPENAI_API_KEY` | Codex |
| `GEMINI_API_KEY` | Gemini CLI |

Optional repository variables override the defaults: `CLAUDE_MODEL` (`claude-opus-5`), `CODEX_MODEL` (`gpt-6-astra`), `GEMINI_MODEL` (`gemini-3.8-flash`), `AWS_REGION` (`us-east-1`) and `BEDROCK_CLAUDE_MODEL` (`us.anthropic.claude-opus-5`).

**Who can start a run:** only the repository owner, because every run spends the owner's API credit. Issues opened by anyone else are ignored.

**Why not the `ultracode:` keyword?** Claude Code honors the keyword only from input a person types, never from `-p` runs, webhooks or issue text. That's a deliberate safety boundary. The workflow turns ultracode on through the documented setting (`--settings '{"ultracode": true}'`) and explicitly allows the `Workflow` tool, which non-interactive runs require.

**Agents are read-only:** they can read this repo and the web, and they answer in comments. They don't push code.

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
