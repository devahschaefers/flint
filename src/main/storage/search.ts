/**
 * Turn what a person typed into a search box into an FTS5 MATCH expression
 * that cannot fail to parse. Every term is emitted as a quoted FTS5 string,
 * so `AND`, `NOT`, `OR`, `NEAR`, parentheses, colons and the like are looked
 * up as words rather than interpreted. Two things are honoured on purpose:
 * a trailing `*` on a term makes it a prefix query, and a run inside double
 * quotes is one phrase. Terms are ANDed (FTS5's implicit conjunction).
 */

export interface SearchTerm {
  /** Words of the term (one for a bare word, several for a quoted phrase) */
  words: string[]
  prefix: boolean
}

const QUOTE = '"'

/** Split a word on anything unicode61 would split on (punctuation, symbols, whitespace) */
function tokenizeWords(s: string): string[] {
  // \p{L}\p{N} plus combining marks keeps diacritics attached to their base letter
  return s.split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w.length > 0)
}

export function parseSearchTerms(raw: string): SearchTerm[] {
  const terms: SearchTerm[] = []
  let i = 0
  const n = raw.length
  while (i < n) {
    const ch = raw[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === QUOTE) {
      // Phrase: up to the closing quote (or end of input)
      const end = raw.indexOf(QUOTE, i + 1)
      const inner = end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end)
      i = end === -1 ? n : end + 1
      let prefix = false
      if (raw[i] === '*') {
        prefix = true
        i++
      }
      const words = tokenizeWords(inner)
      if (words.length > 0) terms.push({ words, prefix })
      continue
    }
    // Bare word: runs to the next whitespace or quote
    let j = i
    while (j < n && !/\s/.test(raw[j]) && raw[j] !== QUOTE) j++
    let word = raw.slice(i, j)
    i = j
    const prefix = word.endsWith('*')
    if (prefix) word = word.replace(/\*+$/, '')
    const words = tokenizeWords(word)
    // A bare word with internal punctuation ("foo.bar", "a-b") becomes a phrase of its parts,
    // which is exactly how the tokenizer indexed it
    if (words.length > 0) terms.push({ words, prefix })
  }
  return terms
}

/**
 * Build the MATCH expression, or null when the input holds no searchable
 * word (the caller should then return no results rather than match everything).
 * Words never contain `"` (the tokenizer split on it), so quoting is plain.
 */
export function buildMatchExpression(raw: string): string | null {
  const terms = parseSearchTerms(raw)
  if (terms.length === 0) return null
  return terms
    .map((t) => {
      const phrase = `"${t.words.join(' ')}"`
      return t.prefix ? `${phrase} *` : phrase
    })
    .join(' AND ')
}
