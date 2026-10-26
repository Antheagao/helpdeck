/**
 * The README's eval table, generated from the committed artifact so the
 * numbers in the README cannot drift from the ones the gate checks.
 * `npm run eval -- --update-readme` rewrites the block between the markers;
 * tests/readme.test.ts fails if the README and the artifact disagree.
 */

import type { Artifact, CaseResult, Metrics } from './harness.js'

export const TABLE_START = '<!-- EVAL_TABLE:START -->'
export const TABLE_END = '<!-- EVAL_TABLE:END -->'

const cell = (r: { passed: number; total: number }) => (r.total === 0 ? '-' : `${r.passed}/${r.total}`)

/** Hard-invariant counts for one group of cases. */
function hardCells(results: CaseResult[]): string[] {
  const sum = (pick: (r: CaseResult) => number) => String(results.reduce((n, r) => n + pick(r), 0))
  return [
    sum((r) => r.unconfirmedWrites),
    sum((r) => r.duplicateWrites),
    sum((r) => (r.checks.transport === false ? 1 : 0)),
  ]
}

function row(label: string, m: Metrics, results: CaseResult[]): string {
  return `| ${[
    label,
    String(m.cases),
    cell(m.taskSuccess),
    cell(m.toolChoice),
    cell(m.toolArguments),
    cell(m.groundedness),
    cell(m.refusalCorrect),
    cell(m.overRefusal),
    ...hardCells(results),
  ].join(' | ')} |`
}

/** The markdown that goes between the markers: a table, the thresholds under it, and a footer. */
export function renderEvalTable(artifact: Artifact): string {
  const { metrics, thresholds, cases } = artifact
  const header = [
    'Cases',
    'Task success',
    'Tool choice',
    'Tool args',
    'Grounded',
    'Refusals correct',
    'Over-refused',
    'Unconfirmed writes',
    'Duplicate writes',
    'Transport failures',
  ]
  const lines = [
    `| | ${header.join(' | ')} |`,
    `| --- | ${header.map(() => '---').join(' | ')} |`,
    ...Object.entries(metrics.byCategory).map(([name, m]) =>
      row(name, m, cases.filter((c) => c.category === name)),
    ),
    row('**Overall**', metrics.overall, cases),
    row('Paraphrase only', metrics.paraphrase, cases.filter((c) => c.tags.includes('paraphrase'))),
  ]
  const { overall } = thresholds.min
  const floors =
    `task success ${overall.taskSuccess}, tool choice ${overall.toolChoice}, tool arguments ${overall.toolArguments}, ` +
    `grounded ${overall.groundedness}, refusals correct ${overall.refusalCorrect}, ` +
    `paraphrase grounded ${thresholds.min.paraphraseGroundedness}`
  return [
    ...lines,
    '',
    `*Thresholds, pinned in \`evals/thresholds.json\`: at least ${floors}; over-refused at most ${thresholds.max.overRefusal}; the last three columns must be 0.*`,
    '',
    `*Generated from \`evals/results/latest.json\` (dataset version ${artifact.datasetVersion}, ${metrics.overall.cases} cases). Do not edit by hand: run \`npm run eval -- --update-readme\`.*`,
  ].join('\n')
}

/** The README with the block between the markers replaced by the table. */
export function replaceEvalTable(readme: string, artifact: Artifact): string {
  const start = readme.indexOf(TABLE_START)
  const end = readme.indexOf(TABLE_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README needs ${TABLE_START} and ${TABLE_END} around the eval table`)
  }
  return `${readme.slice(0, start + TABLE_START.length)}\n\n${renderEvalTable(artifact)}\n\n${readme.slice(end)}`
}

/** What is between the markers now. */
export function currentEvalTable(readme: string): string | null {
  const start = readme.indexOf(TABLE_START)
  const end = readme.indexOf(TABLE_END)
  if (start === -1 || end === -1 || end < start) return null
  return readme.slice(start + TABLE_START.length, end).trim()
}
