# relay-backend

The server Relay deliberately didn't have.

Relay is a static site because that's what keeps your API keys in your own
browser. This exists only for the two things a static site genuinely cannot do:
**receive a webhook**, and **hold a credential that isn't the visitor's**.

Everything else stays in the browser, unchanged.

## What it does

`POST /kakao/skill` — a KakaoTalk chatbot skill server. You message your Kakao
channel, it starts a cloud agent run (real Claude Code with ultracode, plus
Codex and Gemini), and the answer arrives in KakaoTalk when it's done.

## The 5-second rule shaped all of this

Kakao drops a skill connection after **5 seconds**. Its callback mechanism
extends that, but only to **1 minute, single use** — and requires converting the
bot to an "AI 챗봇" by email application.

An ultracode run takes *minutes*. It fits in neither window.

So this never uses the callback. It acknowledges inside 5 seconds, dispatches
the run in the background with `ctx.waitUntil()`, and delivers the answer later
through `talk_message` — the same push the browser app and the workflow already
use. Skipping the callback also skips its approval step.

```
KakaoTalk  ──►  Worker  ──►  reply in <100ms  ──►  KakaoTalk
                  │
                  └─(background)─►  GitHub Actions
                                    Claude Code ultracode + Codex + Gemini
                                            │
                                            └──►  talk_message  ──►  KakaoTalk
```

The agents run in Actions, not here. Workers have a hard CPU limit and no
business running a multi-minute agent; Actions has a 6-hour budget and the CLIs
already installed.

## Deploy

```bash
npm install -g wrangler
wrangler login

wrangler d1 create relay                 # put the printed id in wrangler.toml
wrangler d1 execute relay --file schema.sql --remote

wrangler secret put KAKAO_SKILL_TOKEN    # any long random string you invent
wrangler secret put KAKAO_REST_KEY
wrangler secret put KAKAO_REFRESH_TOKEN
wrangler secret put KAKAO_CLIENT_SECRET  # only if your Kakao app needs one
wrangler secret put GITHUB_TOKEN         # fine-grained PAT, actions:write
wrangler secret put ALLOWED_KAKAO_IDS    # your Kakao id; see below

wrangler deploy
```

Get your Kakao id by messaging the channel once before you're on the allowlist —
it refuses you and prints the id. Add it, redeploy, message again.

## Kakao side, one time

This is the part that takes days, not minutes, because it involves approval.

1. Create a **카카오톡 채널** at business.kakao.com.
2. Open the **챗봇 관리자센터** and create a bot for that channel.
3. Add a **스킬** pointing at
   `https://<your-worker>.workers.dev/kakao/skill?token=<KAKAO_SKILL_TOKEN>`
4. Bind it to a fallback block so any message reaches it.
5. Submit the channel for review. **Until it's approved, only you can message it.**

Kakao does not sign skill requests — there's no HMAC to verify. The token on the
URL is the only protection available, so treat it like a password and make it
long.

## Security

- A run spends **your** API credit, so access is an allowlist, not open
  registration. Unknown senders are refused.
- The token is compared in constant time so the endpoint can't be probed a
  character at a time.
- The worker holds a GitHub PAT and a Kakao refresh token. Scope the PAT to
  `actions:write` on this repo only — nothing else.
- `runs_limit` per user is the backstop. Set it low until you trust the flow.

## Tests

```bash
npm test
```

Runs the skill handler against mocks. The test that matters asserts the reply
goes out **before** the GitHub dispatch completes — if that ever regresses, real
users see a connection error instead of a reply, and it wouldn't be obvious from
reading the code.

## Not built yet

Billing, accounts, and metered Cloud plans. The `users` table has `plan` and
`runs_limit` columns waiting for them, but nothing reads a payment provider yet.
Don't wire payments before the business entity and 통신판매업 신고 exist.
