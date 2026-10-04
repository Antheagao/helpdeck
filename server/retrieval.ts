/**
 * Keyless retrieval: BM25 over the markdown knowledge base, implemented from
 * scratch. No embeddings, no vector store, no API calls - for a support bot
 * over a few hundred passages, lexical ranking answers "which doc section
 * covers this" well, and it runs anywhere.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface Passage {
  id: string
  source: string
  heading: string
  text: string
}

export interface Hit extends Passage {
  score: number
}

// Question scaffolding carries no topic signal, and in short queries it is
// loud enough to outrank the real content terms (an early version answered
// "how does the token budget work?" from the FAQ because "does" and "work"
// matched there).
const STOPWORDS = new Set(
  ('a an and are as at be but by can could did do does for from has have how i if ' +
    'in is it its me my of on or should that the this to was what when where which ' +
    'who will with would you your').split(' '),
)

/** How many times a heading term counts relative to a body term. Headings
 *  name the topic of their section, so a heading match is strong evidence -
 *  the standard BM25F field-weighting idea, kept to one knob. */
const HEADING_WEIGHT = 3

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

const K1 = 1.5
const B = 0.75

export class BM25Index {
  private readonly df = new Map<string, number>()
  private readonly termFreqs: Map<string, number>[] = []
  private readonly lengths: number[] = []
  private readonly avgLength: number

  constructor(readonly passages: Passage[]) {
    for (const passage of passages) {
      const headingTerms = tokenize(passage.heading)
      const bodyTerms = tokenize(passage.text)
      const tf = new Map<string, number>()
      for (const term of bodyTerms) tf.set(term, (tf.get(term) ?? 0) + 1)
      for (const term of headingTerms) {
        tf.set(term, (tf.get(term) ?? 0) + HEADING_WEIGHT)
      }
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
      this.termFreqs.push(tf)
      // Length normalization uses the real body length: the heading boost is
      // evidence, and must not also inflate the document's length penalty.
      this.lengths.push(bodyTerms.length)
    }
    this.avgLength =
      this.lengths.length === 0
        ? 0
        : this.lengths.reduce((a, b) => a + b, 0) / this.lengths.length
  }

  search(query: string, k = 4): Hit[] {
    const terms = [...new Set(tokenize(query))]
    const n = this.passages.length
    const scores = this.passages.map((passage, i) => {
      const tf = this.termFreqs[i]!
      const len = this.lengths[i]!
      let score = 0
      for (const term of terms) {
        const freq = tf.get(term)
        if (!freq) continue
        const docFreq = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5))
        score += (idf * freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * len) / this.avgLength))
      }
      return { ...passage, score }
    })
    return scores
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }

  /** Build an index from every .md file in a directory, one passage per
   *  heading section. */
  static fromMarkdownDir(dir: string): BM25Index {
    const passages: Passage[] = []
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const body = fs.readFileSync(path.join(dir, file), 'utf8')
      const sections = body.split(/^(?=#{1,3} )/m)
      for (const section of sections) {
        const text = section.trim()
        if (!text) continue
        const headingMatch = /^#{1,3} (.+)$/m.exec(text)
        passages.push({
          id: `${file}#${passages.length}`,
          source: file,
          heading: headingMatch?.[1] ?? file,
          text,
        })
      }
    }
    return new BM25Index(passages)
  }
}
