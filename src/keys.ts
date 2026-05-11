/**
 * Mirage front-panel key byte codes for MASOS keypress simulation
 * (SysEx cmd 0x01). Ported from the working python project at
 * /Users/brandonivers/Development/mirage/mirage/keys.py.
 *
 * Source: MASOS MIDI Implementation §3.3 + Electra One community docs
 * (https://forum.electra.one/t/ensoniq-mirage-masos-template/1884).
 */

export const KEY = {
  // Numeric keys 0-9 (digit 0 doubles as PROG)
  N0: 0x00,
  N1: 0x01,
  N2: 0x02,
  N3: 0x03,
  N4: 0x04,
  N5: 0x05,
  N6: 0x06,
  N7: 0x07,
  N8: 0x08,
  N9: 0x09,

  // Control keys
  ENTER: 0x0a,
  CANCEL: 0x0b,
  PARAM: 0x0c,
  VALUE: 0x0d,
  UP: 0x0e,
  DOWN: 0x0f,

  // Operation keys
  LOAD_UPPER: 0x10,
  LOAD_LOWER: 0x11,
  SAMPLE_UPPER: 0x12,
  SAMPLE_LOWER: 0x13,
  REC_SEQ: 0x14,
  PLAY_SEQ: 0x15,
  LOAD_SEQ: 0x16,
  SAVE_SEQ: 0x17,
} as const;

/** Max keys per cmd-0x01 message (manual: "Up to 5 bytes"). */
export const MAX_KEYS_PER_MESSAGE = 5;

const ALIASES: Record<string, number> = {
  prog: KEY.N0,
  enter: KEY.ENTER,
  start: KEY.ENTER,
  cancel: KEY.CANCEL,
  stop: KEY.CANCEL,
  param: KEY.PARAM,
  value: KEY.VALUE,
  up: KEY.UP,
  down: KEY.DOWN,
  'load-upper': KEY.LOAD_UPPER,
  'load-lower': KEY.LOAD_LOWER,
  'sample-upper': KEY.SAMPLE_UPPER,
  'sample-lower': KEY.SAMPLE_LOWER,
  'rec-seq': KEY.REC_SEQ,
  'play-seq': KEY.PLAY_SEQ,
  'load-seq': KEY.LOAD_SEQ,
  'save-seq': KEY.SAVE_SEQ,
};

/**
 * Parse a single key token. Accepts:
 *   - decimal digit "0".."9"
 *   - 0x-prefixed hex byte (0x00..0x17)
 *   - alias name (case-insensitive): enter, cancel, param, value, up,
 *     down, prog, load-upper, load-lower, sample-upper, sample-lower,
 *     rec-seq, play-seq, load-seq, save-seq
 */
export function parseKey(token: string): number {
  const t = token.trim().toLowerCase();
  if (t in ALIASES) return ALIASES[t]!;
  if (/^[0-9]$/.test(t)) return Number(t);
  if (/^0x[0-9a-f]+$/.test(t)) {
    const v = Number(t);
    if (v < 0 || v > 0x17) {
      throw new Error(`key 0x${v.toString(16)} out of range 0x00..0x17`);
    }
    return v;
  }
  throw new Error(`unknown key token "${token}"`);
}

/** Encode integer n (>= 0) as decimal-digit keypresses, zero-padded. */
export function digitsOf(n: number, width = 2): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`digitsOf: n must be a non-negative integer, got ${n}`);
  }
  const s = String(n).padStart(width, '0');
  if (s.length > width) {
    throw new Error(`digitsOf: ${n} does not fit in ${width} digits`);
  }
  return Array.from(s, (c) => Number(c));
}
