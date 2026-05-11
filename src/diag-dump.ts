/**
 * Wavesample-dump diagnostic.
 *
 * Sends a single tiny cmd 0x0C frame with the smallest possible payload
 * and prints the Mirage's raw reply. Optionally tries several checksum
 * and address-encoding variants so we can pin down which one the
 * hardware accepts.
 *
 * Usage:
 *   npx tsx src/diag-dump.ts                  # default variant
 *   npx tsx src/diag-dump.ts --variant N      # try variant N
 *   npx tsx src/diag-dump.ts --all            # try every variant
 *   npx tsx src/diag-dump.ts --addr 0x8000    # change start address
 */
import {
  ABS_N_BIT_UPPER,
  CMD,
  ENSONIQ_ID,
  MIRAGE_ID,
  SYSEX_END,
  SYSEX_START,
} from './constants.js';
import { MirageLink } from './midi.js';

interface Variant {
  name: string;
  build(start: number, audio: Uint8Array, isUpper: boolean): Uint8Array;
}

function addrNybs(addr: number) {
  const lo = addr & 0xff;
  const hi = (addr >> 8) & 0xff;
  return [lo & 0xf, (lo >> 4) & 0xf, hi & 0xf, (hi >> 4) & 0xf] as const;
}

function dataNybs(b: Uint8Array): { nyb: number[]; sum: number } {
  const out: number[] = [];
  let s = 0;
  for (const x of b) {
    const lo = x & 0xf;
    const hi = (x >> 4) & 0xf;
    out.push(lo, hi);
    s += lo + hi;
  }
  return { nyb: out, sum: s };
}

function assemble(
  header: number[],
  data: number[],
  checksum: number
): Uint8Array {
  return new Uint8Array([
    SYSEX_START,
    ENSONIQ_ID,
    MIRAGE_ID,
    CMD.WAVESAMPLE_ABS_DATA,
    ...header,
    ...data,
    checksum,
    SYSEX_END,
  ]);
}

const variants: Variant[] = [
  {
    name: 'V0: addr nybs (excl N) + data nybs, mod128',
    build(start, audio, isUpper) {
      const [sLs, sMs, sHls, sHms] = addrNybs(start);
      const end = start + audio.length - 1;
      const [eLs, eMs, eHls, eHms] = addrNybs(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      const header = [n | sLs, sMs, sHls, sHms, eLs, eMs, eHls, eHms];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = sLs + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = (addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
  {
    name: "V1: V0 but two's-complement checksum",
    build(start, audio, isUpper) {
      const [sLs, sMs, sHls, sHms] = addrNybs(start);
      const end = start + audio.length - 1;
      const [eLs, eMs, eHls, eHms] = addrNybs(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      const header = [n | sLs, sMs, sHls, sHms, eLs, eMs, eHls, eHms];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = sLs + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = -(addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
  {
    name: 'V2: include first byte (with N) in addr sum',
    build(start, audio, isUpper) {
      const [sLs, sMs, sHls, sHms] = addrNybs(start);
      const end = start + audio.length - 1;
      const [eLs, eMs, eHls, eHms] = addrNybs(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      const header = [n | sLs, sMs, sHls, sHms, eLs, eMs, eHls, eHms];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = (n | sLs) + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = (addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
  {
    name: 'V3: byte-order swapped (hi nyb of byte first)',
    build(start, audio, isUpper) {
      const swap = (a: number) => {
        const lo = a & 0xff;
        const hi = (a >> 8) & 0xff;
        return [(lo >> 4) & 0xf, lo & 0xf, (hi >> 4) & 0xf, hi & 0xf] as const;
      };
      const [sLs, sMs, sHls, sHms] = swap(start);
      const end = start + audio.length - 1;
      const [eLs, eMs, eHls, eHms] = swap(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      const header = [n | sLs, sMs, sHls, sHms, eLs, eMs, eHls, eHms];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = sLs + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = (addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
  {
    name: 'V4: addresses are HIGH-first (hi-byte before lo-byte)',
    build(start, audio, isUpper) {
      const [sLs, sMs, sHls, sHms] = addrNybs(start);
      const end = start + audio.length - 1;
      const [eLs, eMs, eHls, eHms] = addrNybs(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      // Reorder: high byte first, then low byte
      const header = [n | sHls, sHms, sLs, sMs, eHls, eHms, eLs, eMs];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = sLs + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = (addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
  {
    name: 'V5: end address = start + len (EXCLUSIVE)',
    build(start, audio, isUpper) {
      const [sLs, sMs, sHls, sHms] = addrNybs(start);
      const end = start + audio.length;
      const [eLs, eMs, eHls, eHms] = addrNybs(end);
      const n = isUpper ? ABS_N_BIT_UPPER : 0;
      const header = [n | sLs, sMs, sHls, sHms, eLs, eMs, eHls, eHms];
      const { nyb, sum } = dataNybs(audio);
      const addrSum = sLs + sMs + sHls + sHms + eLs + eMs + eHls + eHms;
      const cs = (addrSum + sum) & 0x7f;
      return assemble(header, nyb, cs);
    },
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let variant: number | 'all' = 0;
  let start = 0x0000;
  let isUpper = false;
  let chunk = 256;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') variant = 'all';
    else if (a === '--variant') variant = Number(args[++i]);
    else if (a === '--addr') start = Number(args[++i]);
    else if (a === '--upper') isUpper = true;
    else if (a === '--chunk') chunk = Number(args[++i]);
  }
  return { variant, start, isUpper, chunk };
}

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ');
}

async function run() {
  const { variant, start, isUpper, chunk } = parseArgs();
  // 256 bytes of mid-scale silence
  const audio = new Uint8Array(chunk).fill(0x80);

  const link = await MirageLink.open();
  console.log(`out: ${link.outName}\nin:  ${link.inName}`);
  console.log(
    `payload: ${audio.length} B at 0x${start.toString(16).padStart(4, '0')}, ` +
      `${isUpper ? 'upper' : 'lower'} half`
  );

  try {
    const list = variant === 'all' ? variants : [variants[variant as number]!];
    for (const v of list) {
      console.log(`\n--- ${v.name} ---`);
      const frame = v.build(start, audio, isUpper);
      console.log(
        `header bytes: ${hex(frame.subarray(0, 12))}` +
          ` ... checksum=${frame[frame.length - 2]!.toString(16).padStart(
            2,
            '0'
          )}` +
          `  total=${frame.length}B`
      );
      const replyP = link.awaitSysex({ timeoutMs: 1500 });
      link.sendSysex(frame);
      try {
        const r = await replyP;
        const cmd = r[3];
        const tag =
          cmd === 0x09
            ? 'ACK'
            : cmd === 0x0a
              ? 'NAK'
              : `cmd=0x${cmd!.toString(16)}`;
        console.log(`reply: ${tag}  raw: ${hex(r)}`);
      } catch {
        console.log('reply: <timeout>');
      }
      // small pause so Mirage settles
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    link.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
