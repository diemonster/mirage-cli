import JZZ from 'jzz';
import { DEFAULT_PORT_NAME, PORT_AUTODETECT_REGEX } from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MidiPortInfo {
  name: string;
  manufacturer?: string;
}

export interface MidiSendOptions {
  /** Exact MIDI port name. Overrides env + autodetect. */
  port?: string;
  /** Delay between SysEx frames, in ms. Conservative default. */
  interPacketDelayMs?: number;
  /** Optional progress callback (1-based frame number, total). */
  onProgress?: (sent: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Port enumeration & resolution
// ---------------------------------------------------------------------------

export async function listOutputPorts(): Promise<MidiPortInfo[]> {
  const engine = await JZZ();
  const info = engine.info();
  return (info.outputs ?? []).map(
    (p: { name: string; manufacturer?: string }) => ({
      name: p.name,
      manufacturer: p.manufacturer,
    })
  );
}

export async function listInputPorts(): Promise<MidiPortInfo[]> {
  const engine = await JZZ();
  const info = engine.info();
  return (info.inputs ?? []).map(
    (p: { name: string; manufacturer?: string }) => ({
      name: p.name,
      manufacturer: p.manufacturer,
    })
  );
}

function pickPort(
  ports: MidiPortInfo[],
  explicit: string | undefined,
  env: string | undefined
): string | undefined {
  if (explicit) return explicit;
  if (env) return env;
  const exact = ports.find((p) => p.name === DEFAULT_PORT_NAME);
  if (exact) return exact.name;
  const fuzzy = ports.find((p) => PORT_AUTODETECT_REGEX.test(p.name));
  return fuzzy?.name;
}

export async function resolvePortName(explicit?: string): Promise<string> {
  const ports = await listOutputPorts();
  const picked = pickPort(ports, explicit, process.env.MIRAGE_PORT);
  if (!picked) {
    throw new Error(
      `No MIDI output port found. Available ports: ${
        ports.map((p) => `"${p.name}"`).join(', ') || '(none)'
      }. Set --port or $MIRAGE_PORT.`
    );
  }
  return picked;
}

export async function resolveInputPortName(explicit?: string): Promise<string> {
  const ports = await listInputPorts();
  const picked = pickPort(ports, explicit, process.env.MIRAGE_PORT);
  if (!picked) {
    throw new Error(
      `No MIDI input port found. Available ports: ${
        ports.map((p) => `"${p.name}"`).join(', ') || '(none)'
      }. Set --port or $MIRAGE_PORT.`
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Bidirectional link
// ---------------------------------------------------------------------------

interface JzzPort {
  send(bytes: Uint8Array | number[]): void;
  close(): void;
}

interface JzzInPort extends JzzPort {
  connect(cb: (msg: ArrayLike<number>) => void): void;
}

type SysexListener = (bytes: Uint8Array) => void;

/**
 * Open both directions to/from the Mirage. MRCC routes both directions
 * through one logical port name; most USB-MIDI interfaces do the same.
 */
export class MirageLink {
  private readonly listeners = new Set<SysexListener>();

  private constructor(
    private readonly out: JzzPort,
    private readonly inp: JzzInPort,
    public readonly outName: string,
    public readonly inName: string
  ) {}

  static async open(
    opts: { outPort?: string; inPort?: string } = {}
  ): Promise<MirageLink> {
    const outName = await resolvePortName(opts.outPort);
    const inName = await resolveInputPortName(opts.inPort ?? opts.outPort);
    const engine = await JZZ();
    const out = (await engine.openMidiOut(outName)) as JzzPort;
    const inp = (await engine.openMidiIn(inName)) as JzzInPort;

    const link = new MirageLink(out, inp, outName, inName);
    inp.connect((msg) => {
      // JZZ delivers a SysEx as a single complete message starting with F0.
      if (msg.length === 0 || msg[0] !== 0xf0) return;
      const buf = new Uint8Array(msg.length);
      for (let i = 0; i < msg.length; i++) buf[i] = msg[i]! & 0xff;
      for (const cb of link.listeners) cb(buf);
    });
    return link;
  }

  /** Send one well-formed SysEx frame. */
  sendSysex(frame: Uint8Array): void {
    if (frame[0] !== 0xf0 || frame[frame.length - 1] !== 0xf7) {
      throw new Error('Not a well-formed SysEx frame (missing F0/F7).');
    }
    // JZZ wants a plain number[] for SysEx, not a typed array.
    this.out.send(Array.from(frame));
  }

  /** Wait for the next SysEx matching the predicate, or time out. */
  awaitSysex(opts: {
    predicate?: (bytes: Uint8Array) => boolean;
    timeoutMs: number;
  }): Promise<Uint8Array> {
    const { predicate, timeoutMs } = opts;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(
          new Error(`Timed out after ${timeoutMs} ms waiting for SysEx reply.`)
        );
      }, timeoutMs);
      const listener: SysexListener = (bytes) => {
        if (predicate && !predicate(bytes)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(bytes);
      };
      this.listeners.add(listener);
    });
  }

  /** Send any MIDI message (note on/off, controllers) on the output port. */
  send(bytes: ArrayLike<number>): void {
    this.out.send(Array.from(bytes));
  }

  /**
   * Collect every SysEx frame matching `predicate` until `idleMs` pass with
   * no further match, or `maxMs` overall. Resolves with the frames in order.
   */
  collectSysex(opts: {
    predicate: (bytes: Uint8Array) => boolean;
    idleMs: number;
    maxMs: number;
  }): Promise<Uint8Array[]> {
    return new Promise((resolve) => {
      const frames: Uint8Array[] = [];
      let idle: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (idle) clearTimeout(idle);
        clearTimeout(hard);
        this.listeners.delete(listener);
        resolve(frames);
      };
      const hard = setTimeout(finish, opts.maxMs);
      const listener = (bytes: Uint8Array) => {
        if (!opts.predicate(bytes)) return;
        frames.push(bytes);
        if (idle) clearTimeout(idle);
        idle = setTimeout(finish, opts.idleMs);
      };
      this.listeners.add(listener);
      idle = setTimeout(finish, opts.idleMs);
    });
  }

  close(): void {
    try {
      this.out.close();
    } catch {
      /* ignore */
    }
    try {
      this.inp.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// ACK-gated frame sender (bidirectional)
// ---------------------------------------------------------------------------

export interface AckGatedSendOptions {
  port?: string;
  /** Predicate that matches the Mirage's ACK reply. */
  isAck: (bytes: Uint8Array) => boolean;
  /** Optional predicate matching the Mirage's NAK reply. */
  isNak?: (bytes: Uint8Array) => boolean;
  /** How long to wait for ACK after each frame. */
  ackTimeoutMs?: number;
  /** Minimum delay between frames even when ACK is fast. */
  interPacketDelayMs?: number;
  onProgress?: (sent: number, total: number) => void;
}

/**
 * Send frames one at a time, awaiting ACK after each. Throws on NAK or
 * ACK timeout. Use this for wavesample uploads where any silent
 * checksum failure leaves a half-written sample in RAM.
 */
export async function sendSysexFramesGated(
  frames: Uint8Array[],
  opts: AckGatedSendOptions
): Promise<void> {
  const ackTimeoutMs = opts.ackTimeoutMs ?? 2000;
  const delay = opts.interPacketDelayMs ?? 25;
  const link = await MirageLink.open({ outPort: opts.port });
  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      if (f[0] !== 0xf0 || f[f.length - 1] !== 0xf7) {
        throw new Error(`Frame #${i} is malformed.`);
      }
      const replyPromise = link.awaitSysex({
        predicate: (b) => opts.isAck(b) || (opts.isNak?.(b) ?? false),
        timeoutMs: ackTimeoutMs,
      });
      link.sendSysex(f);

      let reply: Uint8Array;
      try {
        reply = await replyPromise;
      } catch {
        throw new Error(
          `Frame ${i + 1}/${frames.length}: no ACK from Mirage within ${ackTimeoutMs} ms.`
        );
      }
      if (opts.isNak?.(reply)) {
        throw new Error(
          `Frame ${i + 1}/${frames.length}: Mirage NAK (checksum error).`
        );
      }
      opts.onProgress?.(i + 1, frames.length);
      if (delay > 0 && i < frames.length - 1) await sleep(delay);
    }
  } finally {
    link.close();
  }
}

// ---------------------------------------------------------------------------
// Convenience: one-shot output-only send (used by the dump path)
// ---------------------------------------------------------------------------

export async function sendSysexFrames(
  frames: Uint8Array[],
  opts: MidiSendOptions = {}
): Promise<void> {
  const delay = opts.interPacketDelayMs ?? 20;
  const portName = await resolvePortName(opts.port);
  const engine = await JZZ();
  const out = (await engine.openMidiOut(portName)) as JzzPort;
  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      if (f[0] !== 0xf0 || f[f.length - 1] !== 0xf7) {
        throw new Error(
          `Frame #${i} is not a well-formed SysEx message (missing F0/F7).`
        );
      }
      out.send(Array.from(f));
      opts.onProgress?.(i + 1, frames.length);
      if (delay > 0 && i < frames.length - 1) {
        await sleep(delay);
      }
    }
    await sleep(50);
  } finally {
    try {
      out.close();
    } catch {
      /* ignore */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
