/**
 * `npm run eval` writes evals/results/latest.json from a fresh run.
 * `npm run eval:check` runs fresh and exits 1 on a hard invariant, a metric
 * below its threshold, or an artifact that differs from the committed one.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkGate, misses, renderTable, serialize } from './gate.js'
import { runEvals } from './harness.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const artifactPath = path.join(dir, 'results', 'latest.json')

const artifact = await runEvals()
const fresh = serialize(artifact)
console.log(renderTable(artifact))
const missed = misses(artifact)
if (missed.length > 0) console.log(`\ncases that missed a check (recorded, not failures):\n  ${missed.join('\n  ')}`)
console.log()

if (process.argv.includes('--check')) {
  const committed = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8') : null
  const failures = checkGate(artifact, artifact.thresholds, committed)
  for (const failure of failures) console.error(`FAIL ${failure}`)
  if (failures.length > 0) process.exit(1)
  console.log('eval gate passed')
} else {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  fs.writeFileSync(artifactPath, fresh)
  console.log(`wrote ${path.relative(process.cwd(), artifactPath)}`)
}
