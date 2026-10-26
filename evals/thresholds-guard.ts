/**
 * Keeps the thresholds from being loosened by accident. CI runs this against
 * the thresholds of the commit before the change: a floor that went down or a
 * ceiling that went up fails, unless the commit message says why with a line
 * `loosen-thresholds: <reason>`.
 *
 *   tsx evals/thresholds-guard.ts <before-thresholds.json> <commit-message-file>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Thresholds } from './harness.js'

/** Every number in the thresholds, by path, and whether higher or lower is the strict side. */
function flatten(thresholds: Thresholds): { path: string; value: number; kind: 'min' | 'max' }[] {
  return [
    ...Object.entries(thresholds.min.overall).map(([name, value]) => ({ path: `min.overall.${name}`, value, kind: 'min' as const })),
    { path: 'min.paraphraseGroundedness', value: thresholds.min.paraphraseGroundedness, kind: 'min' as const },
    ...Object.entries(thresholds.max).map(([name, value]) => ({ path: `max.${name}`, value, kind: 'max' as const })),
  ]
}

/** What got looser from `before` to `after`: a floor lower, a ceiling higher,
 *  or a threshold that was removed. Empty when nothing did. */
export function loosenings(before: Thresholds, after: Thresholds): string[] {
  const now = new Map(flatten(after).map((t) => [t.path, t.value]))
  return flatten(before).flatMap((was) => {
    const is = now.get(was.path)
    if (is === undefined) return [`${was.path} was removed (was ${was.value})`]
    const looser = was.kind === 'min' ? is < was.value : is > was.value
    return looser ? [`${was.path} went from ${was.value} to ${is}`] : []
  })
}

/** Whether a commit message gives a reason for loosening. */
export const hasLooseningReason = (message: string) => /loosen-thresholds:\s*\S/.test(message)

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const [beforeFile, messageFile] = process.argv.slice(2)
  if (!beforeFile || !messageFile) {
    console.error('usage: thresholds-guard.ts <before-thresholds.json> <commit-message-file>')
    process.exit(2)
  }
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')) as Thresholds
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'thresholds.json'), 'utf8')) as Thresholds
  const loosened = loosenings(before, after)
  if (loosened.length === 0) {
    console.log('thresholds not loosened')
  } else if (hasLooseningReason(fs.readFileSync(messageFile, 'utf8'))) {
    console.log(`thresholds loosened, with a stated reason:\n  ${loosened.join('\n  ')}`)
  } else {
    console.error(`FAIL thresholds were loosened without a reason:\n  ${loosened.join('\n  ')}`)
    console.error('If this is deliberate, put "loosen-thresholds: <why>" in the commit message.')
    process.exit(1)
  }
}
