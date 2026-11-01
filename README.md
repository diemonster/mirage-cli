# mirage-cli

`mirage-send` — a CLI for talking to an Ensoniq Mirage DMS-8 over MIDI SysEx.
Targets the **MASOS V2** firmware.

## Features

- **`send`** — convert a WAV (any rate, channel count) to 8-bit mono and
  upload it to the Mirage's upper or lower RAM via wavesample-absolute dump
  (cmd 0x0C). ACK-gated, with auto-fit, pitch-up, and dry-run options.
- **`probe`** — round-trip MIDI sanity check; reads a Mirage parameter and
  prints its value. Confirms MASOS is booted and `[91]` External Computer
  Port Enable = 1.
- **`init`** — set `[83]=0` (MIDI Thru off) and `[91]=1` (Computer Port
  on) via front-panel keypresses. Run once after each MASOS boot.
- **`keypress`** — drive the front panel from the terminal: digits plus
  named keys (`enter`, `cancel`, `param`, `value`, `up`, `down`, `prog`,
  `load-upper`, `load-lower`, `sample-upper`, `sample-lower`, `rec-seq`,
  `play-seq`, `load-seq`, `save-seq`).
- **`load <half> <slot>`** — convenience wrapper for
  `LOAD_UPPER`/`LOAD_LOWER` + digit + `ENTER`.
- **`wsparam`** — set a wavesample parameter (MASOS cmd 0x0E).
- **`ports`** — list MIDI ports visible to JZZ/CoreMIDI.

## Install

### Prerequisites

- **Node.js 20+** (`node --version`).
- **ffmpeg with `libsoxr`** on PATH. macOS Homebrew's `brew install ffmpeg`
  ships libsoxr by default; some Linux distro packages do not — verify with
  `ffmpeg -resamplers | grep soxr`.
- A **bidirectional MIDI path** to the Mirage (the host must receive the
  Mirage's ACKs, not just send to it).
- **MASOS V2** firmware booted on the Mirage. Stock Ensoniq OS won't work.

### From a clone (development)

```sh
git clone <repo-url> mirage_tools && cd mirage_tools/mirage-cli
npm install
npm run build
```

Run directly from the build output:

```sh
node dist/cli.js ports
```

Or symlink the shim onto your PATH:

```sh
ln -s "$PWD/bin/mirage-send" ~/.local/bin/mirage-send
```

### Global install (any directory)

From inside the `mirage-cli` directory after `npm run build`:

```sh
npm install -g .
```

That exposes `mirage-send` on your PATH globally. Run `mirage-send --help`
to verify.

### Platform notes

- **macOS (tested)**: CoreMIDI works out of the box.
- **Linux**: JZZ uses ALSA. You'll need `libasound2-dev` (or your distro's
  equivalent) at `npm install` time so the native bindings build. Untested.
- **Windows**: JZZ uses WinMM. Untested.
- **Apple Silicon vs Intel**: paths under `/opt/homebrew` vs `/usr/local`
  only matter if you're hardcoding them in scripts (e.g. macOS Shortcuts).
  The CLI itself uses whatever `node` is on PATH.

## Hardware prerequisites

Before any of this works, the Mirage must be:

1. Booted from a **MASOS** disk (the stock OS uses a different SysEx
   surface — `keypress` and most reads won't work).
2. Param `[83]` MIDI Thru-mode = `0`, otherwise MIDI OUT only echoes
   input and the Mirage never originates SysEx replies.
3. Param `[91]` External Computer Port Enable = `1`. Without this the
   Mirage will accept SysEx but never reply.
4. Connected via the **MIDI OUT** jack (not THRU), with the MRCC (or
   equivalent) routing Mirage→host on the same port you send on.

`mirage-send init` sets `[83]=0` and `[91]=1` for you (the Mirage's MIDI
params reset on power cycle). `mirage-send probe` then confirms
`param=91 value=1` end-to-end.

## Quick start

```sh
# 1. After each MASOS boot: prime the MIDI params.
mirage-send init

# 2. Verify connectivity.
mirage-send probe

# 3. Upload a sample to the lower half.
mirage-send send --slot lower1 my-sample.wav

# 3. Pitch a sample up 12 semitones to fit more material in the slot,
#    then play it 12 semitones lower on the keyboard to restore pitch.
mirage-send send -u 12 my-long-loop.wav

# 4. Reload disk Sound 2 into the upper half (wipes the SysEx upload).
mirage-send load upper 2
```

## `send` reference

```
mirage-send send [options] <wav-file>

  -s, --slot <slot>             upper1|upper2|upper3|lower1|lower2|lower3.
                                Only the half is honored today; the index is
                                reserved for future save-to-disk support.
                                Indices 2/3 require --allow-ram-only so
                                nobody silently thinks they targeted a disk
                                slot.
  --allow-ram-only              confirm that --slot {upper,lower}{2,3} should
                                write to live RAM only (disk slot N is left
                                untouched).
  -p, --port <name>             MIDI output port (default $MIRAGE_PORT or
                                "MRCC Port 04").
  -r, --rate <hz>               target playback sample rate. Default: as
                                high as fits, capped at 33 kHz.
  --truncate                    keep --rate; truncate the tail instead of
                                downsampling to fit.
  -u, --pitch-up <semitones>    pitch the sample up by 12, 24, or 36
                                semitones (1, 2, or 3 octaves only — [67]
                                tunes in whole octaves). The Mirage's [67]
                                rel_tuning_coarse is auto-set so C3 plays
                                back at the original pitch.
  --no-resample                 error instead of auto-downsampling when the
                                audio overflows the 64 KB slot.
  --no-pad                      skip padding short samples to the full slot.
                                Faster, but any audio left over in this
                                slot from a prior, longer upload will play
                                through after your sample ends.
  --no-auto-init                skip the [91]=1 / [83]=0 keypress prelude
                                that `send` runs before each upload.
  --ack-timeout <ms>            per-frame ACK wait (default 2000).
  --inter-packet-delay <ms>     minimum gap between frames (default 25).
  --mode <mode>                 abs (cmd 0x0C, verified) or wavesample
                                (cmd 0x06, experimental — does not ACK).
  -d, --dry-run                 write <wav>.syx and skip MIDI.
  -v, --verbose                 log progress.
```

The default upload path is **wavesample-absolute (cmd 0x0C)**. Each frame
sends 256 bytes of audio with explicit address. With ACK gating, a full
64 KB upload is 256 frames.

### Pitch-up math

`-u N` (where `N ∈ {12, 24, 36}`) resamples the source at `playbackRate /\n2^(N/12)`, so the audio compresses to fit (1, 2, or 3 octaves' worth of\nbytes saved). On the Mirage side, `[67] rel_tuning_coarse` is then\nauto-set to `3 - octaves` so that C3 plays the slot back at its **original\nduration and pitch**. Aliasing artifacts from the compression are\naudible and intentional \u2014 that's the creative point.\n\nThe `[67]` parameter only tunes in whole octaves and only upward (range\n0\u20137), which is why `-u` is restricted to multiples of 12 up to 36.

## Other commands

```
mirage-send ports
mirage-send init                               # [83]=0 + [91]=1
mirage-send probe [--param N] [--timeout MS] [--save reply.syx]
mirage-send load <upper|lower> <slot>          # = LOAD_UPPER/LOWER N ENTER
mirage-send keypress <keys...>                 # eg. "param 9 1 value"
mirage-send wsparam --half lower --ws 1 --param 70 --value 99
```

## Slots, RAM, and disk

The Mirage holds **one Upper + one Lower sound** in RAM at a time. The
three "slots" per side are **disk slots** — `Upper Sound 1/2/3` and
`Lower Sound 1/2/3` on the floppy. `mirage-send send` writes into RAM
only; to bake your upload into a disk slot you'd need the Mirage's
disk-save procedure (not yet exposed by this CLI). `mirage-send load`
pulls a disk slot back into RAM (and overwrites whatever was there).

## Protocol notes

The empirically verified facts (the manual is sometimes misleading) are
stored at `/memories/repo/mirage-protocol.md`. Three important gotchas:

- **End address is EXCLUSIVE for cmd 0x0C.** The ASG manual reads as if
  end is inclusive; the hardware NAKs unless we send `start + length`.
  Verified by a 6-variant hardware sweep — see `src/diag-dump.ts`.
- **RAM readback is validated per request.** `dump` sends one cmd 0x0B
  request per chunk of at most 16 bytes (the Mirage answers nothing above
  16) and accepts only a cmd 0x0C frame whose half, start and exclusive end
  address name that request, with an intact checksum and exactly the
  requested number of bytes. Frames for other requests, including late
  duplicates of an earlier chunk, are ignored without costing an attempt;
  a corrupted, truncated or missing reply is requested again, three
  requests in all; after that the transfer fails with the failing address
  and writes no file, so a partial capture cannot pass for a complete one.
  Whether the reply echoes the end address as exclusive or inclusive is
  not recorded from hardware, so both are accepted and the byte count is
  the integrity check. The logic
  lives in `src/readback.ts` and is tested against a simulated link in
  `test/readback.test.ts`.
- **0x00 is a playback-stop marker** in wavesample data. `ffmpeg`'s
  `pcm_u8` produces 0x00 freely for fully-negative samples. `audio.ts`
  clamps 0x00 → 0x01 before transmission and reports the count in
  `--verbose` mode.

## Tests

```sh
npm test
```

26 unit tests covering nybble codec, SysEx framing, address encoding,
checksum math, chunked uploads, ACK/NAK matchers, keypress framing,
wavesample-dump (cmd 0x06), and wavesample-parameter (cmd 0x0E).

## Layout

| File               | Responsibility                                 |
| ------------------ | ---------------------------------------------- |
| `src/cli.ts`       | commander entry point, subcommands, exit codes |
| `src/audio.ts`     | ffmpeg → 8-bit unsigned mono + 0x00 clamp      |
| `src/sysex.ts`     | SysEx builders (cmd 0x01, 0x06, 0x0C, 0x0E)    |
| `src/midi.ts`      | JZZ port enumeration, ACK-gated send loop      |
| `src/probe.ts`     | parameter-value round-trip probe               |
| `src/keys.ts`      | front-panel key byte codes + parser            |
| `src/constants.ts` | IDs, command bytes, slot encoding, defaults    |
| `src/readback.ts`  | validated RAM readback transaction (cmd 0x0B/0x0C) |
| `src/diag-dump.ts` | hardware diagnostic (6 cmd-0x0C variants)      |
| `test/`            | vitest unit tests                              |
| `bin/mirage-send`  | shebang shim that runs `dist/cli.js`           |

## Diagnostics

If `send` starts returning NAKs, run the diagnostic to confirm the cmd
0x0C wire format still ACKs:

```sh
npx tsx src/diag-dump.ts --all
```

V5 ("end address = start + len, EXCLUSIVE") is the canonical ACKing
variant on rackmount Mirage / MASOS V2.
