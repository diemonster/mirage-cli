/**
 * Wavesample RAM readback (MASOS cmd 0x0B request, cmd 0x0C replies) as a
 * transport-independent transaction, so it can be tested against a simulated
 * MIDI link.
 *
 * Hardware-verified protocol (2026-10-30, DSK-8 with MASOS v2): the Mirage
 * answers one 0x0C frame per request, only for ranges of at most 16 bytes,
 * and the end address on the wire is exclusive (start + length, modulo
 * 0x10000). Those facts are unchanged here; this module adds what the
 * transport can do to a reply on the way back: lose it, delay it, repeat
 * it, corrupt it, or deliver one that belongs to an earlier request.
 */
import { SLOT_CAPACITY_BYTES, type Half } from './constants.js';
import {
  buildWavesampleAbsoluteRequest,
  isWavesampleAbsoluteData,
  parseWavesampleAbsoluteData,
  type WavesampleAbsoluteData,
} from './sysex.js';

/**
 * The two calls the transaction needs from a MIDI link. `MirageLink` satisfies
 * it. An expired wait rejects with an Error whose message says "timed out";
 * any other rejection is a transport failure and ends the transfer.
 */
export interface ReadbackTransport {
  sendSysex(frame: Uint8Array): void;
  awaitSysex(opts: { predicate?: (bytes: Uint8Array) => boolean; timeoutMs: number }): Promise<Uint8Array>;
}

export const MAX_REQUEST_BYTES = 16;

export interface ReadbackOptions {
  half: Half;
  /** Inclusive start address within the half's 64 KB. */
  startAddress: number;
  /** Bytes to read; `startAddress + length` must not exceed 64 KB. */
  length: number;
  /** Bytes per request, 1..16. */
  chunkBytes?: number;
  /** How long one request may wait for its matching reply. */
  timeoutMs: number;
  /** Requests sent for one chunk before the transfer is abandoned. */
  maxAttempts?: number;
  /** Called after each accepted chunk with the bytes covered so far. */
  onProgress?: (covered: number, total: number) => void;
}

/** Why an attempt ended without an accepted reply. */
export type RejectReason = 'timeout' | 'checksum' | 'length';

export interface ReadbackStats {
  requests: number;
  /** Requests sent beyond the first for some chunk. */
  retries: number;
  /** Attempts that ended without an accepted reply, by reason. */
  rejected: Record<RejectReason, number>;
  /** Well-formed 0x0C frames that named another request; skipped without costing an attempt. */
  ignored: number;
  /** 0x0C frames that could not be decoded at all; skipped without costing an attempt. */
  undecodable: number;
}

export interface ReadbackResult {
  image: Uint8Array;
  stats: ReadbackStats;
}

export class ReadbackError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly stats: ReadbackStats
  ) {
    super(message);
    this.name = 'ReadbackError';
  }
}

export interface ChunkRequest {
  half: Half;
  startAddress: number;
  /** Exclusive end, as sent on the wire: `(startAddress + length) & 0xffff`. */
  endAddress: number;
}

/** Bytes a request covers; the wrapped end of the top chunk (0x0000) counts as 0x10000. */
export function chunkLength(request: Pick<ChunkRequest, 'startAddress' | 'endAddress'>): number {
  return (request.endAddress - request.startAddress) & 0xffff;
}

/** Argument rules shared by the CLI (as argument errors) and the transaction. */
export function validateReadbackRange(startAddress: number, length: number, chunkBytes: number, timeoutMs: number): void {
  if (!Number.isInteger(startAddress) || !Number.isInteger(length) || startAddress < 0 || length < 1) {
    throw new Error('start address and length must be non-negative integers, length at least 1');
  }
  if (startAddress + length > SLOT_CAPACITY_BYTES) {
    throw new Error(`a read of ${length} B at 0x${startAddress.toString(16)} would leave the 64 KB half`);
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_REQUEST_BYTES) {
    throw new Error(`chunk size must be 1..${MAX_REQUEST_BYTES} bytes`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeout must be a positive number of milliseconds');
  }
}

/** The chunks a readback is made of, in order; the last one may be shorter. */
export function planChunks(half: Half, startAddress: number, length: number, chunkBytes: number): ChunkRequest[] {
  validateReadbackRange(startAddress, length, chunkBytes, 1);
  const chunks: ChunkRequest[] = [];
  for (let offset = 0; offset < length; offset += chunkBytes) {
    const n = Math.min(chunkBytes, length - offset);
    const start = startAddress + offset;
    chunks.push({ half, startAddress: start, endAddress: (start + n) & 0xffff });
  }
  return chunks;
}

/**
 * Does a 0x0C frame's header name this request? Half and start must match.
 * The hardware-verified fact is that the request's end is exclusive; which
 * convention the Mirage uses when it echoes the end in its reply has not been
 * recorded, so both the exclusive end and the inclusive one (end - 1) are
 * accepted here, and the byte count check in `judgeReply` is the integrity
 * guard either way.
 */
export function replyMatches(request: ChunkRequest, reply: WavesampleAbsoluteData): boolean {
  if (reply.half !== request.half || reply.startAddress !== request.startAddress) return false;
  const inclusiveEnd = (request.endAddress - 1) & 0xffff;
  return reply.endAddress === request.endAddress || reply.endAddress === inclusiveEnd;
}

/** Judge a header-matched reply: the data must be intact and exactly the requested length. */
export function judgeReply(request: ChunkRequest, reply: WavesampleAbsoluteData): RejectReason | 'accepted' {
  if (!reply.checksumOk) return 'checksum';
  if (reply.audio8.length !== chunkLength(request)) return 'length';
  return 'accepted';
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out/i.test(err.message);
}

function emptyStats(): ReadbackStats {
  return { requests: 0, retries: 0, rejected: { timeout: 0, checksum: 0, length: 0 }, ignored: 0, undecodable: 0 };
}

/**
 * Read `length` bytes of one half's wavesample RAM. Every chunk is requested
 * until a frame arrives whose header names that request and whose data is
 * intact; frames for other requests are ignored without costing an attempt.
 * Throws `ReadbackError` rather than returning a partial image.
 */
export async function readWavesampleRam(transport: ReadbackTransport, opts: ReadbackOptions): Promise<ReadbackResult> {
  const chunkBytes = opts.chunkBytes ?? MAX_REQUEST_BYTES;
  const maxAttempts = opts.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be at least 1');
  validateReadbackRange(opts.startAddress, opts.length, chunkBytes, opts.timeoutMs);
  const chunks = planChunks(opts.half, opts.startAddress, opts.length, chunkBytes);
  const image = new Uint8Array(opts.length);
  const stats = emptyStats();
  let covered = 0;
  for (const chunk of chunks) {
    const data = await readChunk(transport, chunk, opts.timeoutMs, maxAttempts, stats, covered);
    image.set(data, covered);
    covered += data.length;
    opts.onProgress?.(covered, opts.length);
  }
  return { image, stats };
}

async function readChunk(
  transport: ReadbackTransport,
  chunk: ChunkRequest,
  timeoutMs: number,
  maxAttempts: number,
  stats: ReadbackStats,
  offset: number
): Promise<Uint8Array> {
  const request = buildWavesampleAbsoluteRequest(chunk);
  let last: RejectReason = 'timeout';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Frames that are not this request's answer are skipped inside the wait,
    // so a late duplicate from an earlier chunk cannot be taken for this one.
    const predicate = (bytes: Uint8Array): boolean => {
      if (!isWavesampleAbsoluteData(bytes)) return false;
      try {
        const matched = replyMatches(chunk, parseWavesampleAbsoluteData(bytes));
        if (!matched) stats.ignored++;
        return matched;
      } catch {
        stats.undecodable++;
        return false;
      }
    };
    const reply = transport.awaitSysex({ predicate, timeoutMs });
    stats.requests++;
    if (attempt > 0) stats.retries++;
    try {
      transport.sendSysex(request);
    } catch (err) {
      // The armed wait would otherwise reject later with nobody listening.
      reply.catch(() => undefined);
      throw err;
    }
    let frame: Uint8Array;
    try {
      frame = await reply;
    } catch (err) {
      if (!isTimeout(err)) throw err;
      stats.rejected.timeout++;
      last = 'timeout';
      continue;
    }
    const data = parseWavesampleAbsoluteData(frame);
    const verdict = judgeReply(chunk, data);
    if (verdict === 'accepted') return data.audio8;
    stats.rejected[verdict]++;
    last = verdict;
  }
  throw new ReadbackError(
    `no valid reply for ${chunk.half} 0x${chunk.startAddress.toString(16)}..0x${chunk.endAddress.toString(16)} ` +
      `after ${maxAttempts} attempt(s) (last: ${last})`,
    offset,
    stats
  );
}
