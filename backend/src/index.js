/* relay-backend — the server Relay deliberately didn't have.
 *
 * Routes:
 *   POST /kakao/skill?token=…   Kakao chatbot webhook (must answer in <5s)
 *   GET  /health                liveness
 *
 * Everything else Relay does stays in the browser with the user's own keys.
 * This exists only for the two things a static site genuinely cannot do:
 * receive a webhook, and hold a credential that isn't the visitor's.
 */

import { skillText, parseSkillRequest, kakaoPush } from './kakao.js';
import { dispatchRun, latestRun } from './github.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/* Kakao does not sign skill requests — there is no HMAC to verify. The only
 * available protection is an unguessable shared secret on the URL, compared in
 * constant time so the endpoint can't be probed a character at a time. */
function tokenOk(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Allowlist check. A run spends the owner's API credit, so the default is no. */
async function allowed(env, kakaoId) {
  const fromEnv = (env.ALLOWED_KAKAO_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.includes(kakaoId)) return { ok: true, plan: 'owner', limit: Infinity, used: 0 };

  const row = await env.DB.prepare(
    'SELECT plan, runs_month, runs_limit FROM users WHERE kakao_id = ?',
  ).bind(kakaoId).first();

  if (!row) return { ok: false };
  return { ok: row.runs_month < row.runs_limit, plan: row.plan, limit: row.runs_limit, used: row.runs_month };
}

/* -------------------------------------------------------------------------
 * The work that happens after we've already replied to Kakao.
 * ---------------------------------------------------------------------- */
async function startRun(env, kakaoId, task) {
  try {
    await dispatchRun(env, task);

    await env.DB.prepare(
      'INSERT INTO runs (kakao_id, task, status) VALUES (?, ?, ?)',
    ).bind(kakaoId, task, 'dispatched').run();

    await env.DB.prepare(
      'UPDATE users SET runs_month = runs_month + 1 WHERE kakao_id = ?',
    ).bind(kakaoId).run();
  } catch (err) {
    // The user has already been told the run started, so a failure here has to
    // reach them some other way. The push is the only channel we have.
    const repo = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    await kakaoPush(env, {
      text: `Could not start the run: ${err.message}`,
      url: `${repo}/actions`,
    }).catch(() => { /* nothing left to try */ });
  }
}

/* -------------------------------------------------------------------------
 * Kakao skill webhook
 * ---------------------------------------------------------------------- */
async function handleSkill(request, env, ctx) {
  const url = new URL(request.url);
  if (!tokenOk(url.searchParams.get('token'), env.KAKAO_SKILL_TOKEN)) {
    return json({ error: 'forbidden' }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(skillText('That message could not be read.'));
  }

  const { utterance, kakaoId } = parseSkillRequest(payload);
  if (!utterance) return json(skillText('Send me a task and I will run it.'));

  // "상태" / "status" — cheap enough to answer inside the 5s window.
  if (/^(상태|status)$/i.test(utterance)) {
    try {
      const run = await latestRun(env);
      if (!run) return json(skillText('No runs yet.'));
      const state = run.status === 'completed' ? (run.conclusion || 'finished') : run.status;
      return json(skillText(`Latest run: ${state}\n${run.url}`));
    } catch {
      return json(skillText('Could not reach GitHub just now.'));
    }
  }

  const gate = await allowed(env, kakaoId);
  if (!gate.ok) {
    return json(skillText(
      gate.plan
        ? `You've used all ${gate.limit} runs this month.`
        : 'This channel only runs tasks for approved accounts.\n\nYour Kakao id:\n' + kakaoId,
    ));
  }

  /* The critical line. Dispatching to GitHub takes longer than Kakao will wait,
   * so it runs after the response is sent. Awaiting it here would blow the 5s
   * timeout and the user would see a connection error instead of a reply. */
  ctx.waitUntil(startRun(env, kakaoId, utterance));

  return json(skillText(
    'Started. Claude Code (ultracode), Codex and Gemini are on it.\n\n' +
    'This takes a few minutes — I\'ll message you here when the merged answer is ready.',
    ['상태'],
  ));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/kakao/skill' && request.method === 'POST') {
      return handleSkill(request, env, ctx);
    }

    return json({ error: 'not found' }, 404);
  },
};
