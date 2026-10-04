import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BM25Index, tokenize } from '../server/retrieval.js'

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')
const index = BM25Index.fromMarkdownDir(DOCS)

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenize('Install the Widget!')).toEqual(['install', 'widget'])
  })

  it('drops question scaffolding that carries no topic signal', () => {
    expect(tokenize('How do I install the Widget?')).toEqual(['install', 'widget'])
    expect(tokenize('What does this do?')).toEqual([])
  })
})

describe('BM25Index over the shipped docs', () => {
  it('builds one passage per heading section', () => {
    expect(index.passages.length).toBeGreaterThan(10)
    expect(index.passages.every((p) => p.source.endsWith('.md'))).toBe(true)
  })

  it('ranks the setup doc first for an installation question', () => {
    const hits = index.search('how do I install and embed the widget on my site')
    expect(hits[0]?.source).toBe('setup.md')
  })

  it('ranks the memory doc first for a summarization question', () => {
    const hits = index.search('token budget rolling summarization')
    expect(hits[0]?.source).toBe('memory.md')
  })

  it('returns nothing for a query with no overlap', () => {
    expect(index.search('quantum blockchain lasagna')).toHaveLength(0)
  })

  it('lets the heading win over incidental body matches (regression)', () => {
    // Found in a real browser session: "does"/"work" matched the FAQ strongly
    // enough to outrank the section actually titled "The token budget".
    const hits = index.search('And how does the token budget work?')
    expect(hits[0]?.source).toBe('memory.md')
    expect(hits[0]?.heading).toBe('The token budget')
  })

  it('keeps citations stable: heading and source survive into hits', () => {
    const [hit] = index.search('spanlight traces latency cost')
    expect(hit?.source).toBe('tracing.md')
    expect(hit?.heading.length).toBeGreaterThan(0)
  })
})
