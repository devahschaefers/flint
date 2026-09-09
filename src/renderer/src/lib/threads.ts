/**
 * Conversation helpers. Threads themselves are computed by main (see
 * src/main/queries.ts); the renderer only tidies what it shows.
 */

/** Subject with reply prefixes stripped ("Re: Re: X" → "X") */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?)\s*:\s*)+/i, '').trim()
}
