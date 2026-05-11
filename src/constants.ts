/**
 * Mirage SysEx constants.
 *
 * NOTE: Many of these bytes are PLACEHOLDERS pending decode of the Advanced
 * Sampler's Guide (ASG) — see `docs/protocol.md` (to be written) and the
 * "What we DON'T know yet" section of mirage-cli-handoff.md.
 *
 * Anything marked TODO must be verified before sending to a real Mirage.
 */

// ---------------------------------------------------------------------------
// SysEx framing
// ---------------------------------------------------------------------------

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;

/** Ensoniq manufacturer ID. */
export const ENSONIQ_ID = 0x0f;

/** Mirage product code. */
export const MIRAGE_ID = 0x01;

// ---------------------------------------------------------------------------
// Command bytes (verified against ASG MASOS manual §3.1, §3.2)
// ---------------------------------------------------------------------------
//
// Bit 4 ("N bit") of the command byte selects upper/lower half for the
// program-dump commands. For wavesample-absolute (0x0C) the N bit lives
// in the first payload byte instead. For wavesample-data (0x06) the
// destination is implicit (whichever half is currently selected on the
// Mirage front panel).
//

export const CMD = {
  /** Mac → Mirage: front-panel keypress simulation. Trailing 0x7F before F7. */
  KEYPRESS: 0x01,
  /** Mac → Mirage: configuration parameters dump request. */
  CONFIG_DUMP_REQUEST: 0x00,
  /** Mac → Mirage: program dump request. OR 0x10 for upper. */
  RECV_PROGRAM_LOWER: 0x03,
  /** Mac → Mirage: wavesample dump request (uses currently-selected wavesample). */
  WAVESAMPLE_DUMP_REQUEST: 0x04,
  /** Mac → Mirage: send program data. OR 0x10 for upper. */
  SEND_PROGRAM_LOWER: 0x05,
  /** Mac → Mirage: wavesample dump data (page-count framed, implicit destination). */
  WAVESAMPLE_DUMP_DATA: 0x06,
  /** Mac → Mirage: wavesample absolute request (explicit start/end addresses). */
  WAVESAMPLE_ABS_REQUEST: 0x0b,
  /** Mac → Mirage: wavesample absolute dump data. N bit lives in first payload byte. */
  WAVESAMPLE_ABS_DATA: 0x0c,
  /** Mac → Mirage: MASOS manipulation function (copy/scale/invert/etc.). */
  MANIPULATION: 0x0f,

  /** Mirage → Mac: wavesample dump received OK. */
  WAVESAMPLE_ACK: 0x09,
  /** Mirage → Mac: wavesample dump checksum error. */
  WAVESAMPLE_NAK: 0x0a,
  /** Mirage → Mac: parameter value return. */
  VALUE_RETURN: 0x0d,
} as const;

/** Bit 4 of the program-dump command byte selects upper half. */
export const N_BIT_UPPER = 0x10;

/** Bit 4 of the first 0x0C payload byte selects upper half. */
export const ABS_N_BIT_UPPER = 0x10;

/** MASOS keypress end-of-command marker (precedes F7). */
export const KEYPRESS_END = 0x7f;

// ---------------------------------------------------------------------------
// Slot addressing
// ---------------------------------------------------------------------------

export type Half = 'upper' | 'lower';
export type SlotIndex = 1 | 2 | 3;

export interface Slot {
  half: Half;
  index: SlotIndex;
}

export const SLOT_NAMES = [
  'upper1',
  'upper2',
  'upper3',
  'lower1',
  'lower2',
  'lower3',
] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

export function parseSlot(name: string): Slot {
  const lower = name.toLowerCase();
  if (!(SLOT_NAMES as readonly string[]).includes(lower)) {
    throw new Error(
      `Invalid slot "${name}". Expected one of: ${SLOT_NAMES.join(', ')}`
    );
  }
  const half: Half = lower.startsWith('upper') ? 'upper' : 'lower';
  const index = Number(lower.slice(-1)) as SlotIndex;
  return { half, index };
}

// ---------------------------------------------------------------------------
// Audio / dump format
// ---------------------------------------------------------------------------

/**
 * Default Mirage playback rate (Hz). The Mirage's stock rate ceiling is
 * ~33 kHz; with the optional Input Sampling Filter board it goes to ~50 kHz.
 * MASOS factory samples are commonly stored at ~30 kHz.
 */
export const DEFAULT_SAMPLE_RATE_HZ = 33_000;

/** Lower bound from the Mirage docs. Below ~10 kHz playback gets very dark. */
export const MIN_SAMPLE_RATE_HZ = 10_000;

/** Stock-OS rate ceiling (no Input Sampling Filter). */
export const MAX_SAMPLE_RATE_HZ = 33_000;

/**
 * Bytes of audio per Mirage sound slot.
 *
 * Verified against multiple sources:
 *   - Wikipedia: "128 KB of sample RAM (64 KB for each keyboard half)".
 *   - Izdepski (hardware): 16× MT4164 DRAMs = 128 KB, 64 KB per half.
 *   - Mirage disk format: each "Sound, <Half>, Data" = 64 sectors × 1024 B
 *     = 65,536 B exactly.
 *
 * NB: the three "slots" per half are *disk* slots; only one sound per half
 * is loaded into RAM at a time. So this constant is the per-dump ceiling.
 */
export const SLOT_CAPACITY_BYTES = 64 * 1024;

/**
 * Bytes of 8-bit unsigned mono audio per 0x0C wavesample-absolute SysEx
 * message when chunking a full-bank upload.
 *
 * 256 = exactly one Mirage "page" (per ASG manual §3.1.8). With nybble
 * encoding (2 wire-bytes/sample) + 8 address nybbles + 1 checksum, each
 * SysEx message is ~525 bytes — comfortable for JZZ/CoreMIDI and the
 * Mirage's 6809 input buffer.
 */
export const WAVESAMPLE_CHUNK_BYTES = 256;

/** Mirage page size (bytes). Address space is 0x0000..0xFFFF per half. */
export const MIRAGE_PAGE_BYTES = 256;

/** Documented inter-message delay floor for the Mirage's 6809. */
export const INTER_MESSAGE_DELAY_MS = 20;

/** Max audio duration check at a given rate. */
export function maxDurationSeconds(rateHz: number): number {
  return SLOT_CAPACITY_BYTES / rateHz;
}

// ---------------------------------------------------------------------------
// MIDI port defaults
// ---------------------------------------------------------------------------

/** Default port name. User's Mirage is on MRCC Port 4. */
export const DEFAULT_PORT_NAME = 'MRCC Port 04';

/** Fallback regex used when neither --port nor $MIRAGE_PORT is set. */
export const PORT_AUTODETECT_REGEX = /MRCC Port 0?4\b|Mirage/i;
