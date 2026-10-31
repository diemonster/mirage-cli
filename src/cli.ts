#!/usr/bin/env node
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { convertToMirageRaw } from './audio.js';
import {
  DEFAULT_PORT_NAME,
  DEFAULT_SAMPLE_RATE_HZ,
  MIN_SAMPLE_RATE_HZ,
  parseSlot,
  SLOT_CAPACITY_BYTES,
  SLOT_NAMES,
} from './constants.js';
import {
  listInputPorts,
  listOutputPorts,
  MirageLink,
  sendSysexFrames,
  sendSysexFramesGated,
  sleep,
} from './midi.js';
import { probeMirage } from './probe.js';
import {
  buildKeypress,
  buildWaveformDump,
  buildWavesampleAbsoluteRequest,
  buildWavesampleDump,
  buildWavesampleParam,
  concatFrames,
  isWavesampleAbsoluteData,
  isWavesampleAck,
  isWavesampleNak,
  parseWavesampleAbsoluteData,
} from './sysex.js';
import { KEY, parseKey } from './keys.js';

const EXIT = {
  OK: 0,
  ARG_ERROR: 1,
  AUDIO_FAIL: 2,
  PORT_NOT_FOUND: 3,
  TRANSFER_FAIL: 4,
} as const;

const program = new Command();

program
  .name('mirage-send')
  .description(
    'Send a sample to an Ensoniq Mirage DMS-8 (MASOS) over MIDI SysEx.'
  )
  .version('0.1.0');

// ---------------------------------------------------------------------------
// `ports` — list MIDI ports
// ---------------------------------------------------------------------------

program
  .command('ports')
  .description('List MIDI ports visible to mirage-send and exit.')
  .action(async () => {
    const [outs, ins] = await Promise.all([
      listOutputPorts(),
      listInputPorts(),
    ]);
    console.log('Outputs:');
    for (const p of outs) console.log(`  ${p.name}`);
    if (outs.length === 0) console.log('  (none)');
    console.log('Inputs:');
    for (const p of ins) console.log(`  ${p.name}`);
    if (ins.length === 0) console.log('  (none)');
  });

// ---------------------------------------------------------------------------
// `probe` — round-trip SysEx check, verifies Mirage presence + MASOS
// ---------------------------------------------------------------------------

program
  .command('probe')
  .description(
    'Send a parameter-read request to the Mirage and report what comes back. ' +
      'Confirms the Mirage is reachable and running MASOS.'
  )
  .option(
    '-p, --port <name>',
    `MIDI port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option(
    '--param <n>',
    'parameter number to read (default: 91, External Computer Port Enable)',
    String(91)
  )
  .option('--timeout <ms>', 'how long to wait for a reply', String(2000))
  .option(
    '--save <path>',
    'write the captured reply to this .syx file for inspection'
  )
  .action(
    async (opts: {
      port?: string;
      param: string;
      timeout: string;
      save?: string;
    }) => {
      const param = Number(opts.param);
      const timeoutMs = Number(opts.timeout);
      try {
        const result = await probeMirage({
          port: opts.port,
          param,
          timeoutMs,
        });
        console.log(`port out: ${result.outPort}`);
        console.log(`port in:  ${result.inPort}`);
        console.log(result.detail);
        if (result.reply && opts.save) {
          await writeFile(opts.save, result.reply);
          console.log(`Saved ${result.reply.length} B reply to ${opts.save}`);
        }
        process.exit(result.ok ? EXIT.OK : EXIT.TRANSFER_FAIL);
      } catch (err) {
        printErr(err);
        const msg = err instanceof Error ? err.message : String(err);
        process.exit(
          /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
        );
      }
    }
  );

// ---------------------------------------------------------------------------
// `keypress` — simulate front-panel button presses
// ---------------------------------------------------------------------------

program
  .command('keypress')
  .description(
    'Send a front-panel keypress sequence (MASOS cmd 0x01). Accepts ' +
      'digit characters and named keys: enter, cancel, param, value, up, ' +
      'down, prog, load-upper, load-lower, sample-upper, sample-lower, ' +
      'rec-seq, play-seq, load-seq, save-seq. Up to 5 keys per message; ' +
      'longer sequences are split automatically.'
  )
  .argument('<keys...>', 'one or more key tokens')
  .option(
    '-p, --port <name>',
    `MIDI output port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option(
    '--delay <ms>',
    'milliseconds between multi-message bursts (default: 30)',
    String(30)
  )
  .option('-v, --verbose', 'log progress', false)
  .action(
    async (
      keys: string[],
      opts: { port?: string; delay: string; verbose: boolean }
    ) => {
      try {
        const codes = keys.map(parseKey);
        const burst = 5;
        const frames: Uint8Array[] = [];
        for (let i = 0; i < codes.length; i += burst) {
          frames.push(buildKeypress(codes.slice(i, i + burst)));
        }
        if (opts.verbose) {
          console.error(
            `[mirage-send] ${codes.length} key(s) in ${frames.length} ` +
              `SysEx message(s): ${codes
                .map((c) => `0x${c.toString(16).padStart(2, '0')}`)
                .join(' ')}`
          );
        }
        await sendSysexFrames(frames, {
          port: opts.port,
          interPacketDelayMs: Number(opts.delay),
        });
        if (opts.verbose) console.error('[mirage-send] done.');
        process.exit(EXIT.OK);
      } catch (err) {
        printErr(err);
        const msg = err instanceof Error ? err.message : String(err);
        process.exit(
          /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
        );
      }
    }
  );

// ---------------------------------------------------------------------------
// `load` — load a disk Sound slot into RAM
// ---------------------------------------------------------------------------

program
  .command('load')
  .description(
    'Load a disk Sound slot into RAM (front-panel LOAD UPPER/LOWER + N + ' +
      'ENTER). Each half has three disk slots (1, 2, 3) on the standard ' +
      'sound diskette; the chosen slot becomes the current RAM contents ' +
      'until a SysEx upload overwrites it.'
  )
  .argument('<half>', '"upper" or "lower"')
  .argument('<slot>', 'disk slot 1..3 (or higher on custom disks; 0..9)')
  .option(
    '-p, --port <name>',
    `MIDI output port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option('-v, --verbose', 'log progress', false)
  .action(
    async (
      halfRaw: string,
      slotRaw: string,
      opts: { port?: string; verbose: boolean }
    ) => {
      try {
        const half = halfRaw.toLowerCase();
        if (half !== 'upper' && half !== 'lower') {
          program.error(`Invalid half "${halfRaw}" (expected upper|lower)`, {
            exitCode: EXIT.ARG_ERROR,
          });
        }
        const slot = Number(slotRaw);
        if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
          program.error(`Invalid slot "${slotRaw}" (expected 0..9)`, {
            exitCode: EXIT.ARG_ERROR,
          });
        }
        const loadKey = half === 'upper' ? KEY.LOAD_UPPER : KEY.LOAD_LOWER;
        const frame = buildKeypress([loadKey, slot, KEY.ENTER]);
        if (opts.verbose) {
          const hex = Array.from(frame)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          console.error(`[mirage-send] sending: ${hex}`);
        }
        await sendSysexFrames([frame], { port: opts.port });
        console.log(`Sent: load ${half} sound ${slot}.`);
        process.exit(EXIT.OK);
      } catch (err) {
        printErr(err);
        const msg = err instanceof Error ? err.message : String(err);
        process.exit(
          /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
        );
      }
    }
  );

// ---------------------------------------------------------------------------
// `wsparam` — set a wavesample parameter (cmd 0x0E)
// ---------------------------------------------------------------------------

program
  .command('wsparam')
  .description(
    'Set a wavesample parameter on the Mirage (MASOS cmd 0x0E). ' +
      'Wavesamples are numbered 1..8 (front-panel numbering).'
  )
  .requiredOption('--half <upper|lower>', 'target half ("upper" or "lower")')
  .requiredOption('--ws <1..8>', 'wavesample number (1..8)')
  .requiredOption('--param <n>', 'wavesample parameter number (0..127)')
  .requiredOption('--value <n>', 'parameter value (0..255)')
  .option(
    '-p, --port <name>',
    `MIDI output port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option('-v, --verbose', 'log the built SysEx bytes', false)
  .action(
    async (opts: {
      half: string;
      ws: string;
      param: string;
      value: string;
      port?: string;
      verbose: boolean;
    }) => {
      try {
        const half = opts.half.toLowerCase();
        if (half !== 'upper' && half !== 'lower') {
          program.error(`Invalid --half "${opts.half}"`, {
            exitCode: EXIT.ARG_ERROR,
          });
        }
        const frame = buildWavesampleParam({
          half: half as 'upper' | 'lower',
          wavesample: Number(opts.ws),
          param: Number(opts.param),
          value: Number(opts.value),
        });
        if (opts.verbose) {
          const hex = Array.from(frame)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          console.error(`[mirage-send] sending: ${hex}`);
        }
        await sendSysexFrames([frame], { port: opts.port });
        console.log(
          `Set ${half} wavesample ${opts.ws} param ${opts.param} = ${opts.value}.`
        );
        process.exit(EXIT.OK);
      } catch (err) {
        printErr(err);
        const msg = err instanceof Error ? err.message : String(err);
        process.exit(
          /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
        );
      }
    }
  );

// ---------------------------------------------------------------------------
// `note` — one MIDI note on/off, for automated audio measurements
// ---------------------------------------------------------------------------

program
  .command('note')
  .description('Play one MIDI note: note on, hold, note off.')
  .argument('<note>', 'MIDI note number 0..127')
  .option('-p, --port <name>', 'MIDI output port name')
  .option('--velocity <n>', 'note-on velocity 1..127', String(100))
  .option('--hold <ms>', 'milliseconds between note on and note off', String(500))
  .option('--channel <n>', 'MIDI channel 1..16', String(1))
  .action(
    async (
      noteArg: string,
      opts: { port?: string; velocity: string; hold: string; channel: string }
    ) => {
      const note = Number(noteArg);
      const velocity = Number(opts.velocity);
      const channel = Number(opts.channel) - 1;
      if (![note, velocity, channel].every(Number.isInteger) || note > 127 || velocity > 127 || channel > 15 || channel < 0) {
        program.error('note, velocity and channel must be integers in range', { exitCode: EXIT.ARG_ERROR });
      }
      try {
        const link = await MirageLink.open({ outPort: opts.port });
        try {
          link.send([0x90 | channel, note, velocity]);
          console.log(`on ${Date.now()}`);
          await sleep(Number(opts.hold));
          link.send([0x80 | channel, note, 0]);
          console.log(`off ${Date.now()}`);
          await sleep(50);
        } finally {
          link.close();
        }
        process.exit(EXIT.OK);
      } catch (err) {
        printErr(err);
        process.exit(EXIT.PORT_NOT_FOUND);
      }
    }
  );

// ---------------------------------------------------------------------------
// `dump` — read wavesample RAM back (cmd 0x0B request, 0x0C replies)
// ---------------------------------------------------------------------------

program
  .command('dump')
  .description(
    'Read a range of a half\'s 64 KB wavesample RAM back from the Mirage ' +
      '(MASOS cmd 0x0B) and write it as raw 8-bit unsigned bytes.'
  )
  .argument('<out-file>', 'destination .raw file')
  .requiredOption('--half <upper|lower>', 'which half to read')
  .option('-p, --port <name>', 'MIDI port name')
  .option('--start <addr>', 'start address (decimal or 0x hex)', '0')
  .option('--length <n>', 'bytes to read (default: whole 64 KB)', String(SLOT_CAPACITY_BYTES))
  .option('--idle <ms>', 'stop when no frame arrives for this long', String(3000))
  .option('--max <ms>', 'overall timeout', String(120000))
  .action(
    async (
      outFile: string,
      opts: { half: string; port?: string; start: string; length: string; idle: string; max: string }
    ) => {
      const half = opts.half.toLowerCase();
      if (half !== 'upper' && half !== 'lower') {
        program.error(`Invalid --half "${opts.half}"`, { exitCode: EXIT.ARG_ERROR });
      }
      const start = Number(opts.start);
      const length = Number(opts.length);
      if (!Number.isInteger(start) || !Number.isInteger(length) || length < 1 || start + length > SLOT_CAPACITY_BYTES) {
        program.error('start/length must stay inside the 64 KB half', { exitCode: EXIT.ARG_ERROR });
      }
      try {
        const link = await MirageLink.open({ outPort: opts.port });
        let frames: Uint8Array[];
        try {
          // End address follows the exclusive convention verified for uploads.
          const collect = link.collectSysex({
            predicate: isWavesampleAbsoluteData,
            idleMs: Number(opts.idle),
            maxMs: Number(opts.max),
          });
          link.sendSysex(
            buildWavesampleAbsoluteRequest({
              half: half as 'upper' | 'lower',
              startAddress: start,
              endAddress: (start + length) & 0xffff,
            })
          );
          frames = await collect;
        } finally {
          link.close();
        }
        if (frames.length === 0) {
          console.error('error: no wavesample data frames received');
          process.exit(EXIT.TRANSFER_FAIL);
        }
        const image = new Uint8Array(length);
        let covered = 0;
        let badChecksums = 0;
        for (const f of frames) {
          const d = parseWavesampleAbsoluteData(f);
          if (!d.checksumOk) badChecksums++;
          const offset = d.startAddress - start;
          const n = Math.min(d.audio8.length, length - offset);
          if (offset < 0 || n <= 0) continue;
          image.set(d.audio8.subarray(0, n), offset);
          covered += n;
        }
        await writeFile(outFile, image);
        console.log(
          `Received ${frames.length} frame(s), ${covered}/${length} bytes, ` +
            `${badChecksums} checksum error(s). Wrote ${outFile}.`
        );
        process.exit(badChecksums === 0 && covered >= length ? EXIT.OK : EXIT.TRANSFER_FAIL);
      } catch (err) {
        printErr(err);
        const msg = err instanceof Error ? err.message : String(err);
        process.exit(/port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL);
      }
    }
  );

// ---------------------------------------------------------------------------
// `init` — set MIDI params required for bidirectional SysEx
// ---------------------------------------------------------------------------

program
  .command('init')
  .description(
    'Prepare the Mirage for bidirectional SysEx: force [83] MIDI Thru-mode ' +
      'to 0 (off) and [91] External Computer Port Enable to 1 (on). Uses ' +
      'blind UP/DOWN clamp (matches the python reference): select param, ' +
      'press DOWN several times to clamp at 0, then UP once if target is 1. ' +
      'Run once after each MASOS boot.'
  )
  .option(
    '-p, --port <name>',
    `MIDI output port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option(
    '--delay <ms>',
    'milliseconds between multi-message bursts (default: 60)',
    String(60)
  )
  .option('-v, --verbose', 'log progress', false)
  .action(async (opts: { port?: string; delay: string; verbose: boolean }) => {
    try {
      const frames = buildInitKeypressFrames();
      if (opts.verbose) {
        console.error(
          `[mirage-send] sending ${frames.length} keypress frame(s) ` +
            'to force [91]=1 then [83]=0'
        );
      }
      await sendSysexFrames(frames, {
        port: opts.port,
        interPacketDelayMs: Number(opts.delay),
      });
      console.log('Sent: forced [91]=1 (Computer Port on), [83]=0 (Thru off).');
      console.log('Tip: run `mirage-send probe` to verify.');
      process.exit(EXIT.OK);
    } catch (err) {
      printErr(err);
      const msg = err instanceof Error ? err.message : String(err);
      process.exit(
        /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
      );
    }
  });

/**
 * Build the keypress frames that force [91]=1 and [83]=0. Used by both
 * the `init` subcommand and the `send` subcommand's auto-init prelude.
 *
 * Blind 0/1 toggle: select the param, press DOWN several times (clamps
 * at 0 regardless of starting state), then UP once if target is 1.
 * Order matters: do [91] first so subsequent SysEx traffic is observable.
 */
function buildInitKeypressFrames(): Uint8Array[] {
  const forceToggle = (param: number, desired: 0 | 1): Uint8Array[] => {
    const tens = Math.floor(param / 10);
    const ones = param % 10;
    const select = [KEY.CANCEL, KEY.PARAM, tens, ones, KEY.ENTER, KEY.VALUE];
    const frames: Uint8Array[] = [];
    for (let i = 0; i < select.length; i += 5) {
      frames.push(buildKeypress(select.slice(i, i + 5)));
    }
    frames.push(buildKeypress([KEY.DOWN, KEY.DOWN, KEY.DOWN]));
    if (desired === 1) {
      frames.push(buildKeypress([KEY.UP]));
    }
    return frames;
  };
  return [...forceToggle(91, 1), ...forceToggle(83, 0)];
}

// ---------------------------------------------------------------------------
// `send` (default) — convert + dump a sample
// ---------------------------------------------------------------------------

program
  .command('send', { isDefault: true })
  .description('Convert a WAV and send it to a Mirage sample slot.')
  .argument('[wav-file]', 'input audio file (WAV recommended)')
  .option(
    '-s, --slot <slot>',
    `target slot: ${SLOT_NAMES.join('|')}. ` +
      'NOTE: today only the half (upper/lower) affects the wire — the ' +
      'index selects a disk slot, but mirage-send writes to live RAM. ' +
      'Indices 2/3 require --allow-ram-only to confirm intent.',
    'upper1'
  )
  .option(
    '--allow-ram-only',
    'acknowledge that --slot {upper,lower}{2,3} writes to live RAM only ' +
      '(disk slot N is not modified). Reserved for future disk-save support.',
    false
  )
  .option(
    '-p, --port <name>',
    `MIDI output port name (default: $MIRAGE_PORT or "${DEFAULT_PORT_NAME}")`
  )
  .option(
    '-r, --rate <hz>',
    `target playback sample rate in Hz (default: as high as fits, max ${DEFAULT_SAMPLE_RATE_HZ})`
  )
  .option(
    '--truncate',
    'preserve --rate and truncate the tail instead of downsampling to fit',
    false
  )
  .option(
    '-u, --pitch-up <semitones>',
    'pitch the sample up by this many semitones before sending. Only ' +
      '12, 24, or 36 are accepted (clean octave alignment with the ' +
      "Mirage's [67] coarse tune, which is in octaves). The shorter " +
      'pitched-up audio is uploaded as-is; [67] is then set to the ' +
      'matching octave count so C3 plays the sample back at its ' +
      'original pitch (with audible aliasing — that is the point).'
  )
  .option(
    '--mode <mode>',
    'upload protocol: "abs" (cmd 0x0C — verified working) or "wavesample" ' +
      '(cmd 0x06 — EXPERIMENTAL: does not currently ACK; targets the ' +
      'wavesample selected on the front panel via param [26]; audio is ' +
      'padded with 0x80 silence to a 256 B page boundary)',
    'abs'
  )
  .option(
    '--no-resample',
    'fail instead of auto-downsampling when the audio overflows the slot ' +
      '(combine with -u to pitch-up to fit instead)'
  )
  .option(
    '--ack-timeout <ms>',
    'how long to wait for each frame ACK from the Mirage (default: 2000)',
    String(2000)
  )
  .option(
    '--inter-packet-delay <ms>',
    'minimum delay between SysEx frames during the upload (default: 25)',
    String(25)
  )
  .option(
    '--no-auto-init',
    'skip the [91]=1 / [83]=0 keypress prelude. By default `send` runs ' +
      'the same blind toggle as `mirage-send init` before each upload so ' +
      'reboots do not require a separate init step.'
  )
  .option(
    '--no-pad',
    'do not pad the audio out to the full slot size with 0x80 silence. ' +
      'By default `send` pads short samples so leftover audio from the ' +
      'previous sample in the same slot cannot bleed through after your ' +
      'sample ends. Skipping the pad is faster but the tail of any prior ' +
      'sample will play through whatever RAM your upload did not overwrite.'
  )
  .option(
    '-d, --dry-run',
    'build SysEx and write to <wav>.syx; do not send to MIDI',
    false
  )
  .option('-v, --verbose', 'log progress', false)
  .action(async (wavFile: string | undefined, opts: SendOptions) => {
    try {
      if (!wavFile) {
        program.error('Missing <wav-file> argument.', {
          exitCode: EXIT.ARG_ERROR,
        });
      }

      const slot = parseSlot(opts.slot);

      if (slot.index !== 1 && !opts.allowRamOnly) {
        program.error(
          `--slot ${opts.slot} names a disk slot, but mirage-send currently ` +
            `writes to live RAM only (the disk slot itself is not modified). ` +
            `Re-run with --allow-ram-only to confirm, or use ` +
            `--slot ${slot.half}1 to make the RAM-only intent explicit.`,
          { exitCode: EXIT.ARG_ERROR }
        );
      }

      const rateExplicit = opts.rate !== undefined;
      const requestedRate = rateExplicit
        ? Number(opts.rate)
        : DEFAULT_SAMPLE_RATE_HZ;
      if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
        program.error(`Invalid --rate: ${opts.rate}`, {
          exitCode: EXIT.ARG_ERROR,
        });
      }

      const pitchSemis = opts.pitchUp !== undefined ? Number(opts.pitchUp) : 0;
      if (!Number.isFinite(pitchSemis)) {
        program.error(`Invalid --pitch-up: ${opts.pitchUp}`, {
          exitCode: EXIT.ARG_ERROR,
        });
      }
      // -u accepts only 12, 24, or 36 (or 0/absent). The Mirage's [67]
      // rel_tuning_coarse is whole-octave only, and we route the entire
      // shift through the source-resample trick so C3 plays back at the
      // original pitch (with aliasing — that's the creative point).
      if (pitchSemis !== 0 && ![12, 24, 36].includes(pitchSemis)) {
        program.error(
          `Invalid --pitch-up ${pitchSemis}. Only 12, 24, or 36 are supported ` +
            `(must align to whole Mirage [67] octaves).`,
          { exitCode: EXIT.ARG_ERROR }
        );
      }
      const pitchOctaves = pitchSemis / 12; // 0, 1, 2, or 3
      const pitchFactor = Math.pow(2, pitchSemis / 12); // 1, 2, 4, or 8

      // playbackRate = what the Mirage clocks bytes out at (program metadata).
      // conversionRate = what ffmpeg actually produces (samples/sec of raw
      // bytes). For -u N, we DROP the conversionRate by 2^(N/12) so the
      // same playbackRate consumes the bytes 2^(N/12) times faster than
      // they were sampled → audible +N semis. Then [67]=N octaves shifts
      // the playback back down by N semis, leaving net 0 at C3 (with the
      // aliasing artifacts of the round trip).
      let playbackRate = requestedRate;
      let conversionRate = Math.round(playbackRate / pitchFactor);
      if (conversionRate < 1000) {
        program.error(
          `--pitch-up ${pitchSemis} would require resampling source at ` +
            `${conversionRate} Hz (too low). Reduce --pitch-up.`,
          { exitCode: EXIT.ARG_ERROR }
        );
      }

      const inputPath = resolve(process.cwd(), wavFile!);

      log(
        opts,
        `Converting ${basename(inputPath)} → 8-bit mono @ ${conversionRate} Hz (soxr)` +
          (pitchSemis !== 0
            ? `; pitched +${pitchSemis} semis (playback ${playbackRate} Hz; ` +
              `Mirage [67]=${pitchOctaves} will retune to original pitch at C3)`
            : '')
      );
      let audio8: Uint8Array;
      try {
        audio8 = await convertToMirageRaw(inputPath, conversionRate);
      } catch (err) {
        printErr(err);
        process.exit(EXIT.AUDIO_FAIL);
      }

      // Size policy.
      if (audio8.length > SLOT_CAPACITY_BYTES) {
        const overBytes = audio8.length;
        // Highest conversionRate at which the whole sample still fits.
        // Round down + reserve a 1-byte margin against ffmpeg rounding.
        // Floor at MIN_SAMPLE_RATE_HZ only when there's no pitch-up
        // escape hatch (otherwise the user is opting into bigger shifts).
        const fitFloor = pitchSemis === 0 ? MIN_SAMPLE_RATE_HZ : 1000;
        const fitConversionRate = Math.max(
          fitFloor,
          Math.floor((conversionRate * (SLOT_CAPACITY_BYTES - 1)) / overBytes)
        );

        if (opts.truncate) {
          audio8 = audio8.subarray(0, SLOT_CAPACITY_BYTES);
          console.warn(
            `warning: truncated ${overBytes} B → ${SLOT_CAPACITY_BYTES} B ` +
              `(~${(SLOT_CAPACITY_BYTES / playbackRate).toFixed(2)} s ` +
              `at ${playbackRate} Hz playback).`
          );
        } else if (
          opts.resample === false ||
          (rateExplicit && pitchSemis === 0)
        ) {
          // User asked for no auto-resample, OR specified --rate without a
          // pitch-shift escape hatch.
          // -u accepts only 12/24/36; pick the smallest that would fit.
          const suggestSemis = [12, 24, 36].find(
            (s) => conversionRate / Math.pow(2, s / 12) >= fitConversionRate
          );
          const why =
            opts.resample === false
              ? '--no-resample is set'
              : `the requested ${playbackRate} Hz exceeds slot capacity`;
          console.error(
            `error: converted audio is ${overBytes} B; ${why} ` +
              `(slot is ${SLOT_CAPACITY_BYTES} B).\n` +
              `  - re-run with --truncate to keep the first ~${(SLOT_CAPACITY_BYTES / playbackRate).toFixed(2)} s\n` +
              (suggestSemis !== undefined
                ? `  - re-run with --pitch-up ${suggestSemis} (Mirage [67] auto-retunes C3 to original pitch)\n`
                : '') +
              `  - or pass --rate ${fitConversionRate} explicitly` +
              (opts.resample === false
                ? ''
                : '\n  - or drop --rate to let mirage-send auto-downsample')
          );
          process.exit(EXIT.AUDIO_FAIL);
        } else {
          // Auto-fit by reducing conversionRate.
          log(
            opts,
            `Oversized (${overBytes} B at ${conversionRate} Hz). ` +
              `Re-converting at ${fitConversionRate} Hz to fit.`
          );
          try {
            audio8 = await convertToMirageRaw(inputPath, fitConversionRate);
          } catch (err) {
            printErr(err);
            process.exit(EXIT.AUDIO_FAIL);
          }
          if (audio8.length > SLOT_CAPACITY_BYTES) {
            audio8 = audio8.subarray(0, SLOT_CAPACITY_BYTES);
          }
          conversionRate = fitConversionRate;
          // Drop playback rate to match conversion rate so the
          // user-requested pitch shift (which lives entirely in the
          // conversion rate now that -u is whole octaves only) is
          // preserved. [67] still gets set to pitchOctaves so C3 plays
          // back at the original pitch.
          playbackRate = fitConversionRate;
          const octMul = 1 << pitchOctaves;
          const audibleNyquistKHz = (fitConversionRate * octMul) / 2 / 1000;
          console.warn(
            `note: auto-downsampled to ${fitConversionRate} Hz to fit the ` +
              `${SLOT_CAPACITY_BYTES} B slot` +
              (pitchOctaves > 0
                ? ` (Mirage [67]=+${pitchOctaves} oct then clocks bytes out ` +
                  `${octMul}× faster, so audible Nyquist is ~${audibleNyquistKHz.toFixed(1)} kHz).`
                : ` (Nyquist now ${(fitConversionRate / 2 / 1000).toFixed(1)} kHz).`)
          );
        }
      }

      log(
        opts,
        `Audio bytes: ${audio8.length} / ${SLOT_CAPACITY_BYTES} ` +
          `(conv ${conversionRate} Hz, playback ${playbackRate} Hz` +
          (pitchOctaves > 0
            ? `; Mirage [67]=${pitchOctaves} divides playback clock by ${1 << pitchOctaves}× → effective ${playbackRate / (1 << pitchOctaves)} Hz at C3`
            : '') +
          `)`
      );
      // At C3, [67]=N divides the playback clock by 2^N (octave-down retune),
      // expanding the time-compressed bytes back to their original duration.
      const audibleClockHz = playbackRate / (1 << pitchOctaves);
      log(
        opts,
        `Audible duration at C3: ~${(audio8.length / audibleClockHz).toFixed(2)} s` +
          (pitchOctaves > 0
            ? ` (matches original — pitched +${pitchSemis} on upload, retuned -${pitchSemis} on playback).`
            : '.')
      );
      const stops = (audio8 as Uint8Array & { stopsClamped?: number })
        .stopsClamped;
      if (stops) {
        log(
          opts,
          `Clamped ${stops} byte(s) from 0x00 → 0x01 (0x00 is the Mirage's ` +
            `playback-stop marker; ffmpeg's pcm_u8 produces it for full-negative samples).`
        );
      }

      const mode = opts.mode.toLowerCase();
      if (mode !== 'abs' && mode !== 'wavesample') {
        program.error(
          `Invalid --mode "${opts.mode}". Expected "abs" or "wavesample".`,
          { exitCode: EXIT.ARG_ERROR }
        );
      }

      let frames: Uint8Array[];
      if (mode === 'wavesample') {
        // Pad up to a multiple of 256 with mid-scale silence (0x80).
        const PAGE = 256;
        const padded =
          audio8.length % PAGE === 0
            ? audio8
            : (() => {
                const padTo = Math.ceil(audio8.length / PAGE) * PAGE;
                const p = new Uint8Array(padTo).fill(0x80);
                p.set(audio8, 0);
                return p;
              })();
        if (padded.length !== audio8.length) {
          log(
            opts,
            `Padded ${audio8.length} → ${padded.length} B (1 page = 256 B) ` +
              `with 0x80 silence for cmd 0x06.`
          );
        }
        frames = [buildWavesampleDump({ audio8: padded })];
        log(
          opts,
          `Built 1 wavesample-data (cmd 0x06) frame, ${padded.length / 256} ` +
            `page(s). Target = wavesample currently selected on front panel ` +
            `(param [26]); --slot half "${slot.half}" is IGNORED by this mode.`
        );
      } else {
        // Pad short samples out to the full slot with 0x80 (mid-scale
        // silence) so leftover audio from the previous sample in this
        // slot cannot bleed through after our payload ends. Disable
        // with --no-pad if you know the slot is already empty / shorter.
        let audioForUpload = audio8;
        if (opts.pad && audio8.length < SLOT_CAPACITY_BYTES) {
          const p = new Uint8Array(SLOT_CAPACITY_BYTES).fill(0x80);
          p.set(audio8, 0);
          log(
            opts,
            `Padded ${audio8.length} → ${SLOT_CAPACITY_BYTES} B with 0x80 ` +
              `silence so prior-sample tail in this slot cannot bleed ` +
              `through (skip with --no-pad).`
          );
          audioForUpload = p;
        }
        frames = buildWaveformDump({
          half: slot.half,
          audio8: audioForUpload,
        });
        log(
          opts,
          `Built ${frames.length} SysEx frame(s) for ${slot.half} half ` +
            `(playback ${playbackRate} Hz is set by Mirage program, not SysEx).`
        );
      }

      if (opts.dryRun) {
        const outPath = inputPath.replace(/\.[^./]+$/, '') + '.syx';
        const all = concatFrames(frames);
        await writeFile(outPath, all);
        console.log(`Wrote ${all.length} bytes to ${outPath}`);
        process.exit(EXIT.OK);
      }

      // Auto-init prelude: blindly enforce [91]=1 and [83]=0 before each
      // upload so a fresh MASOS boot doesn't require a separate
      // `mirage-send init` step. Keypress SysEx is inbound-only so it
      // works regardless of the current [91] value. Disable with
      // --no-auto-init.
      if (opts.autoInit) {
        const initFrames = buildInitKeypressFrames();
        log(
          opts,
          `Auto-init: sending ${initFrames.length} keypress frame(s) ` +
            'to force [91]=1 then [83]=0 (use --no-auto-init to skip).'
        );
        try {
          await sendSysexFrames(initFrames, {
            port: opts.port,
            interPacketDelayMs: 60,
          });
          // Let the Mirage settle before the audio upload starts.
          await sleep(150);
        } catch (err) {
          printErr(err);
          const msg = (err as Error).message ?? '';
          process.exit(
            /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
          );
        }
      }

      try {
        await sendSysexFramesGated(frames, {
          port: opts.port,
          isAck: isWavesampleAck,
          isNak: isWavesampleNak,
          ackTimeoutMs: Number(opts.ackTimeout),
          interPacketDelayMs: Number(opts.interPacketDelay),
          onProgress: (sent, total) => {
            if (opts.verbose) {
              process.stdout.write(`\rACK ${sent}/${total}`);
              if (sent === total) process.stdout.write('\n');
            }
          },
        });
      } catch (err) {
        printErr(err);
        const msg = (err as Error).message ?? '';
        process.exit(
          /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
        );
      }

      // After the audio upload, set Mirage param [67] (rel_tuning_coarse,
      // range 0..7) to retune C3 back to the source's original pitch.
      // Empirical mapping (verified on hardware): when the upload was
      // pitched up by N octaves, [67] must be set to (3 - N):
      //   -u 12 (1 oct up) → [67]=2
      //   -u 24 (2 oct up) → [67]=1
      //   -u 36 (3 oct up) → [67]=0
      // Blind absolute set: select [67] via CANCEL/PARAM/6/7/ENTER/VALUE,
      // then DOWN×8 to clamp at 0, then UP×coarseTuneTarget. Assumes the
      // upload's target program is the one currently shown on the front
      // panel (it should be, since we just wrote to that half's RAM).
      if (pitchOctaves > 0) {
        const coarseTuneTarget = 3 - pitchOctaves;
        // Let the Mirage settle after the burst of audio ACKs before we
        // throw front-panel-keypress traffic at it. Empirically the 6809
        // drops keypress frames if you hit it too soon.
        await sleep(250);
        const ups: number[] = [];
        for (let i = 0; i < coarseTuneTarget; i++) ups.push(KEY.UP);
        const tuneFrames: Uint8Array[] = [
          buildKeypress([KEY.CANCEL, KEY.PARAM, 6, 7, KEY.ENTER]),
          buildKeypress([KEY.VALUE]),
          // Clamp at 0 from any starting value (range 0..7) with 8 DOWN
          // presses, split across two 5-key-max frames.
          buildKeypress([KEY.DOWN, KEY.DOWN, KEY.DOWN, KEY.DOWN, KEY.DOWN]),
          buildKeypress([KEY.DOWN, KEY.DOWN, KEY.DOWN]),
        ];
        // Add UP frame only when coarseTuneTarget > 0 (cmd-0x01 with no
        // keys is malformed). At -u 36 the target is 0, so we just stop
        // after the DOWN clamp.
        if (ups.length > 0) {
          tuneFrames.push(buildKeypress(ups));
        }
        log(
          opts,
          `Setting Mirage [67] coarse tune = ${coarseTuneTarget} ` +
            `(C3 retune for -u ${pitchSemis}) ` +
            `via ${tuneFrames.length} keypress frame(s) (100 ms spacing).`
        );
        try {
          await sendSysexFrames(tuneFrames, {
            port: opts.port,
            // Bump from default 20 ms — the Mirage front-panel-keypress
            // dispatcher is slower than its SysEx ACK loop.
            interPacketDelayMs: 100,
          });
        } catch (err) {
          printErr(err);
          const msg = (err as Error).message ?? '';
          process.exit(
            /port/i.test(msg) ? EXIT.PORT_NOT_FOUND : EXIT.TRANSFER_FAIL
          );
        }
      }

      const pitchSummary =
        pitchSemis !== 0
          ? ` (pitched +${pitchSemis} semis on upload; Mirage [67]=${3 - pitchOctaves} retunes C3 to original pitch with aliasing)`
          : '';

      console.log(
        `Done. Sent to ${slot.half} RAM` +
          (slot.index !== 1 ? ` (disk slot ${slot.index} not modified)` : '') +
          `${pitchSummary}.`
      );
      process.exit(EXIT.OK);
    } catch (err) {
      printErr(err);
      process.exit(EXIT.ARG_ERROR);
    }
  });

interface SendOptions {
  slot: string;
  allowRamOnly: boolean;
  port?: string;
  rate?: string;
  truncate: boolean;
  pitchUp?: string;
  mode: string;
  // commander turns `--no-resample` into `resample: false` (default true).
  resample: boolean;
  // commander turns `--no-auto-init` into `autoInit: false` (default true).
  autoInit: boolean;
  // commander turns `--no-pad` into `pad: false` (default true).
  pad: boolean;
  ackTimeout: string;
  interPacketDelay: string;
  dryRun: boolean;
  verbose: boolean;
}

function log(opts: { verbose: boolean }, msg: string): void {
  if (opts.verbose) console.error(`[mirage-send] ${msg}`);
}

function printErr(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
}

program.parseAsync(process.argv);
