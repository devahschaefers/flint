import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/**
 * Body codec: how `messages.body_text` / `messages.body_html` are stored.
 *
 * Every row carries a `body_codec` naming the codec both of its bodies were
 * written with. `'none'` rows hold plain TEXT (the pre-v3 shape, and what a
 * disabled codec writes); every other codec holds a BLOB. SQLite keeps the
 * storage class per value, so the same TEXT-affinity column can hold either,
 * and better-sqlite3 hands back a string for TEXT and a Buffer for BLOB —
 * `decodeBody` accepts both, so a caller never needs to know which shape a
 * row is in.
 *
 * Adding a codec (a trained zstd dictionary, say) means: pick an id of the
 * form `zstd-dict:<id>`, teach `encodeWith`/`decodeWith` about it, and
 * change DEFAULT_CODEC. Rows written with the old codec keep decoding; the
 * compactor can re-encode them at leisure because it treats any row whose
 * codec differs from the default as work to do.
 */

export type BodyCodec = 'none' | 'zstd' | `zstd-dict:${string}`

/** What new rows are written with */
export const DEFAULT_CODEC: BodyCodec = 'zstd'

/**
 * zstd level. Measured on 600 real bodies (30.7 MB): level 3 → 17.1% of raw
 * in 45 ms, level 9 → 15.8% in 196 ms, level 19 → 15.4% in 5.1 s; zlib -9 →
 * 16.4%. Level 9 buys 7% over the default for a compression cost that is
 * still under a millisecond per message. Decompression speed does not depend
 * on the level, and the codec id does not encode it, so it can change freely.
 */
const ZSTD_LEVEL = 9

/** A value as SQLite hands it back: TEXT → string, BLOB → Buffer, NULL → null */
export type StoredBody = string | Buffer | null

export function isBodyCodec(value: unknown): value is BodyCodec {
  return (
    value === 'none' ||
    value === 'zstd' ||
    (typeof value === 'string' && value.startsWith('zstd-dict:'))
  )
}

/** Encode a body for storage under `codec`. Null stays null (no HTML part). */
export function encodeBody(text: string | null, codec: BodyCodec = DEFAULT_CODEC): StoredBody {
  if (text === null) return null
  switch (codec) {
    case 'none':
      return text
    case 'zstd':
      return zstdCompressSync(Buffer.from(text, 'utf8'), {
        params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL }
      })
    default:
      throw new Error(`Unknown body codec: ${codec}`)
  }
}

/**
 * Decode a stored body. A string is returned as-is whatever the codec says
 * (TEXT can only have been written plain); a Buffer is decoded per `codec`.
 */
export function decodeBody(stored: StoredBody, codec: BodyCodec): string | null {
  if (stored === null) return null
  if (typeof stored === 'string') return stored
  switch (codec) {
    case 'none':
      // A BLOB under 'none' can only be raw UTF-8 bytes
      return stored.toString('utf8')
    case 'zstd':
      return zstdDecompressSync(stored).toString('utf8')
    default:
      throw new Error(`Unknown body codec: ${codec}`)
  }
}

/** Bytes a stored value occupies (for progress reporting) */
export function storedSize(stored: StoredBody): number {
  if (stored === null) return 0
  return typeof stored === 'string' ? Buffer.byteLength(stored, 'utf8') : stored.length
}
