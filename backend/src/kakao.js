/* Kakao chatbot skill server + talk_message push.
 *
 * The 5-second rule drives the whole design. Kakao drops a skill connection
 * after 5 seconds, and its callback URL is valid for only 1 minute and one use
 * (and requires converting the bot to an "AI 챗봇" by email application).
 *
 * An ultracode run takes minutes. It fits in neither window. So this never uses
 * the callback mechanism: it acknowledges inside 5s, dispatches the run in the
 * background, and delivers the answer later through talk_message — the same
 * push the browser app and the GitHub workflow already use.
 */

/** A Kakao skill response. simpleText is the only shape we need. */
export function skillText(text, quickReplies) {
  const body = {
    version: '2.0',
    template: { outputs: [{ simpleText: { text } }] },
  };
  if (quickReplies && quickReplies.length) {
    body.template.quickReplies = quickReplies.map((q) => ({
      action: 'message', label: q, messageText: q,
    }));
  }
  return body;
}

/** Pull the utterance and the caller's Kakao id out of a skill payload. */
export function parseSkillRequest(payload) {
  const utterance = payload?.userRequest?.utterance?.trim() || '';
  const kakaoId = payload?.userRequest?.user?.id || '';
  return { utterance, kakaoId };
}

/* -------------------------------------------------------------------------
 * talk_message push ("send to me")
 * ---------------------------------------------------------------------- */

/** Trade the long-lived refresh token for a short-lived access token.
 *  Access tokens expire in hours, so storing one would guarantee a stale
 *  token by the time a multi-minute run finishes. */
export async function kakaoAccessToken(env) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.KAKAO_REST_KEY,
    refresh_token: env.KAKAO_REFRESH_TOKEN,
  });
  if (env.KAKAO_CLIENT_SECRET) form.set('client_secret', env.KAKAO_CLIENT_SECRET);

  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form,
  });

  if (!res.ok) throw new Error(`Kakao token refresh failed (${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Kakao token refresh returned no access_token');
  return json.access_token;
}

/** Send a message to the connected account's own KakaoTalk.
 *  Kakao's text template caps at 200 characters, so callers should send a
 *  summary and let the button carry the reader to the full answer. */
export async function kakaoPush(env, { text, url }) {
  const access = await kakaoAccessToken(env);

  const template = {
    object_type: 'text',
    text: text.slice(0, 200),
    link: { web_url: url, mobile_web_url: url },
    button_title: 'Read the answer',
  };

  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });

  if (!res.ok) throw new Error(`Kakao push failed (${res.status}): ${await res.text()}`);
  return true;
}
