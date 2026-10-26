import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { Artifact } from '../evals/harness.js'
import { TABLE_END, TABLE_START, currentEvalTable, renderEvalTable, replaceEvalTable } from '../evals/readme.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'results', 'latest.json'), 'utf8')) as Artifact

describe('the README eval table', () => {
  it('is exactly what the committed artifact renders to', () => {
    // If this fails: npm run eval -- --update-readme
    expect(currentEvalTable(readme)).toBe(renderEvalTable(artifact))
  })

  it('has its markers once each, in order', () => {
    expect(readme.split(TABLE_START)).toHaveLength(2)
    expect(readme.split(TABLE_END)).toHaveLength(2)
    expect(readme.indexOf(TABLE_START)).toBeLessThan(readme.indexOf(TABLE_END))
  })

  it('shows every category, the overall and paraphrase rows, and the hard-invariant columns', () => {
    const table = renderEvalTable(artifact)
    for (const word of ['| task |', '| tool |', '| grounded |', '| refusal |', '| injection |', '**Overall**', 'Paraphrase only']) {
      expect(table, word).toContain(word)
    }
    for (const column of ['Unconfirmed writes', 'Duplicate writes', 'Transport failures']) expect(table).toContain(column)
    expect(table).toContain(`${artifact.metrics.overall.cases} cases`)
    expect(table).toContain('npm run eval -- --update-readme')
  })

  it('reports the thresholds the artifact carries', () => {
    const table = renderEvalTable(artifact)
    expect(table).toContain(`grounded ${artifact.thresholds.min.overall.groundedness}`)
    expect(table).toContain(`over-refused at most ${artifact.thresholds.max.overRefusal}`)
  })
})

describe('replaceEvalTable', () => {
  const doc = `before\n\n${TABLE_START}\nold table\n${TABLE_END}\n\nafter\n`

  it('replaces only what is between the markers, and is idempotent', () => {
    const once = replaceEvalTable(doc, artifact)
    expect(once.startsWith(`before\n\n${TABLE_START}\n\n`)).toBe(true)
    expect(once.endsWith(`\n\n${TABLE_END}\n\nafter\n`)).toBe(true)
    expect(once).not.toContain('old table')
    expect(currentEvalTable(once)).toBe(renderEvalTable(artifact))
    expect(replaceEvalTable(once, artifact)).toBe(once)
  })

  it('refuses a README without the markers, or with them reversed', () => {
    expect(() => replaceEvalTable('no markers', artifact)).toThrow('README needs')
    expect(() => replaceEvalTable(`${TABLE_END}\n${TABLE_START}`, artifact)).toThrow('README needs')
    expect(currentEvalTable('nothing here')).toBeNull()
  })
})

describe('the README keeps up with the code', () => {
  const serverFiles = fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.ts'))

  it('documents every environment variable the server reads', () => {
    const vars = new Set<string>()
    for (const file of serverFiles) {
      const text = fs.readFileSync(path.join(ROOT, 'server', file), 'utf8')
      for (const match of text.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)) vars.add(match[1]!)
    }
    expect([...vars].sort()).toEqual(
      expect.arrayContaining(['PORT', 'MODEL_PROVIDER', 'HELPDECK_TOOLS', 'HELPDECK_OPERATOR_TOKEN', 'SPANLIGHT_URL']),
    )
    for (const name of vars) expect(readme, `${name} is read by the server`).toContain(`\`${name}\``)
  })

  it('lists every server module in the project layout', () => {
    for (const file of serverFiles) expect(readme, file).toContain(`\`server/${file}\``)
  })

  it('has no hard-coded test count to go stale', () => {
    expect(readme).not.toMatch(/\b\d+ tests\b/)
  })

  it('has mermaid blocks that open and close', () => {
    const fences = readme.match(/^```/gm) ?? []
    expect(fences.length % 2).toBe(0)
    expect((readme.match(/^```mermaid$/gm) ?? []).length).toBe(2)
  })
})
