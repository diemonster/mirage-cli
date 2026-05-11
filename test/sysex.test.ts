import { describe, expect, it } from 'vitest';

import {
  ABS_N_BIT_UPPER,
  CMD,
  ENSONIQ_ID,
  MIRAGE_ID,
  SYSEX_END,
  SYSEX_START,
  WAVESAMPLE_CHUNK_BYTES,
} from '../src/constants.js';
import {
  buildKeypress,
  buildWaveformDump,
  buildWavesampleAbsolute,
  buildWavesampleDump,
  buildWavesampleParam,
  concatFrames,
  decodeNybbles,
  encodeNybbles,
  frame,
  isWavesampleAck,
  isWavesampleNak,
} from '../src/sysex.js';

// ---------------------------------------------------------------------------
// Nybble codec
// ---------------------------------------------------------------------------

describe('encodeNybbles / decodeNybbles', () => {
  it('splits each byte into (low, high) with MS clear', () => {
    const { nybbles, sum } = encodeNybbles(new Uint8Array([0x48, 0xab]));
    // 0x48 -> lo=8, hi=4; 0xab -> lo=0xb, hi=0xa
    expect(Array.from(nybbles)).toEqual([0x08, 0x04, 0x0b, 0x0a]);
    expect(sum).toBe(0x08 + 0x04 + 0x0b + 0x0a);
    // No nybble may have its MS bit set.
    for (const n of nybbles) expect(n & 0xf0).toBe(0);
  });

  it('round-trips through decodeNybbles', () => {
    const input = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0xa5]);
    const { nybbles } = encodeNybbles(input);
    expect(Array.from(decodeNybbles(nybbles))).toEqual(Array.from(input));
  });

  it('rejects odd-length nybble streams', () => {
    expect(() => decodeNybbles([0x01, 0x02, 0x03])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// frame()
// ---------------------------------------------------------------------------

describe('frame()', () => {
  it('wraps payload with F0 0F 01 <cmd> ... F7', () => {
    const f = frame(CMD.KEYPRESS, [0x0c, 0x09, 0x01, 0x0d, 0x7f]);
    expect(f[0]).toBe(SYSEX_START);
    expect(f[1]).toBe(ENSONIQ_ID);
    expect(f[2]).toBe(MIRAGE_ID);
    expect(f[3]).toBe(CMD.KEYPRESS);
    expect(f[f.length - 1]).toBe(SYSEX_END);
  });
});

// ---------------------------------------------------------------------------
// Wavesample-Absolute (cmd 0x0C) message
// ---------------------------------------------------------------------------

describe('buildWavesampleAbsolute', () => {
  it('produces correct framing, addresses, data, and checksum for a tiny lower-half upload', () => {
    const audio = new Uint8Array([0x12, 0x34, 0x56]);
    const msg = buildWavesampleAbsolute({
      half: 'lower',
      startAddress: 0x0000,
      audio8: audio,
    });

    // Header: F0 0F 01 0C
    expect(msg[0]).toBe(SYSEX_START);
    expect(msg[1]).toBe(ENSONIQ_ID);
    expect(msg[2]).toBe(MIRAGE_ID);
    expect(msg[3]).toBe(CMD.WAVESAMPLE_ABS_DATA);

    // 8 address nybbles, lower half (N bit clear), start=0x0000, end=0x0003
    // (end is EXCLUSIVE = start + length).
    expect(msg[4]).toBe(0x00); // N=0 | start_lo_ls=0
    expect(msg[5]).toBe(0x00); // start_lo_ms
    expect(msg[6]).toBe(0x00); // start_hi_ls
    expect(msg[7]).toBe(0x00); // start_hi_ms
    expect(msg[8]).toBe(0x03); // end_lo_ls
    expect(msg[9]).toBe(0x00); // end_lo_ms
    expect(msg[10]).toBe(0x00); // end_hi_ls
    expect(msg[11]).toBe(0x00); // end_hi_ms

    // Data: 3 bytes -> 6 nybbles, low first
    // 0x12 -> 2,1; 0x34 -> 4,3; 0x56 -> 6,5
    expect(Array.from(msg.slice(12, 18))).toEqual([2, 1, 4, 3, 6, 5]);

    // Checksum: sum of address nybbles (0+0+0+0+3+0+0+0=3) + data nybbles
    // (2+1+4+3+6+5=21) = 24. Mod 128 = 24.
    expect(msg[18]).toBe(24);

    // Terminator
    expect(msg[19]).toBe(SYSEX_END);
    expect(msg.length).toBe(20);
  });

  it('sets the N bit in the first address byte for upper-half uploads', () => {
    const msg = buildWavesampleAbsolute({
      half: 'upper',
      startAddress: 0x0000,
      audio8: new Uint8Array([0x00]),
    });
    expect(msg[4]! & ABS_N_BIT_UPPER).toBe(ABS_N_BIT_UPPER);
    // end-address = start + len (exclusive) = 0x0001
    // addr nybs (excl N): 0,0,0,0,1,0,0,0 = 1; data nybs 0,0 = 0; cs = 1.
    expect(msg[msg.length - 2]).toBe(1);
  });

  it('encodes a non-zero start address as 4 nybbles in correct order', () => {
    // start = 0x1234: lo=0x34 -> nyb 4,3; hi=0x12 -> nyb 2,1
    const msg = buildWavesampleAbsolute({
      half: 'lower',
      startAddress: 0x1234,
      audio8: new Uint8Array([0x00]),
    });
    expect(msg[4]).toBe(0x04); // N=0 | start_lo_ls
    expect(msg[5]).toBe(0x03);
    expect(msg[6]).toBe(0x02);
    expect(msg[7]).toBe(0x01);
    // end (exclusive) = 0x1235
    expect(msg[8]).toBe(0x05);
    expect(msg[9]).toBe(0x03);
    expect(msg[10]).toBe(0x02);
    expect(msg[11]).toBe(0x01);
  });

  it('keeps checksum in the 7-bit-safe range', () => {
    // Use 0xFF bytes to maximise the sum.
    const msg = buildWavesampleAbsolute({
      half: 'lower',
      startAddress: 0x0000,
      audio8: new Uint8Array(64).fill(0xff),
    });
    const checksum = msg[msg.length - 2]!;
    expect(checksum).toBeGreaterThanOrEqual(0);
    expect(checksum).toBeLessThanOrEqual(0x7f);
  });

  it('rejects empty audio', () => {
    expect(() =>
      buildWavesampleAbsolute({
        half: 'lower',
        audio8: new Uint8Array(0),
      })
    ).toThrow();
  });

  it('rejects an upload that would overflow address 0xFFFF', () => {
    // start+len would exceed 0x10000. With exclusive end the manual cap is
    // start+len <= 0x10000 (allowing 256B at 0xFF00 to wrap to end=0x0000).
    expect(() =>
      buildWavesampleAbsolute({
        half: 'lower',
        startAddress: 0xff00,
        audio8: new Uint8Array(0x101), // would end at 0x10001
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildWaveformDump — chunked upload
// ---------------------------------------------------------------------------

describe('buildWaveformDump', () => {
  it('produces one frame per chunk', () => {
    const audio = new Uint8Array(700).fill(0x55);
    const frames = buildWaveformDump({
      half: 'lower',
      audio8: audio,
      chunkBytes: 256,
    });
    expect(frames.length).toBe(3); // 256 + 256 + 188
  });

  it('uses contiguous address ranges across chunks', () => {
    const audio = new Uint8Array(513);
    for (let i = 0; i < audio.length; i++) audio[i] = i & 0xff;
    const frames = buildWaveformDump({
      half: 'lower',
      audio8: audio,
      chunkBytes: 256,
    });
    expect(frames.length).toBe(3);

    // Frame 0: start=0x0000, end=0x0100 (exclusive)
    const f0 = frames[0]!;
    expect(f0[4]).toBe(0x00); // N=0 | start_lo_ls
    expect(f0[5]).toBe(0x00);
    expect(f0[6]).toBe(0x00);
    expect(f0[7]).toBe(0x00);
    expect(f0[8]).toBe(0x00); // end_lo_ls (0x00)
    expect(f0[9]).toBe(0x00);
    expect(f0[10]).toBe(0x01); // end_hi_ls
    expect(f0[11]).toBe(0x00);

    // Frame 1: start=0x0100, end=0x0200 (exclusive)
    const f1 = frames[1]!;
    expect(f1[4]).toBe(0x00); // start_lo_ls (0x00)
    expect(f1[5]).toBe(0x00);
    expect(f1[6]).toBe(0x01); // start_hi_ls (0x01)
    expect(f1[7]).toBe(0x00);

    // Frame 2: start=0x0200, end=0x0201 (1-byte chunk, exclusive)
    const f2 = frames[2]!;
    expect(f2[4]).toBe(0x00);
    expect(f2[5]).toBe(0x00);
    expect(f2[6]).toBe(0x02);
    expect(f2[7]).toBe(0x00);
  });

  it('default chunk size matches WAVESAMPLE_CHUNK_BYTES', () => {
    const audio = new Uint8Array(WAVESAMPLE_CHUNK_BYTES * 2 + 1);
    const frames = buildWaveformDump({ half: 'lower', audio8: audio });
    expect(frames.length).toBe(3);
  });

  it('all frames are well-formed SysEx and start with cmd 0x0C', () => {
    const audio = new Uint8Array(700).fill(0xaa);
    const frames = buildWaveformDump({ half: 'upper', audio8: audio });
    for (const f of frames) {
      expect(f[0]).toBe(SYSEX_START);
      expect(f[f.length - 1]).toBe(SYSEX_END);
      expect(f[3]).toBe(CMD.WAVESAMPLE_ABS_DATA);
      // N bit set in first address byte for upper
      expect(f[4]! & ABS_N_BIT_UPPER).toBe(ABS_N_BIT_UPPER);
    }
  });
});

// ---------------------------------------------------------------------------
// concatFrames
// ---------------------------------------------------------------------------

describe('concatFrames', () => {
  it('joins all frames into one buffer with their lengths preserved', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const out = concatFrames([a, b]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Ack / Nak detection
// ---------------------------------------------------------------------------

describe('isWavesampleAck / isWavesampleNak', () => {
  it('matches a canonical 5-byte ACK', () => {
    expect(
      isWavesampleAck([
        SYSEX_START,
        ENSONIQ_ID,
        MIRAGE_ID,
        CMD.WAVESAMPLE_ACK,
        SYSEX_END,
      ])
    ).toBe(true);
  });

  it('matches a canonical 5-byte NAK', () => {
    expect(
      isWavesampleNak([
        SYSEX_START,
        ENSONIQ_ID,
        MIRAGE_ID,
        CMD.WAVESAMPLE_NAK,
        SYSEX_END,
      ])
    ).toBe(true);
  });

  it('rejects mismatched commands', () => {
    expect(
      isWavesampleAck([
        SYSEX_START,
        ENSONIQ_ID,
        MIRAGE_ID,
        CMD.WAVESAMPLE_NAK,
        SYSEX_END,
      ])
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildKeypress
// ---------------------------------------------------------------------------

describe('buildKeypress', () => {
  it('frames a single keypress with 0x7F end-of-command marker', () => {
    const msg = buildKeypress([0x0c]); // PARAM key
    expect(Array.from(msg)).toEqual([
      SYSEX_START,
      ENSONIQ_ID,
      MIRAGE_ID,
      CMD.KEYPRESS,
      0x0c,
      0x7f,
      SYSEX_END,
    ]);
  });

  it('accepts up to 5 keys', () => {
    const msg = buildKeypress([0x0c, 0x09, 0x01, 0x0d, 0x0a]);
    // F0 0F 01 01 (4) + 5 keys + 7F + F7 = 11 bytes
    expect(msg.length).toBe(11);
    expect(msg[msg.length - 2]).toBe(0x7f);
  });

  it('rejects 0 or > 5 keys', () => {
    expect(() => buildKeypress([])).toThrow();
    expect(() => buildKeypress([1, 2, 3, 4, 5, 6])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildWavesampleDump (cmd 0x06)
// ---------------------------------------------------------------------------

describe('buildWavesampleDump', () => {
  it('frames page-count + nybble data + checksum', () => {
    // 1 page = 256 B of 0x00 (chosen so checksum math is easy).
    const audio = new Uint8Array(256);
    const msg = buildWavesampleDump({ audio8: audio });
    expect(msg[0]).toBe(SYSEX_START);
    expect(msg[3]).toBe(CMD.WAVESAMPLE_DUMP_DATA);
    // Page count = 1, encoded as LS nyb then MS nyb.
    expect(msg[4]).toBe(0x01);
    expect(msg[5]).toBe(0x00);
    // 256 B × 2 nybbles = 512 wire bytes of data, all zero.
    // Total: 4 header + 2 page-count + 512 data + 1 checksum + 1 F7 = 520
    expect(msg.length).toBe(520);
    // Checksum = (1 + 0 + all-zero data) & 0x7F = 1
    expect(msg[msg.length - 2]).toBe(1);
    expect(msg[msg.length - 1]).toBe(SYSEX_END);
  });

  it('rejects non-page-multiple audio', () => {
    expect(() => buildWavesampleDump({ audio8: new Uint8Array(100) })).toThrow(
      /multiple of 256/
    );
  });
});

// ---------------------------------------------------------------------------
// buildWavesampleParam (cmd 0x0E)
// ---------------------------------------------------------------------------

describe('buildWavesampleParam', () => {
  it('encodes lower-half wavesample 1 param 0 value 0', () => {
    const msg = buildWavesampleParam({
      half: 'lower',
      wavesample: 1,
      param: 0,
      value: 0,
    });
    // F0 0F 01 0E | 00 (N=0, ws=0) | 00 (param) | 00 (val LS) | 00 (val MS) | F7
    expect(Array.from(msg)).toEqual([
      SYSEX_START,
      ENSONIQ_ID,
      MIRAGE_ID,
      0x0e,
      0x00,
      0x00,
      0x00,
      0x00,
      SYSEX_END,
    ]);
  });

  it('sets N bit (0x08) for upper half and 1-based wavesample numbering', () => {
    const msg = buildWavesampleParam({
      half: 'upper',
      wavesample: 8, // wire value 7
      param: 0x35,
      value: 0xab,
    });
    expect(msg[4]).toBe(0x08 | 0x07); // 0x0F
    expect(msg[5]).toBe(0x35);
    expect(msg[6]).toBe(0x0b); // value LS nyb
    expect(msg[7]).toBe(0x0a); // value MS nyb
  });

  it('rejects out-of-range inputs', () => {
    expect(() =>
      buildWavesampleParam({ half: 'lower', wavesample: 0, param: 0, value: 0 })
    ).toThrow();
    expect(() =>
      buildWavesampleParam({ half: 'lower', wavesample: 9, param: 0, value: 0 })
    ).toThrow();
    expect(() =>
      buildWavesampleParam({
        half: 'lower',
        wavesample: 1,
        param: 200,
        value: 0,
      })
    ).toThrow();
    expect(() =>
      buildWavesampleParam({
        half: 'lower',
        wavesample: 1,
        param: 0,
        value: 256,
      })
    ).toThrow();
  });
});
