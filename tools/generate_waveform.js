#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function printUsage() {
  console.log(`Usage:
  node tools/generate_waveform.js --input <audio.mp3> --output <waveform.json> [options]
  node tools/generate_waveform.js --song <song title> [--songs-dir <dir>] [--output <waveform.json>] [options]

Options:
  --song <title>      Song title to match against mp3 filename in songs folder
  --songs-dir <dir>   Songs folder (default: auto-discover folder named songs)
  --points <n>        Number of waveform points (default: 1200)
  --sample-rate <hz>  Decode sample rate for analysis (default: 22050)
  --smoothing <n>     Moving average window on final points (default: 3)
  --help              Show this help
`);
}

function parseArgs(argv) {
  const opts = {
    points: 1200,
    sampleRate: 22050,
    smoothing: 3,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      throw new Error(`Unexpected argument: ${a}`);
    }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val == null || val.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;

    if (key === 'input') opts.input = val;
    else if (key === 'output') opts.output = val;
    else if (key === 'song') opts.song = val;
    else if (key === 'songs-dir') opts.songsDir = val;
    else if (key === 'points') opts.points = Number(val);
    else if (key === 'sample-rate') opts.sampleRate = Number(val);
    else if (key === 'smoothing') opts.smoothing = Number(val);
    else throw new Error(`Unknown option: --${key}`);
  }

  return opts;
}

function walkDirs(root, maxDepth = 4) {
  const out = [];

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      out.push(full);
      visit(full, depth + 1);
    }
  }

  visit(root, 0);
  return out;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(s) {
  const n = normalizeText(s);
  return n.replace(/\s+/g, '_') || 'waveform';
}

function tokenScore(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return -1;
  if (q === c) return 1000;
  if (c.includes(q)) return 900;
  if (q.includes(c)) return 850;

  const qTokens = new Set(q.split(' ').filter(Boolean));
  const cTokens = new Set(c.split(' ').filter(Boolean));
  let common = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) common += 1;
  }
  return common;
}

function findSongsDir(explicitDir) {
  if (explicitDir) {
    const d = path.resolve(explicitDir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
      throw new Error(`songs directory not found: ${d}`);
    }
    return d;
  }

  const cwd = process.cwd();
  const direct = path.join(cwd, 'songs');
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    return direct;
  }

  const allDirs = walkDirs(cwd, 4);
  const hit = allDirs.find((d) => path.basename(d).toLowerCase() === 'songs');
  if (hit) return hit;

  throw new Error('Could not auto-discover a songs folder. Use --songs-dir <dir>.');
}

function findSongFileByTitle(songTitle, songsDir) {
  const files = fs.readdirSync(songsDir)
    .filter((f) => /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(f));

  if (!files.length) {
    throw new Error(`No audio files found in songs directory: ${songsDir}`);
  }

  let bestFile = null;
  let bestScore = -1;

  for (const f of files) {
    const score = tokenScore(songTitle, f);
    if (score > bestScore) {
      bestScore = score;
      bestFile = f;
    }
  }

  if (!bestFile || bestScore <= 0) {
    throw new Error(`Could not find a matching audio file for song title "${songTitle}" in ${songsDir}`);
  }

  return path.join(songsDir, bestFile);
}

function hasTool(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const out = spawnSync(cmd, [name], { encoding: 'utf8' });
  return out.status === 0;
}

function getDurationSeconds(inputPath) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ], { encoding: 'utf8' });

  if (probe.status !== 0) {
    throw new Error(`ffprobe failed: ${probe.stderr || probe.stdout || 'unknown error'}`);
  }

  const duration = Number((probe.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read valid duration from ffprobe output: ${probe.stdout}`);
  }

  return duration;
}

function decodeMonoFloat32(inputPath, sampleRate) {
  const ff = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', inputPath,
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    '-',
  ], {
    encoding: null,
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (ff.status !== 0) {
    const stderr = ff.stderr ? Buffer.from(ff.stderr).toString('utf8') : '';
    throw new Error(`ffmpeg failed: ${stderr || 'unknown error'}`);
  }

  if (!ff.stdout || ff.stdout.length < 4) {
    throw new Error('ffmpeg returned empty audio stream.');
  }

  return new Float32Array(ff.stdout.buffer, ff.stdout.byteOffset, Math.floor(ff.stdout.byteLength / 4));
}

function parseWavToMonoFloat32(buffer) {
  if (buffer.length < 44) {
    throw new Error('WAV file too small to parse.');
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV header.');
  }

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let off = 12;

  while (off + 8 <= buffer.length) {
    const id = buffer.toString('ascii', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const chunkStart = off + 8;

    if (chunkStart + size > buffer.length) break;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (id === 'data') {
      dataOffset = chunkStart;
      dataSize = size;
      break;
    }

    off = chunkStart + size + (size % 2);
  }

  if (!fmt || dataOffset < 0 || dataSize <= 0) {
    throw new Error('Could not locate WAV fmt/data chunks.');
  }

  const channels = Math.max(1, fmt.channels);
  const bytesPerSample = Math.max(1, Math.floor(fmt.bitsPerSample / 8));
  const frameBytes = channels * bytesPerSample;
  const frames = Math.floor(dataSize / frameBytes);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i += 1) {
    const framePos = dataOffset + i * frameBytes;

    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const p = framePos + ch * bytesPerSample;

      let v = 0;
      if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
        v = buffer.readInt16LE(p) / 32768;
      } else if (fmt.audioFormat === 1 && fmt.bitsPerSample === 24) {
        const b0 = buffer[p];
        const b1 = buffer[p + 1];
        const b2 = buffer[p + 2];
        let int24 = b0 | (b1 << 8) | (b2 << 16);
        if (int24 & 0x800000) int24 |= 0xff000000;
        v = int24 / 8388608;
      } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        v = buffer.readFloatLE(p);
      } else {
        throw new Error(`Unsupported WAV format: format=${fmt.audioFormat}, bits=${fmt.bitsPerSample}`);
      }

      sum += v;
    }

    out[i] = sum / channels;
  }

  return { samples: out, sampleRate: fmt.sampleRate };
}

function decodeMonoFloat32ViaAfconvert(inputPath, sampleRateHint) {
  const tmp = path.join(os.tmpdir(), `waveform-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const args = ['-f', 'WAVE', '-d', 'LEI16', '-c', '1'];

  if (Number.isFinite(sampleRateHint) && sampleRateHint > 0) {
    args.push('-r', String(Math.floor(sampleRateHint)));
  }

  args.push(inputPath, tmp);
  const conv = spawnSync('afconvert', args, { encoding: 'utf8' });
  if (conv.status !== 0) {
    throw new Error(`afconvert failed: ${conv.stderr || conv.stdout || 'unknown error'}`);
  }

  try {
    const wav = fs.readFileSync(tmp);
    return parseWavToMonoFloat32(wav);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // Ignore temp cleanup failures.
    }
  }
}

function movingAverage(arr, radius) {
  if (radius <= 0) return arr.slice();
  const out = new Array(arr.length).fill(0);
  for (let i = 0; i < arr.length; i += 1) {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - radius);
    const end = Math.min(arr.length - 1, i + radius);
    for (let j = start; j <= end; j += 1) {
      sum += arr[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : arr[i];
  }
  return out;
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function buildWaveform(samples, points, smoothingRadius) {
  const n = Math.max(10, Math.floor(points));
  const perBucket = samples.length / n;
  const amps = new Array(n).fill(0);
  const mins = new Array(n).fill(0);
  const maxs = new Array(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(i * perBucket);
    const end = Math.min(samples.length, Math.floor((i + 1) * perBucket));

    if (end <= start) continue;

    let sumSq = 0;
    let minV = 1;
    let maxV = -1;
    for (let j = start; j < end; j += 1) {
      const v = samples[j];
      sumSq += v * v;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    amps[i] = rms;
    mins[i] = minV;
    maxs[i] = maxV;
  }

  const smoothed = movingAverage(amps, Math.max(0, Math.floor(smoothingRadius)));
  const p95 = percentile(smoothed, 95) || 1;
  const scale = p95 > 0 ? p95 : 1;

  const amplitudes = smoothed.map((v) => {
    const norm = v / scale;
    return Math.max(0, Math.min(1, norm));
  });

  const peakAbs = [];
  for (let i = 0; i < n; i += 1) {
    peakAbs.push(Math.abs(mins[i]));
    peakAbs.push(Math.abs(maxs[i]));
  }
  const peakScale = Math.max(1e-6, percentile(peakAbs, 99));
  const peakMins = mins.map((v) => Math.max(-1, Math.min(1, v / peakScale)));
  const peakMaxs = maxs.map((v) => Math.max(-1, Math.min(1, v / peakScale)));

  return { amplitudes, peakMins, peakMaxs };
}

function main() {
  try {
    const opts = parseArgs(process.argv);
    if (opts.help) {
      printUsage();
      process.exit(0);
    }

    if (!opts.input && !opts.song) {
      printUsage();
      throw new Error('Provide either --input <audio> or --song <title>.');
    }

    let inputPath;
    let outputPath;

    if (opts.input) {
      inputPath = path.resolve(opts.input);
    } else {
      const songsDir = findSongsDir(opts.songsDir);
      inputPath = findSongFileByTitle(opts.song, songsDir);
      console.log(`Matched song file: ${inputPath}`);
    }

    if (opts.output) {
      outputPath = path.resolve(opts.output);
    } else {
      const outName = `${slugify(opts.song || path.basename(inputPath, path.extname(inputPath)))}.waveform.json`;
      const baseDir = opts.songsDir ? path.resolve(opts.songsDir) : path.dirname(inputPath);
      outputPath = path.join(baseDir, outName);
    }

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const hasFfmpeg = hasTool('ffmpeg') && hasTool('ffprobe');
    const hasAfconvert = hasTool('afconvert');

    let samples;
    let sampleRateUsed = opts.sampleRate;
    let duration;
    let decoder;

    if (hasFfmpeg) {
      decoder = 'ffmpeg';
      duration = getDurationSeconds(inputPath);
      samples = decodeMonoFloat32(inputPath, opts.sampleRate);
    } else if (process.platform === 'darwin' && hasAfconvert) {
      decoder = 'afconvert';
      const decoded = decodeMonoFloat32ViaAfconvert(inputPath, opts.sampleRate);
      samples = decoded.samples;
      sampleRateUsed = decoded.sampleRate;
      duration = samples.length / Math.max(1, sampleRateUsed);
    } else {
      throw new Error('No supported decoder found. Install ffmpeg/ffprobe, or on macOS ensure afconvert is available.');
    }

    const waveform = buildWaveform(samples, opts.points, opts.smoothing);
    const amplitudes = waveform.amplitudes;

    const payload = {
      source: path.basename(inputPath),
      generatedAt: new Date().toISOString(),
      decoder,
      duration,
      sampleRate: sampleRateUsed,
      points: amplitudes.length,
      amplitudes,
      mins: waveform.peakMins,
      maxs: waveform.peakMaxs,
      times: amplitudes.map((_, i) => (i / Math.max(1, amplitudes.length - 1)) * duration),
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

    console.log(`Waveform written: ${outputPath}`);
    console.log(`Duration: ${duration.toFixed(2)}s, Points: ${amplitudes.length}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
