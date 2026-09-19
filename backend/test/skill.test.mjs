/* Exercises the skill webhook against mocks. The property that matters most is
 * timing: the handler must answer Kakao without waiting on GitHub. */
import worker from '../src/index.js'

let dispatched = null
let pushed = null

// Stand in for every outbound call the worker makes.
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/actions/workflows/') && u.endsWith('/dispatches')) {
    await new Promise(r => setTimeout(r, 300))       // GitHub is slow on purpose
    dispatched = JSON.parse(init.body).inputs.task
    return new Response(null, { status: 204 })
  }
  if (u.includes('/actions/workflows/') && u.includes('/runs')) {
    return new Response(JSON.stringify({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', html_url: 'https://x/run/1' }] }), { status: 200 })
  }
  if (u.includes('kauth.kakao.com')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
  if (u.includes('kapi.kakao.com')) { pushed = true; return new Response('{}', { status: 200 }) }
  throw new Error('unexpected fetch: ' + u)
}

const rows = new Map([['paid-user', { plan: 'cloud', runs_month: 2, runs_limit: 50 }]])
const env = {
  KAKAO_SKILL_TOKEN: 'sekret-token-abc',
  ALLOWED_KAKAO_IDS: 'owner-id',
  GITHUB_OWNER: 'o', GITHUB_REPO: 'r', WORKFLOW_FILE: 'cloud-agents.yml', GITHUB_TOKEN: 't',
  KAKAO_REST_KEY: 'k', KAKAO_REFRESH_TOKEN: 'r',
  DB: {
    prepare(sql) {
      return {
        bind(...a) {
          return {
            first: async () => (sql.includes('SELECT') ? rows.get(a[0]) || null : null),
            run: async () => ({ success: true }),
          }
        },
      }
    },
  },
}

const waits = []
const ctx = { waitUntil: (p) => waits.push(p) }

const post = (token, body) =>
  worker.fetch(new Request(`https://x/kakao/skill?token=${token}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), env, ctx)

const skill = (utterance, id) => ({ userRequest: { utterance, user: { id } } })
const textOf = (j) => j.template.outputs[0].simpleText.text

let fail = 0
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fail++ }

// 1. wrong token
let r = await post('wrong-token-xxx', skill('hi', 'owner-id'))
check('wrong token → 403', r.status === 403)

// 2. length-mismatch token must not throw
r = await post('x', skill('hi', 'owner-id'))
check('short token → 403, no crash', r.status === 403)

// 3. unknown user is refused and told their id
r = await post('sekret-token-abc', skill('do a thing', 'stranger'))
let j = await r.json()
check('unknown user refused', textOf(j).includes('approved accounts'))
check('unknown user shown their id', textOf(j).includes('stranger'))

// 4. THE timing property: reply must not wait on the 300ms dispatch
dispatched = null
const t0 = Date.now()
r = await post('sekret-token-abc', skill('audit every route for auth', 'owner-id'))
const elapsed = Date.now() - t0
j = await r.json()
check('replies immediately (<100ms, Kakao allows 5000)', elapsed < 100)
check('reply says it started', textOf(j).includes('Started'))
check('dispatch had NOT finished when we replied', dispatched === null)

await Promise.all(waits)                       // let waitUntil settle
check('dispatch ran in the background', dispatched === 'audit every route for auth')

// 5. Kakao response schema
check('version 2.0', j.version === '2.0')
check('has simpleText output', !!j.template.outputs[0].simpleText)
check('quickReplies well-formed', j.template.quickReplies[0].action === 'message')

// 6. status command
r = await post('sekret-token-abc', skill('상태', 'owner-id'))
check('status command answers', (await r.json()).template.outputs[0].simpleText.text.includes('success'))

// 7. quota exhaustion
rows.set('maxed', { plan: 'cloud', runs_month: 50, runs_limit: 50 })
r = await post('sekret-token-abc', skill('go', 'maxed'))
check('quota exhausted refused', (await r.json()).template.outputs[0].simpleText.text.includes('all 50 runs'))

// 8. health
r = await worker.fetch(new Request('https://x/health'), env, ctx)
check('health ok', r.status === 200)

console.log(fail ? `\n${fail} FAILED` : '\nall passed')
process.exit(fail ? 1 : 0)
