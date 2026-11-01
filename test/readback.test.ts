import { describe, expect, it } from 'vitest';

import { SYSEX_END } from '../src/constants.js';
import {
  ReadbackError,
  chunkLength,
  judgeReply,
  planChunks,
  readWavesampleRam,
  replyMatches,
  validateReadbackRange,
  type ReadbackTransport,
} from '../src/readback.js';
import {
  buildWavesampleAbsolute,
  buildWavesampleAbsoluteRequest,
  encodeNybbles,
  parseWavesampleAbsoluteData,
} from '../src/sysex.js';

// ---------------------------------------------------------------------------
// A simulated Mirage on a simulated MIDI link. The image is the RAM; a script
// decides, per request, what comes back: nothing, the right frame, a corrupted
// one, a stale one, a duplicate, a frame of the wrong length, or garbage.
// Delivery is synchronous and deterministic; a "missing" reply rejects the
// pending wait the way MirageLink's timer would.
// ---------------------------------------------------------------------------

type Behaviour =
  | 'reply'
  | 'missing'
  | 'corrupt'
  | 'short'
  | 'long'
  | 'wrong-half'
  | 'wrong-start'
  | 'stale-then-reply'
  | 'duplicate-reply'
  | 'garbage-then-reply'
  | 'delayed-reply';

interface Pending {
  predicate?: (bytes: Uint8Array) => boolean;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

class SimulatedMirage implements ReadbackTransport {
  readonly sent: Uint8Array[] = [];
  private pending: Pending | undefined;
  private lastReply: Uint8Array | undefined;
  private requestIndex = 0;

  constructor(
    private readonly ram: Record<'upper' | 'lower', Uint8Array>,
    private readonly script: (requestIndex: number) => Behaviour
  ) {}

  awaitSysex(opts: { predicate?: (bytes: Uint8Array) => boolean; timeoutMs: number }): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.pending = { predicate: opts.predicate, resolve, reject };
    });
  }

  sendSysex(frame: Uint8Array): void {
    this.sent.push(frame);
    const request = parseWavesampleAbsoluteData(requestAsData(frame));
    const behaviour = this.script(this.requestIndex++);
    const length = (request.endAddress - request.startAddress) & 0xffff;
    const audio = this.ram[request.half].subarray(request.startAddress, request.startAddress + length);
    const good = buildWavesampleAbsolute({ half: request.half, startAddress: request.startAddress, audio8: audio });
    switch (behaviour) {
      case 'reply':
        this.deliver(good);
        break;
      case 'missing':
        break;
      case 'corrupt': {
        const bad = good.slice();
        bad[12] = (bad[12]! + 1) & 0x0f; // one data nybble altered; checksum now stale
        this.deliver(bad);
        break;
      }
      case 'short':
        this.deliver(frameWithHeaderOf(good, length > 1 ? audio.subarray(0, length - 1) : this.ram[request.half].subarray(request.startAddress, request.startAddress + 2)));
        break;
      case 'long':
        this.deliver(frameWithHeaderOf(good, this.ram[request.half].subarray(request.startAddress, request.startAddress + length + 1)));
        break;
      case 'wrong-half':
        this.deliver(buildWavesampleAbsolute({ half: request.half === 'upper' ? 'lower' : 'upper', startAddress: request.startAddress, audio8: audio }));
        break;
      case 'wrong-start':
        this.deliver(buildWavesampleAbsolute({ half: request.half, startAddress: (request.startAddress + 16) & 0xffff, audio8: audio }));
        break;
      case 'stale-then-reply':
        if (this.lastReply) this.deliver(this.lastReply);
        this.deliver(good);
        break;
      case 'duplicate-reply':
        this.deliver(good);
        this.deliver(good);
        break;
      case 'garbage-then-reply': {
        // A 0x0C frame with an odd nybble count: framed correctly, but it cannot be decoded.
        const garbage = good.slice(0, 13);
        garbage[12] = 0;
        this.deliver(new Uint8Array([...garbage, 0, SYSEX_END]));
        this.deliver(good);
        break;
      }
      case 'delayed-reply':
        queueMicrotask(() => this.deliver(good));
        break;
    }
    // A wait that nothing answered times out, as the real link's timer would.
    if (behaviour !== 'delayed-reply') this.timeout();
    if (behaviour !== 'missing' && behaviour !== 'wrong-half' && behaviour !== 'wrong-start') this.lastReply = good;
  }

  private deliver(frame: Uint8Array): void {
    const p = this.pending;
    if (!p) return;
    if (p.predicate && !p.predicate(frame)) return;
    this.pending = undefined;
    p.resolve(frame);
  }

  private timeout(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    p.reject(new Error('Timed out waiting for SysEx reply.'));
  }
}

/** A 0x0B request carries the same eight address nybbles as a 0x0C frame; reuse the parser. */
function requestAsData(request: Uint8Array): Uint8Array {
  const out = new Uint8Array(14);
  out.set(request.subarray(0, 12));
  out[3] = 0x0c;
  out[12] = 0;
  out[13] = SYSEX_END;
  return out;
}

/** A frame whose header is `good`'s, whose data is `audio` (another length), with a valid checksum. */
function frameWithHeaderOf(good: Uint8Array, audio: Uint8Array): Uint8Array {
  const header = good.subarray(0, 12);
  const { nybbles, sum } = encodeNybbles(audio);
  const addrSum = Array.from(header.subarray(4, 12), (b) => b & 0x0f).reduce((a, b) => a + b, 0);
  return new Uint8Array([...header, ...nybbles, (addrSum + sum) & 0x7f, SYSEX_END]);
}

function ramOf(seed: number): Record<'upper' | 'lower', Uint8Array> {
  const make = (s: number) => Uint8Array.from({ length: 0x10000 }, (_, i) => (i * 7 + s) & 0xff);
  return { lower: make(seed), upper: make(seed + 101) };
}

describe('planChunks', () => {
  it('splits a range into 16-byte requests with exclusive ends and a short tail', () => {
    const chunks = planChunks('lower', 0x1000, 40, 16);
    expect(chunks.map((c) => [c.startAddress, c.endAddress, chunkLength(c)])).toEqual([
      [0x1000, 0x1010, 16],
      [0x1010, 0x1020, 16],
      [0x1020, 0x1028, 8],
    ]);
  });

  it('wraps the exclusive end of the last chunk of the half to 0x0000 and still counts 16 bytes', () => {
    const chunks = planChunks('upper', 0xffe0, 32, 16);
    expect(chunks[1]).toEqual({ half: 'upper', startAddress: 0xfff0, endAddress: 0x0000 });
    expect(chunkLength(chunks[1]!)).toBe(16);
  });

  it('rejects a non-positive or non-finite timeout', () => {
    expect(() => validateReadbackRange(0, 16, 16, 0)).toThrow(/timeout/);
    expect(() => validateReadbackRange(0, 16, 16, Number.NaN)).toThrow(/timeout/);
  });

  it('refuses ranges that leave the half and chunks above 16 bytes', () => {
    expect(() => planChunks('lower', 0xfff0, 17, 16)).toThrow(/64 KB/);
    expect(() => planChunks('lower', 0, 16, 17)).toThrow(/1\.\.16/);
    expect(() => planChunks('lower', 0, 0, 16)).toThrow();
  });
});

describe('replyMatches / judgeReply', () => {
  const request = { half: 'lower' as const, startAddress: 0x0100, endAddress: 0x0110 };
  const reply = parseWavesampleAbsoluteData(
    buildWavesampleAbsolute({ half: 'lower', startAddress: 0x0100, audio8: new Uint8Array(16).fill(3) })
  );

  it('accepts the frame that names the request', () => {
    expect(replyMatches(request, reply)).toBe(true);
    expect(judgeReply(request, reply)).toBe('accepted');
  });

  it('accepts an inclusive echo of the end address, since the reply convention is unrecorded', () => {
    expect(replyMatches(request, { ...reply, endAddress: 0x010f })).toBe(true);
    const top = { half: 'lower' as const, startAddress: 0xfff0, endAddress: 0x0000 };
    expect(replyMatches(top, { ...reply, startAddress: 0xfff0, endAddress: 0xffff })).toBe(true);
  });

  it('rejects another half, another start, another end and a bad checksum', () => {
    expect(replyMatches(request, { ...reply, half: 'upper' })).toBe(false);
    expect(replyMatches(request, { ...reply, startAddress: 0x0101 })).toBe(false);
    expect(replyMatches(request, { ...reply, endAddress: 0x0111 })).toBe(false);
    expect(replyMatches(request, { ...reply, endAddress: 0x010e })).toBe(false);
    expect(judgeReply(request, { ...reply, checksumOk: false })).toBe('checksum');
    expect(judgeReply(request, { ...reply, audio8: reply.audio8.subarray(0, 15) })).toBe('length');
  });

  it('matches the wire request built from the same chunk', () => {
    const wire = parseWavesampleAbsoluteData(requestAsData(buildWavesampleAbsoluteRequest(request)));
    expect(replyMatches(request, wire)).toBe(true);
  });
});

describe('readWavesampleRam over a simulated link', () => {
  const ram = ramOf(5);

  it('reads an exact image with one request per chunk when every reply is good', async () => {
    const mirage = new SimulatedMirage(ram, () => 'reply');
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0x1234, length: 100, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0x1234, 0x1234 + 100));
    expect(stats.requests).toBe(7);
    expect(stats.retries).toBe(0);
    expect(stats.ignored).toBe(0);
  });

  it('reads the top of the half, whose last request wraps its end address to 0x0000', async () => {
    const mirage = new SimulatedMirage(ram, () => 'reply');
    const { image } = await readWavesampleRam(mirage, { half: 'upper', startAddress: 0xffd0, length: 48, timeoutMs: 10 });
    expect(image).toEqual(ram.upper.subarray(0xffd0, 0x10000));
    const last = parseWavesampleAbsoluteData(requestAsData(mirage.sent[2]!));
    expect([last.startAddress, last.endAddress]).toEqual([0xfff0, 0x0000]);
  });

  it('retries a missing reply and counts the timeout', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 1 ? 'missing' : 'reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0, length: 32, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0, 32));
    expect(stats.requests).toBe(3);
    expect(stats.retries).toBe(1);
    expect(stats.rejected.timeout).toBe(1);
  });

  it('refuses a corrupted reply, retries, and never writes its bytes', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'corrupt' : 'reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0x40, length: 16, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0x40, 0x50));
    expect(stats.rejected.checksum).toBe(1);
    expect(stats.retries).toBe(1);
  });

  it('refuses replies of the wrong length under a matching header', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'short' : i === 1 ? 'long' : 'reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0x80, length: 16, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0x80, 0x90));
    expect(stats.rejected.length).toBe(2);
    expect(stats.requests).toBe(3);
  });

  it('ignores a frame for another half or another address without spending an attempt', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'wrong-half' : i === 1 ? 'wrong-start' : 'reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0x200, length: 16, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0x200, 0x210));
    expect(stats.ignored).toBe(2);
    expect(stats.rejected.timeout).toBe(2);
    expect(stats.retries).toBe(2);
  });

  it('skips a stale duplicate of the previous chunk and takes the right frame', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'reply' : 'stale-then-reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 0x300, length: 48, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(0x300, 0x330));
    expect(stats.ignored).toBe(2);
    expect(stats.retries).toBe(0);
  });

  it('is not confused by a duplicated good reply, garbage before the reply, or a delayed reply', async () => {
    const script: Behaviour[] = ['duplicate-reply', 'garbage-then-reply', 'delayed-reply', 'reply'];
    const mirage = new SimulatedMirage(ram, (i) => script[i] ?? 'reply');
    const { image, stats } = await readWavesampleRam(mirage, { half: 'upper', startAddress: 0, length: 64, timeoutMs: 10 });
    expect(image).toEqual(ram.upper.subarray(0, 64));
    expect(stats.requests).toBe(4);
    expect(stats.undecodable).toBe(1);
    expect(stats.rejected.timeout).toBe(0);
  });

  it('rejects a wrong-length frame for a one-byte chunk too', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'short' : 'reply'));
    const { image, stats } = await readWavesampleRam(mirage, { half: 'lower', startAddress: 7, length: 1, chunkBytes: 1, timeoutMs: 10 });
    expect(image).toEqual(ram.lower.subarray(7, 8));
    expect(stats.rejected.length).toBe(1);
  });

  it('propagates a transport failure during the wait instead of retrying it as a timeout', async () => {
    const failing: ReadbackTransport = {
      sendSysex: () => undefined,
      awaitSysex: () => Promise.reject(new Error('MIDI input port closed')),
    };
    await expect(readWavesampleRam(failing, { half: 'lower', startAddress: 0, length: 16, timeoutMs: 10 })).rejects.toThrow(/port closed/);
  });

  it('does not leave an orphaned wait when the transport cannot send', async () => {
    const broken: ReadbackTransport = {
      sendSysex: () => { throw new Error('port closed'); },
      awaitSysex: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late timeout')), 1)),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(readWavesampleRam(broken, { half: 'lower', startAddress: 0, length: 1, timeoutMs: 1 })).rejects.toThrow(/port closed/);
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('fails with the offset and no image after the attempt budget, instead of a partial capture', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i < 2 ? 'reply' : i < 5 ? 'corrupt' : 'reply'));
    const run = readWavesampleRam(mirage, { half: 'lower', startAddress: 0, length: 64, timeoutMs: 10 });
    await expect(run).rejects.toBeInstanceOf(ReadbackError);
    await run.catch((err: ReadbackError) => {
      expect(err.offset).toBe(32);
      expect(err.stats.rejected.checksum).toBe(3);
      expect(err.message).toMatch(/0x20\.\.0x30/);
    });
    expect(mirage.sent.length).toBe(5);
  });

  it('honours a custom attempt budget and chunk size', async () => {
    const mirage = new SimulatedMirage(ram, (i) => (i === 0 ? 'missing' : 'reply'));
    await expect(
      readWavesampleRam(mirage, { half: 'lower', startAddress: 0, length: 8, chunkBytes: 4, timeoutMs: 10, maxAttempts: 1 })
    ).rejects.toThrow(/after 1 attempt/);
    const again = new SimulatedMirage(ram, () => 'reply');
    const { stats } = await readWavesampleRam(again, { half: 'lower', startAddress: 0, length: 8, chunkBytes: 4, timeoutMs: 10 });
    expect(stats.requests).toBe(2);
  });
});
