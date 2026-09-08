import DOMPurify, { type Config } from 'dompurify'

/**
 * Sanitizes a message's text/html part for display in the thread view.
 *
 * On top of DOMPurify's html profile (scripts, event handlers, iframes, svg,
 * forms already gone) this module:
 *
 * - blocks remote images by default. Anything the browser would fetch on
 *   render (`src`, `srcset`, `poster`, legacy `background`) is dropped unless
 *   it is a `data:` or `cid:` URL, and inline `style` declarations with a
 *   remote `url(...)` are removed. An `<img>` that lost its src keeps its
 *   width/height/alt and gets a faint placeholder background.
 * - counts how many elements had something blocked, so the caller can offer
 *   a "Load images" affordance only when it would change anything.
 * - forces `rel="noreferrer noopener"` on every link and explicitly forbids
 *   `<base>`, `<meta>`, `<link>` (belt and braces: the html profile does not
 *   allow them anyway).
 */

export interface SanitizeMailOptions {
  /** When true, remote image references are left in place. */
  allowRemoteImages: boolean
}

export interface SanitizedMail {
  html: string
  /**
   * Number of elements that referenced at least one remote resource which
   * was removed. 0 when nothing was blocked (including when remote images
   * were allowed).
   */
  blockedImages: number
}

/** Attributes whose value the browser fetches as a resource when rendering. */
const FETCHING_ATTRS = new Set(['src', 'srcset', 'poster', 'background', 'lowsrc', 'dynsrc'])

/**
 * The only URL schemes an image may use without a network round-trip. This
 * is an allowlist on purpose: `\\host/x`, `ht\ttp://`, `//host/x` and
 * friends all resolve to remote URLs, so testing for "looks like http" is a
 * losing game.
 */
const SAFE_SCHEME = /^(?:data|cid):/i

/** A srcset descriptor: `2x`, `640w`, `1.5x`. */
const SRCSET_DESCRIPTOR = /^\d*\.?\d+[wx]$/i

/** `url(...)` in a CSS value, with or without quotes. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi

/** Image-producing CSS functions that can carry a URL without `url(`. */
const CSS_IMAGE_FUNCTION =
  /(?:^|[^a-z-])(?:-webkit-)?(?:image-set|image|cross-fade|element|paint)\s*\(/i

const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'base', 'meta', 'link']
} satisfies Config

/** Strips the whitespace/control prefix the URL parser ignores, and inner tabs/newlines. */
function normalizeUrl(url: string): string {
  let start = 0
  while (start < url.length && url.charCodeAt(start) <= 0x20) start++
  return url.slice(start).replace(/[\t\n\r]/g, '')
}

function isSafeUrl(url: string): boolean {
  const normalized = normalizeUrl(url)
  return normalized === '' || SAFE_SCHEME.test(normalized)
}

function isSafeSrcset(srcset: string): boolean {
  // Candidate URLs never contain whitespace, so splitting on it separates URLs
  // from descriptors even for data: URLs with commas in them.
  return srcset.split(/\s+/).every((token) => {
    const bare = token.replace(/,+$/, '')
    return bare === '' || SRCSET_DESCRIPTOR.test(bare) || SAFE_SCHEME.test(bare)
  })
}

function cssValueFetchesRemotely(value: string): boolean {
  if (CSS_IMAGE_FUNCTION.test(value)) return true
  for (const match of value.matchAll(CSS_URL)) {
    const url = match[1] ?? match[2] ?? match[3] ?? ''
    if (!isSafeUrl(url)) return true
  }
  return false
}

/**
 * Removes every declaration in an inline style whose value would fetch a
 * remote resource (background images, list markers, border images, masks,
 * cursors, `content: url()`...). The browser's own CSS parser does the
 * tokenizing, via a detached element that is never attached to the document
 * and therefore never triggers a load.
 */
let styleProbe: HTMLElement | null = null

function stripRemoteCssUrls(css: string): { css: string; blocked: boolean } {
  styleProbe ??= document.createElement('span')
  const style = styleProbe.style
  style.cssText = css
  let blocked = false
  for (let i = style.length - 1; i >= 0; i--) {
    const property = style[i]
    if (cssValueFetchesRemotely(style.getPropertyValue(property))) {
      style.removeProperty(property)
      blocked = true
    }
  }
  const result = { css: style.cssText, blocked }
  style.cssText = ''
  return result
}

/** Marks an `<img>` whose src was removed so it still occupies its box. */
function markImagePlaceholder(img: HTMLElement): void {
  img.setAttribute('data-blocked-image', '')
  const { style } = img
  style.setProperty('background-color', 'rgba(255, 255, 255, 0.06)')
  style.setProperty('outline', '1px dashed rgba(255, 255, 255, 0.12)')
  style.setProperty('outline-offset', '-1px')
  const hasSize =
    img.hasAttribute('width') ||
    img.hasAttribute('height') ||
    style.getPropertyValue('width') !== '' ||
    style.getPropertyValue('height') !== ''
  if (!hasSize) {
    // No intrinsic size and no source: give the alt text (if any) somewhere to sit.
    style.setProperty('display', 'inline-block')
    style.setProperty('min-width', '1em')
    style.setProperty('min-height', '1em')
  }
}

/** Per-call state the hooks read. `sanitize` is synchronous, so a module slot suffices. */
interface Pass {
  allowRemoteImages: boolean
  blocked: Set<Element>
}

let pass: Pass | null = null

// Own instance so the hooks never leak into other DOMPurify users.
const purifier = DOMPurify()

purifier.addHook('uponSanitizeAttribute', (node, event) => {
  if (!pass || pass.allowRemoteImages) return
  const { attrName, attrValue } = event

  if (FETCHING_ATTRS.has(attrName)) {
    const safe = attrName === 'srcset' ? isSafeSrcset(attrValue) : isSafeUrl(attrValue)
    if (!safe) {
      event.keepAttr = false
      pass.blocked.add(node)
    }
    return
  }

  if (attrName === 'style') {
    const stripped = stripRemoteCssUrls(attrValue)
    if (stripped.blocked) {
      pass.blocked.add(node)
      if (stripped.css === '') event.keepAttr = false
      else event.attrValue = stripped.css
    }
  }
})

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.localName === 'a' && node.hasAttribute('href')) {
    node.setAttribute('rel', 'noreferrer noopener')
  }
  if (node.localName === 'img' && pass?.blocked.has(node)) {
    markImagePlaceholder(node as HTMLElement)
  }
})

export function sanitizeMailHtml(html: string, opts: SanitizeMailOptions): SanitizedMail {
  const current: Pass = { allowRemoteImages: opts.allowRemoteImages, blocked: new Set() }
  pass = current
  try {
    return { html: purifier.sanitize(html, CONFIG), blockedImages: current.blocked.size }
  } finally {
    pass = null
  }
}

/*
 * Test cases for the suite (needs a DOM: jsdom or happy-dom).
 *
 * Blocking (allowRemoteImages: false):
 * - `<img src="https://t.example/p.gif" width="1" height="1">` → no src, keeps
 *   width/height, gains data-blocked-image; blockedImages === 1.
 * - `<img src="http://...">`, `<img src="//host/x.png">`, `<img src=" HTTP://...">`,
 *   `<img src="ht&#9;tp://host/x">` → all blocked (allowlist, not a scheme regex).
 * - `<img src="data:image/gif;base64,R0lGOD...">` and `<img src="cid:part1@mail">`
 *   → untouched; blockedImages === 0.
 * - `<img src="">` and `<img>` → untouched, not counted.
 * - `<img srcset="https://h/a.png 1x, https://h/b.png 2x" src="data:...">` → srcset
 *   removed, data src kept, counted once.
 * - `<img srcset="data:image/png;base64,AAA 1x, data:image/png;base64,BBB 2x">` → kept.
 * - `<picture><source srcset="https://h/a.webp" type="image/webp"><img src="https://h/a.jpg"></picture>`
 *   → both srcset and src gone; blockedImages === 2 (one per element).
 * - `<video poster="https://h/p.jpg" src="https://h/v.mp4"></video>` → both removed, counted once.
 * - `<td background="https://h/bg.png">` → attribute removed.
 * - `<div style="color: red; background: url(https://h/bg.png) no-repeat">` → keeps
 *   color and background-repeat, drops background-image; counted.
 * - `<div style="background-image: url('data:image/png;base64,AAA')">` → kept, not counted.
 * - `<div style="background-image: url(https://h/x)">` → style attribute removed entirely.
 * - `<div style="list-style-image: url(//h/x)">`, `border-image`, `cursor`, `mask-image`,
 *   `content: url(...)` → removed.
 * - `<div style="background-image: image-set('https://h/x.png' 1x)">` → removed.
 * - Same input twice → identical output and count (per-call state is reset).
 *
 * Allowing (allowRemoteImages: true):
 * - All of the above keep their src/srcset/poster/style; blockedImages === 0.
 *
 * Always:
 * - `<a href="https://x">` → rel="noreferrer noopener" (also when the source had
 *   rel="something-else"); `<a name="anchor">` without href gets no rel.
 * - `<base href="https://evil/">`, `<meta http-equiv="refresh" ...>`,
 *   `<link rel="stylesheet" href="https://...">`, `<style>`, `<script>`, `<iframe>`,
 *   `<svg><image href="https://..."/></svg>`, `<form>`, `<input type="image" src>`
 *   → all gone.
 * - Output is a string (never a DOM node / TrustedHTML).
 */
