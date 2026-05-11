import { execa } from 'execa';
import { stat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Convert an arbitrary audio file (typically WAV) to 8-bit unsigned mono raw
 * PCM at the given sample rate.
 *
 * Shells out to ffmpeg. Returns the raw byte buffer. Size policy (truncation,
 * rate-fitting, etc.) is the caller's responsibility.
 *
 * @throws if ffmpeg is missing or the input is unreadable.
 */
export async function convertToMirageRaw(
  inputPath: string,
  rateHz: number
): Promise<Uint8Array> {
  await assertFfmpegAvailable();

  const inputStat = await stat(inputPath).catch(() => {
    throw new Error(`Input file not found: ${inputPath}`);
  });
  if (!inputStat.isFile()) {
    throw new Error(`Not a file: ${inputPath}`);
  }

  const work = await mkdtemp(join(tmpdir(), 'mirage-'));
  const outPath = join(work, 'out.raw');

  try {
    // -ac 1                      : mono
    // -ar N                      : target sample rate
    // -af aresample=resampler=soxr:precision=28
    //                            : high-quality polyphase resampling (~28-bit
    //                              precision FIR, ~140 dB stopband). Far less
    //                              aliasing than ffmpeg's default `swr` engine,
    //                              which matters a lot when crunching down to
    //                              8-bit at 10-33 kHz.
    // -dither_method triangular  : TPDF dither at the 8-bit quantization step
    // -acodec pcm_u8 -f u8       : 8-bit unsigned raw, which is what the Mirage
    //                              wants (its DAC is 8-bit unsigned).
    await execa('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-af',
      'aresample=resampler=soxr:precision=28',
      '-ar',
      String(rateHz),
      '-dither_method',
      'triangular',
      '-acodec',
      'pcm_u8',
      '-f',
      'u8',
      outPath,
    ]);

    const buf = await readFile(outPath);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    // Per ASG §"SAMPLE DATA FORMAT": the Mirage reserves 0x00 as a stop
    // marker — the oscillator halts playback at any 0x00 byte. ffmpeg's
    // pcm_u8 output regularly produces 0x00 for full-negative samples and
    // for dither noise near the negative rail, which would silently
    // truncate playback. Clamp 0x00 → 0x01 (the most-negative legal value).
    let stops = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x00) {
        bytes[i] = 0x01;
        stops++;
      }
    }
    if (stops > 0) {
      // Stash the count on the buffer for the CLI to report.
      (bytes as Uint8Array & { stopsClamped?: number }).stopsClamped = stops;
    }

    return bytes;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execa('ffmpeg', ['-version']);
  } catch {
    throw new Error(
      'ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`).'
    );
  }
}
