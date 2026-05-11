/**
 * MASOS / Mirage presence probe.
 *
 * Strategy: send a "select param N, request VALUE" simulated-keypress SysEx
 * (cmd 0x01) and listen for the matching VALUE-return (cmd 0x0D). This is
 * the most reliable round-trip we've found:
 *   - cmd 0x01 (keypress) is well-attested in the ASG MASOS manual and the
 *     working python `mirage` project.
 *   - param [91] = External Computer Port Enable is also the gate that
 *     must be 1 for the Mirage to originate ANY SysEx, so a successful
 *     read of [91] simultaneously confirms the gate is open.
 *   - Reply is a tight 9-byte cmd-0x0D message: easy to validate.
 *
 * What the reply tells us:
 *   - Any 0xF0 reply at all: Mirage reachable, MRCC routing OK.
 *   - F0 0F 01 0D ... F7 (length 9): canonical VALUE-return, MASOS confirmed.
 *   - Value byte: should be 1 after `mirage init`; if 0, the [91] gate is
 *     closed and most other SysEx work won't function until it's flipped.
 *   - No reply within timeout: powered off / wrong cable (must be Mirage
 *     MIDI OUT, not THRU) / MRCC not routing Mirage\u2192host on this port /
 *     stock OS V3.2 (keypress command is a MASOS-only addition).
 */

import { ENSONIQ_ID, MIRAGE_ID, SYSEX_END, SYSEX_START } from './constants.js';
import { MirageLink } from './midi.js';

// Front-panel keypress byte codes (MASOS manual \u00a73.3).
const KEY_PARAM = 0x0c;
const KEY_VALUE = 0x0d;
const CMD_KEYPRESS = 0x01;
const CMD_VALUE_RETURN = 0x0d;
const KEYPRESS_END = 0x7f;

export interface ProbeResult {
  /** True iff a Mirage VALUE-return reply arrived in time. */
  ok: boolean;
  outPort: string;
  inPort: string;
  /** Raw bytes of the reply, if any. */
  reply?: Uint8Array;
  /** Decoded value (0..255) if reply parses. */
  paramValue?: number;
  /** Decoded summary. */
  detail: string;
}

/** Build a "select param N, press VALUE" simulated-keypress SysEx frame. */
export function buildParamReadRequest(param: number): Uint8Array {
  if (!Number.isInteger(param) || param < 0 || param > 99) {
    throw new Error(`param ${param} out of range 0..99`);
  }
  const tens = Math.floor(param / 10);
  const ones = param % 10;
  return new Uint8Array([
    SYSEX_START,
    ENSONIQ_ID,
    MIRAGE_ID,
    CMD_KEYPRESS,
    KEY_PARAM,
    tens,
    ones,
    KEY_VALUE,
    KEYPRESS_END,
    SYSEX_END,
  ]);
}

/** Is this reply plausibly a Mirage VALUE-return? */
export function isMirageValueReturn(bytes: Uint8Array): boolean {
  return (
    bytes.length === 9 &&
    bytes[0] === SYSEX_START &&
    bytes[1] === ENSONIQ_ID &&
    bytes[2] === MIRAGE_ID &&
    bytes[3] === CMD_VALUE_RETURN &&
    bytes[8] === SYSEX_END
  );
}

export async function probeMirage(
  opts: {
    port?: string;
    /** Which parameter to read. Default 91 (External Computer Port Enable). */
    param?: number;
    timeoutMs?: number;
  } = {}
): Promise<ProbeResult> {
  const param = opts.param ?? 91;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const link = await MirageLink.open({ outPort: opts.port });
  try {
    const replyPromise = link.awaitSysex({
      predicate: isMirageValueReturn,
      timeoutMs,
    });
    link.sendSysex(buildParamReadRequest(param));

    let reply: Uint8Array | undefined;
    try {
      reply = await replyPromise;
    } catch {
      return {
        ok: false,
        outPort: link.outName,
        inPort: link.inName,
        detail:
          `No Mirage VALUE-return on "${link.inName}" within ${timeoutMs} ms. ` +
          `Possible causes: powered off, wrong cable (must be Mirage MIDI OUT), ` +
          `MRCC not routing Mirage\u2192host on this port, on stock OS V3.2 ` +
          `(MASOS required), or param [91]=0 blocking outbound SysEx.`,
      };
    }

    // Decode: F0 0F 01 0D <prog> <param> <v_lo> <v_hi> F7
    // Value nybbles: low first, MS clear.
    const vLo = reply[6]! & 0x0f;
    const vHi = reply[7]! & 0x0f;
    const value = (vHi << 4) | vLo;
    const replyParam = reply[5]!;
    return {
      ok: true,
      outPort: link.outName,
      inPort: link.inName,
      reply,
      paramValue: value,
      detail:
        `Mirage replied: param=${replyParam} value=${value}. ` +
        `Bidirectional MASOS SysEx confirmed.`,
    };
  } finally {
    link.close();
  }
}
