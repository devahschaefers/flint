/**
 * Plain text out of an HTML mail body, for senders that ship no text/plain
 * part (or a token one). Good enough for search indexing and a fallback
 * rendering; not a layout engine. Hand-rolled on purpose: no dependency.
 *
 * Steps: drop comments and the contents of script/style/head/noscript/
 * template, turn block-level boundaries into newlines and cell boundaries
 * into spaces, strip the remaining tags, decode entities, collapse whitespace.
 */

const DROP_WITH_CONTENT = /<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const COMMENTS = /<!--[\s\S]*?-->/g
const BLOCK_BREAK =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|tfoot|blockquote|pre|section|article|header|footer|nav|aside|address|figure|figcaption|fieldset|legend|form|center|title)\b[^>]*\/?>/gi
const CELL_BREAK = /<\/?(?:td|th)\b[^>]*>/gi
/** A real tag starts with a letter, `/`, `!` or `?` — a lone `<` in prose is left alone */
const TAGS = /<\/?[a-zA-Z!?][^>]*>/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  iexcl: '¡',
  iquest: '¿',
  sect: '§',
  para: '¶',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  hearts: '♥',
  check: '✓',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  ccedil: 'ç',
  ntilde: 'ñ',
  oacute: 'ó',
  iacute: 'í',
  uacute: 'ú',
  oslash: 'ø',
  aring: 'å',
  aelig: 'æ'
}

export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (m, body) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10)
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
        // Surrogate halves and NUL are not text
        if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return ''
        return String.fromCodePoint(code)
      }
      const named = NAMED_ENTITIES[body]
      return named !== undefined ? named : m
    }
  )
}

export function htmlToText(html: string): string {
  let s = html.replace(COMMENTS, '')
  s = s.replace(DROP_WITH_CONTENT, '')
  s = s.replace(BLOCK_BREAK, '\n')
  s = s.replace(CELL_BREAK, ' ')
  s = s.replace(TAGS, '')
  s = decodeEntities(s)
  // Collapse horizontal whitespace, trim lines, one newline between blocks
  // (an opening and a closing block tag both produce one, so runs are normal)
  s = s.replace(/[ \t\r\f\v\u00a0]+/g, ' ')
  s = s
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}

/** Below this many non-blank characters a text part is not worth keeping over its HTML */
export const TRIVIAL_TEXT_CHARS = 20

/**
 * The plain text to store for a message: the sender's text part when it
 * carries content, otherwise text derived from the HTML part. Returns the
 * input text unchanged when there is nothing better.
 */
export function bestPlainText(text: string, html: string | null): string {
  const trimmed = text.trim()
  if (trimmed.length >= TRIVIAL_TEXT_CHARS || !html) return text
  const derived = htmlToText(html)
  return derived.length > trimmed.length ? derived : text
}
