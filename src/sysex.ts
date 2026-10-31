/**
 * Ensoniq Mirage MASOS SysEx builders.
 *
 * Verified against the Advanced Sampler's Guide (MASOS) §3.1.6 and §3.1.8.
 *
 * Primary upload path: **Wavesample Dump Absolute** (cmd 0x0C). Each
 * message carries an explicit start/end address pair plus its data
 * payload, so we don't have to pre-select a wavesample on the front
 * panel and we can freely chunk a 64 KB upload into smaller messages.
 *
 * Wire format for cmd 0x0C:
 *
 *   F0 0F 01 0C
 *     <000N LLLL>     N bit + LS nybble of start_addr_lo  (1 byte)
 *     <0000 LLLL>     MS nybble of start_addr_lo          (1 byte)
 *     <0000 HHHH>     LS nybble of start_addr_hi          (1 byte)
 *     <0000 HHHH>     MS nybble of start_addr_hi          (1 byte)
 *     <0000 LLLL>     LS nybble of end_addr_lo            (1 byte)
 *     <0000 LLLL>     MS nybble of end_addr_lo            (1 byte)
 *     <0000 HHHH>     LS nybble of end_addr_hi            (1 byte)
 *     <0000 HHHH>     MS nybble of end_addr_hi            (1 byte)
 *     <data nybbles, low-first>                           (2N bytes for N samples)
 *     <0ccc cccc>     checksum: mod-128 sum of all data
 *                     nybbles + all address nybbles (excl. N bit)
 *   F7
 *
 * End address is INCLUSIVE: a single-byte upload to address 0x0000 sends
 * start=0x0000, end=0x0000.
 */

import {
  ABS_N_BIT_UPPER,
  CMD,
  ENSONIQ_ID,
  KEYPRESS_END,
  MIRAGE_ID,
  SYSEX_END,
  SYSEX_START,
  WAVESAMPLE_CHUNK_BYTES,
  type Half,
} from './constants.js';
import { MAX_KEYS_PER_MESSAGE } from './keys.js';

// ---------------------------------------------------------------------------
// Generic framing
// ---------------------------------------------------------------------------

/** Wrap a payload with F0 0F 01 <cmd> ... F7. */
export function frame(cmd: number, payload: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(payload.length + 5);
  out[0] = SYSEX_START;
  out[1] = ENSONIQ_ID;
  out[2] = MIRAGE_ID;
  out[3] = cmd & 0x7f;
  for (let i = 0; i < payload.length; i++) out[4 + i] = payload[i]! & 0xff;
  out[out.length - 1] = SYSEX_END;
  return out;
}

// ---------------------------------------------------------------------------
// Nybble encoding (low-first, MS clear) — used for all wavesample data
// ---------------------------------------------------------------------------

/**
 * Split each 8-bit byte into two SysEx-safe nybble bytes (low nybble
 * first, MS nybble cleared). Returns the nybble stream and its checksum
 * contribution (mod-128 sum of every nybble).
 */
export function encodeNybbles(bytes: Uint8Array): {
  nybbles: Uint8Array;
  sum: number;
} {
  const out = new Uint8Array(bytes.length * 2);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const lo = b & 0x0f;
    const hi = (b >> 4) & 0x0f;
    out[i * 2] = lo;
    out[i * 2 + 1] = hi;
    sum += lo + hi;
  }
  return { nybbles: out, sum };
}

/** Inverse of {@link encodeNybbles}. */
export function decodeNybbles(nybbles: ArrayLike<number>): Uint8Array {
  if (nybbles.length % 2 !== 0) {
    throw new Error(`nybble stream length must be even, got ${nybbles.length}`);
  }
  const out = new Uint8Array(nybbles.length / 2);
  for (let i = 0; i < out.length; i++) {
    const lo = nybbles[i * 2]! & 0x0f;
    const hi = nybbles[i * 2 + 1]! & 0x0f;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wavesample Dump Absolute (cmd 0x0C) — preferred upload path
// ---------------------------------------------------------------------------

/** Split a 16-bit value into 4 nybbles in the on-wire order. */
function addressNybbles(addr16: number): [number, number, number, number] {
  const lo = addr16 & 0xff;
  const hi = (addr16 >> 8) & 0xff;
  return [lo & 0x0f, (lo >> 4) & 0x0f, hi & 0x0f, (hi >> 4) & 0x0f];
}

export interface WavesampleAbsoluteOpts {
  half: Half;
  /** Inclusive start address in the half's 64 KB RAM. Default 0x0000. */
  startAddress?: number;
  /** Audio bytes (8-bit unsigned mono). */
  audio8: Uint8Array;
}

/**
 * Build one Wavesample-Absolute SysEx message (cmd 0x0C) covering
 * `audio8.length` bytes starting at `startAddress`. End address is
 * `startAddress + audio8.length` (EXCLUSIVE). The ASG manual is
 * misleading here — it describes the field as "end address" but the
 * hardware NAKs unless we send start+length (verified by sweep against
 * a live Mirage 2026-05-10).
 */
export function buildWavesampleAbsolute(
  opts: WavesampleAbsoluteOpts
): Uint8Array {
  const start = opts.startAddress ?? 0;
  const len = opts.audio8.length;
  if (len === 0) throw new Error('empty audio payload');
  if (start < 0 || start > 0xffff) {
    throw new Error(`startAddress ${start} out of range 0..0xFFFF`);
  }
  if (start + len > 0x10000) {
    throw new Error(
      `upload of ${len} B at 0x${start.toString(16)} would exceed 64 KB bank`
    );
  }
  // End address is EXCLUSIVE: a 256-byte chunk at 0x0000 sends end=0x0100.
  // This wraps modulo 0x10000, which is what we want for filling the
  // top of memory (e.g. 256 B at 0xFF00 sends end=0x0000).
  const end = (start + len) & 0xffff;

  const [sLoLs, sLoMs, sHiLs, sHiMs] = addressNybbles(start);
  const [eLoLs, eLoMs, eHiLs, eHiMs] = addressNybbles(end);

  const nBit = opts.half === 'upper' ? ABS_N_BIT_UPPER : 0;

  // Header bytes: 8 nybble-carriers, with N bit OR'd into the first.
  const addrBytes = [
    nBit | sLoLs,
    sLoMs,
    sHiLs,
    sHiMs,
    eLoLs,
    eLoMs,
    eHiLs,
    eHiMs,
  ];

  // Checksum: mod-128 sum of address nybbles (excluding the N bit) + all
  // data nybbles. Per ASG §3.1.6.
  const addrSum = sLoLs + sLoMs + sHiLs + sHiMs + eLoLs + eLoMs + eHiLs + eHiMs;
  const { nybbles, sum: dataSum } = encodeNybbles(opts.audio8);
  const checksum = (addrSum + dataSum) & 0x7f;

  const total = 4 + addrBytes.length + nybbles.length + 1 + 1;
  const out = new Uint8Array(total);
  let i = 0;
  out[i++] = SYSEX_START;
  out[i++] = ENSONIQ_ID;
  out[i++] = MIRAGE_ID;
  out[i++] = CMD.WAVESAMPLE_ABS_DATA;
  for (const b of addrBytes) out[i++] = b;
  out.set(nybbles, i);
  i += nybbles.length;
  out[i++] = checksum;
  out[i++] = SYSEX_END;
  return out;
}

export interface WaveformDumpOpts {
  half: Half;
  audio8: Uint8Array;
  /** Inclusive start address. Default 0x0000. */
  startAddress?: number;
  /** Audio bytes per SysEx message. Default {@link WAVESAMPLE_CHUNK_BYTES}. */
  chunkBytes?: number;
}

/**
 * Build a list of Wavesample-Absolute messages covering `audio8`,
 * chunked at page boundaries. Pass the resulting frames to
 * `sendSysexFrames` (or `MirageLink.sendSysex`) with the documented
 * 20 ms inter-message delay.
 */
export function buildWaveformDump(opts: WaveformDumpOpts): Uint8Array[] {
  const chunkBytes = opts.chunkBytes ?? WAVESAMPLE_CHUNK_BYTES;
  if (chunkBytes < 1 || chunkBytes > 0x10000) {
    throw new Error(`chunkBytes ${chunkBytes} out of range 1..65536`);
  }
  const startAddress = opts.startAddress ?? 0;
  const frames: Uint8Array[] = [];
  for (let off = 0; off < opts.audio8.length; off += chunkBytes) {
    const slice = opts.audio8.subarray(off, off + chunkBytes);
    frames.push(
      buildWavesampleAbsolute({
        half: opts.half,
        startAddress: startAddress + off,
        audio8: slice,
      })
    );
  }
  return frames;
}

/** Concatenate frames into one buffer (useful for `.syx` files). */
export function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wavesample Dump Data (cmd 0x06) — alternative upload path
// ---------------------------------------------------------------------------
//
// Per ASG §3.1.8: "Used to transfer data into the currently selected
// wavesample on the Mirage." Unlike cmd 0x0C (absolute), this one targets
// the wavesample window the user has selected on the front panel
// (parameter [26] Wavesample Select), so what you upload is what plays
// — no need to also rewrite program parameters.
//
// Layout:
//   F0 0F 01 06
//     <page_count_ls>   page count LS nybble  (1 byte)
//     <page_count_ms>   page count MS nybble  (1 byte)
//     <data nybbles, low-first>
//     <checksum>        mod-128 sum of data nybbles + page count
//   F7
//
// Page = 256 bytes. Page count is the TOTAL pages in the dump
// (count, not count-1 — verified against MASOS source listings).

export interface WavesampleDumpOpts {
  /** Audio bytes. Must be a multiple of 256 (one page). */
  audio8: Uint8Array;
}

/**
 * Build a single Wavesample-Dump (cmd 0x06) SysEx message. The Mirage
 * applies the data to whichever wavesample is currently selected on the
 * front panel, replacing exactly its `wavesample_end - wavesample_start`
 * window. The caller is responsible for sizing `audio8` to match that
 * window.
 */
export function buildWavesampleDump(opts: WavesampleDumpOpts): Uint8Array {
  const { audio8 } = opts;
  if (audio8.length === 0) throw new Error('empty audio payload');
  if (audio8.length % 256 !== 0) {
    throw new Error(
      `audio length ${audio8.length} is not a multiple of 256 bytes (one page)`
    );
  }
  const pageCount = audio8.length / 256;
  if (pageCount > 0xff) {
    throw new Error(`page count ${pageCount} exceeds 255`);
  }

  const pcLs = pageCount & 0x0f;
  const pcMs = (pageCount >> 4) & 0x0f;
  const { nybbles, sum: dataSum } = encodeNybbles(audio8);
  const checksum = (pcLs + pcMs + dataSum) & 0x7f;

  const out = new Uint8Array(4 + 2 + nybbles.length + 1 + 1);
  let i = 0;
  out[i++] = SYSEX_START;
  out[i++] = ENSONIQ_ID;
  out[i++] = MIRAGE_ID;
  out[i++] = CMD.WAVESAMPLE_DUMP_DATA;
  out[i++] = pcLs;
  out[i++] = pcMs;
  out.set(nybbles, i);
  i += nybbles.length;
  out[i++] = checksum;
  out[i++] = SYSEX_END;
  return out;
}

// ---------------------------------------------------------------------------
// Ack / Nak detection (Mirage → Mac)
// ---------------------------------------------------------------------------

/** Is this SysEx a wavesample-dump ACK? */
export function isWavesampleAck(bytes: ArrayLike<number>): boolean {
  return (
    bytes.length === 5 &&
    bytes[0] === SYSEX_START &&
    bytes[1] === ENSONIQ_ID &&
    bytes[2] === MIRAGE_ID &&
    bytes[3] === CMD.WAVESAMPLE_ACK &&
    bytes[4] === SYSEX_END
  );
}

/** Is this SysEx a wavesample-dump NAK? */
export function isWavesampleNak(bytes: ArrayLike<number>): boolean {
  return (
    bytes.length === 5 &&
    bytes[0] === SYSEX_START &&
    bytes[1] === ENSONIQ_ID &&
    bytes[2] === MIRAGE_ID &&
    bytes[3] === CMD.WAVESAMPLE_NAK &&
    bytes[4] === SYSEX_END
  );
}

// ---------------------------------------------------------------------------
// Keypress simulation (cmd 0x01)  — ASG §3.1.1
// ---------------------------------------------------------------------------

/**
 * Build a front-panel keypress SysEx message: cmd 0x01, then 1..5 key
 * bytes (codes from `keys.ts`), then the keypress end-of-command marker
 * 0x7F, then F7.
 *
 * The Mirage applies the key bytes in order as if the user pressed them
 * on the front panel. No ACK is sent in reply (only side-effecting
 * messages like VALUE-read or program load generate replies).
 */
export function buildKeypress(keyBytes: ArrayLike<number>): Uint8Array {
  const n = keyBytes.length;
  if (n === 0) throw new Error('buildKeypress: at least one key required');
  if (n > MAX_KEYS_PER_MESSAGE) {
    throw new Error(
      `buildKeypress: ${n} keys exceeds max ${MAX_KEYS_PER_MESSAGE} per message`
    );
  }
  for (let i = 0; i < n; i++) {
    const k = keyBytes[i]!;
    if (!Number.isInteger(k) || k < 0 || k > 0x7f) {
      throw new Error(`buildKeypress: key #${i}=${k} out of range 0..0x7F`);
    }
  }
  const out = new Uint8Array(4 + n + 2);
  let i = 0;
  out[i++] = SYSEX_START;
  out[i++] = ENSONIQ_ID;
  out[i++] = MIRAGE_ID;
  out[i++] = CMD.KEYPRESS;
  for (let k = 0; k < n; k++) out[i++] = keyBytes[k]! & 0x7f;
  out[i++] = KEYPRESS_END;
  out[i++] = SYSEX_END;
  return out;
}

// ---------------------------------------------------------------------------
// Wavesample Parameter Message (cmd 0x0E) — ASG §3.2.2
// ---------------------------------------------------------------------------
//
// Layout:
//   F0 0F 01 0E
//     OOONOSSS   N bit (1=upper) + wavesample # (0..7 on wire = 1..8 on UI)
//     0XXXXXXX   parameter number
//     0000LLLL   value LS nybble
//     0000MMMM   value MS nybble
//   F7
//
// Wavesamples are numbered 1..8 on the front panel; the wire encoding
// is 0..7. We accept the 1-based form for convenience.

export interface WavesampleParamOpts {
  half: Half;
  /** Wavesample number 1..8 (front-panel numbering). */
  wavesample: number;
  /** Parameter number 0..127. */
  param: number;
  /** Value 0..255. */
  value: number;
}

export function buildWavesampleParam(opts: WavesampleParamOpts): Uint8Array {
  const { half, wavesample, param, value } = opts;
  if (!Number.isInteger(wavesample) || wavesample < 1 || wavesample > 8) {
    throw new Error(`wavesample ${wavesample} out of range 1..8`);
  }
  if (!Number.isInteger(param) || param < 0 || param > 0x7f) {
    throw new Error(`param ${param} out of range 0..127`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`value ${value} out of range 0..255`);
  }
  const wsOnWire = (wavesample - 1) & 0x07;
  const nBit = half === 'upper' ? 0x08 : 0x00; // N is bit 3 in OOONOSSS
  const byte0 = nBit | wsOnWire;
  const valLs = value & 0x0f;
  const valMs = (value >> 4) & 0x0f;
  return new Uint8Array([
    SYSEX_START,
    ENSONIQ_ID,
    MIRAGE_ID,
    0x0e,
    byte0,
    param & 0x7f,
    valLs,
    valMs,
    SYSEX_END,
  ]);
}

// ---------------------------------------------------------------------------
// Program Parameter Message (cmd 0x0D) — MASOS §3.2.1
// ---------------------------------------------------------------------------
//
//   F0 0F 01 0D
//     OOONOOPP   N bit (1=upper) + program # (0..3)
//     0XXXXXXX   parameter number
//     0000LLLL   value LS nybble
//     0000MMMM   value MS nybble
//   F7
//
// Documented as a "transmit" (Mirage→host) message, but the Mirage also
// accepts it in the receive direction to set a program parameter, by
// symmetry with cmd 0x0E (wavesample parameter).

export interface ProgramParamOpts {
  half: Half;
  /** Program number 0..3 (Mirage holds 4 programs per half). */
  program?: number;
  /** Parameter number 0..127. */
  param: number;
  /** Value 0..255. */
  value: number;
}

export function buildProgramParam(opts: ProgramParamOpts): Uint8Array {
  const { half, param, value } = opts;
  const program = opts.program ?? 0;
  if (!Number.isInteger(program) || program < 0 || program > 3) {
    throw new Error(`program ${program} out of range 0..3`);
  }
  if (!Number.isInteger(param) || param < 0 || param > 0x7f) {
    throw new Error(`param ${param} out of range 0..127`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`value ${value} out of range 0..255`);
  }
  const nBit = half === 'upper' ? 0x10 : 0x00; // N is bit 4 in OOONOOPP
  const byte0 = nBit | (program & 0x03);
  const valLs = value & 0x0f;
  const valMs = (value >> 4) & 0x0f;
  return new Uint8Array([
    SYSEX_START,
    ENSONIQ_ID,
    MIRAGE_ID,
    0x0d,
    byte0,
    param & 0x7f,
    valLs,
    valMs,
    SYSEX_END,
  ]);
}

// ---------------------------------------------------------------------------
// Wavesample Dump Absolute Request (cmd 0x0B) and parsing of the 0x0C reply —
// ASG §3.1.5 / §3.1.6. The Mirage answers a request with one or more cmd 0x0C
// messages covering the requested range.
// ---------------------------------------------------------------------------

export interface WavesampleAbsoluteRequestOpts {
  half: Half;
  /** Inclusive start address in the half's 64 KB RAM. */
  startAddress: number;
  /** End address as sent on the wire; see `buildWavesampleAbsolute` for the exclusive convention. */
  endAddress: number;
}

/** Build a cmd 0x0B request for `startAddress..endAddress` of one half. */
export function buildWavesampleAbsoluteRequest(
  opts: WavesampleAbsoluteRequestOpts
): Uint8Array {
  for (const [name, v] of [
    ['startAddress', opts.startAddress],
    ['endAddress', opts.endAddress],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new Error(`${name} ${v} out of range 0..0xFFFF`);
    }
  }
  const [sLoLs, sLoMs, sHiLs, sHiMs] = addressNybbles(opts.startAddress);
  const [eLoLs, eLoMs, eHiLs, eHiMs] = addressNybbles(opts.endAddress);
  const nBit = opts.half === 'upper' ? ABS_N_BIT_UPPER : 0;
  return frame(CMD.WAVESAMPLE_ABS_REQUEST, [
    nBit | sLoLs,
    sLoMs,
    sHiLs,
    sHiMs,
    eLoLs,
    eLoMs,
    eHiLs,
    eHiMs,
  ]);
}

export interface WavesampleAbsoluteData {
  half: Half;
  startAddress: number;
  endAddress: number;
  audio8: Uint8Array;
  checksumOk: boolean;
}

/** Is this message a cmd 0x0C wavesample-absolute data frame? */
export function isWavesampleAbsoluteData(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 14 &&
    bytes[0] === SYSEX_START &&
    bytes[1] === ENSONIQ_ID &&
    bytes[2] === MIRAGE_ID &&
    bytes[3] === CMD.WAVESAMPLE_ABS_DATA &&
    bytes[bytes.length - 1] === SYSEX_END
  );
}

/** Decode a cmd 0x0C frame (the Mirage's reply to 0x0B, or our own upload frame). */
export function parseWavesampleAbsoluteData(
  bytes: Uint8Array
): WavesampleAbsoluteData {
  if (!isWavesampleAbsoluteData(bytes)) {
    throw new Error('not a wavesample-absolute data frame');
  }
  const a = Array.from(bytes.slice(4, 12), (b) => b & 0x0f);
  const half: Half = (bytes[4]! & ABS_N_BIT_UPPER) !== 0 ? 'upper' : 'lower';
  const startAddress = a[0]! | (a[1]! << 4) | (a[2]! << 8) | (a[3]! << 12);
  const endAddress = a[4]! | (a[5]! << 4) | (a[6]! << 8) | (a[7]! << 12);
  const nybbles = bytes.slice(12, bytes.length - 2);
  const checksum = bytes[bytes.length - 2]! & 0x7f;
  const audio8 = decodeNybbles(nybbles);
  let sum = a.reduce((s, n) => s + n, 0);
  for (const n of nybbles) sum += n & 0x0f;
  return {
    half,
    startAddress,
    endAddress,
    audio8,
    checksumOk: (sum & 0x7f) === checksum,
  };
}
