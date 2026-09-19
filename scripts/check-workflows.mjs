#!/usr/bin/env node
/* Catches what `yaml.safe_load` cannot.
 *
 * A workflow can be perfectly valid YAML and still fail to run, because GitHub
 * evaluates ${{ }} expressions inside `run:` block strings — which are shell
 * script, not YAML comments. An empty or malformed expression there is a parse
 * error that takes the whole workflow offline, including triggers you weren't
 * touching. Learned the hard way: a comment explaining "don't use ${{ }}"
 * contained the literal, and silently disabled the workflow for three commits.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

const DIR = '.github/workflows'
let failed = 0

for (const file of readdirSync(DIR).filter(f => /\.ya?ml$/.test(f))) {
  const path = join(DIR, file)
  const problems = []
  let doc

  try {
    doc = load(readFileSync(path, 'utf8'))
  } catch (err) {
    console.log(`  FAIL ${file}\n         invalid YAML: ${err.message}`)
    failed = 1
    continue
  }

  for (const [jobName, job] of Object.entries(doc?.jobs || {})) {
    for (const [i, step] of (job.steps || []).entries()) {
      if (!step.run) continue
      for (const m of step.run.matchAll(/\$\{\{(.*?)\}\}/gs)) {
        const inner = m[1].trim()
        const where = `${jobName}[${i}] ${step.name || 'unnamed'}`
        if (!inner) problems.push(`${where}: empty \${{ }} — GitHub rejects the whole workflow`)
      }
    }
  }

  if (problems.length) {
    failed = 1
    console.log(`  FAIL ${file}`)
    for (const p of problems) console.log(`         ${p}`)
  } else {
    console.log(`  ok   ${file}`)
  }
}

process.exit(failed)
