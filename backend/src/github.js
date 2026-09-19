/* Dispatch a cloud agent run to GitHub Actions.
 *
 * The agents already exist in .github/workflows/cloud-agents.yml — real Claude
 * Code with ultracode on, plus Codex and Gemini. This backend does not run
 * models itself; it decides who is allowed to spend credit, then hands the task
 * to the workflow that already works.
 *
 * That split is deliberate. Workers have a hard CPU limit and no business
 * running a multi-minute agent; Actions has a 6-hour budget and the CLIs
 * already installed.
 */

const API = 'https://api.github.com';

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'relay-backend',
    'Content-Type': 'application/json',
  };
}

/** Fire the workflow. Returns nothing useful — workflow_dispatch responds 204
 *  with no run id, which is why runs are tracked in D1 rather than by polling. */
export async function dispatchRun(env, task) {
  const url = `${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
              `/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ ref: 'main', inputs: { task } }),
  });

  if (res.status !== 204) {
    throw new Error(`workflow_dispatch failed (${res.status}): ${await res.text()}`);
  }
  return true;
}

/** Most recent run of the workflow, for "is it done yet". */
export async function latestRun(env) {
  const url = `${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
              `/actions/workflows/${env.WORKFLOW_FILE}/runs?per_page=1`;

  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`run lookup failed (${res.status})`);

  const json = await res.json();
  const run = json.workflow_runs?.[0];
  if (!run) return null;

  return {
    id: run.id,
    status: run.status,          // queued | in_progress | completed
    conclusion: run.conclusion,  // success | failure | cancelled | null
    url: run.html_url,
  };
}
