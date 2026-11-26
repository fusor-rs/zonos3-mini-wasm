// Runs a single-threaded wasm runtime build in Node against the bundles: pushes every part the way
// the browser loader does, into the speech runtime (`speech/`) and the decoder runtime of the
// case's decoder (`codec/` or `codec-full/`), speaks a case of `fixtures/cases.json` in its
// default voice (by its recording, or by its embedding) as the page does, and prints the load
// time, the real-time factor and the time to the first audio; optionally writes the WAV.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--case reference_en] [--out out.wav]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    case: { type: 'string', default: 'reference_en' },
    out: { type: 'string' },
  },
});
const model = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('zonos3_mini_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('zonos3_mini_runtime_bg.wasm', dist)) });

const CHUNK = 8 << 20;
// Each decoder's bundle directory.
const DECODERS = { keep2_plain: 'codec', full_mr: 'codec-full' };
// How a case's default voice speaks: by its recording or by its embedding.
const SPEAKER_MODES = { codes: 'reference', embedding: 'embedding' };

/** The runtime `Class` with every part of the bundle in `directory` pushed into it. */
function loadBundle(Class, directory) {
  const bundle = join(model, directory);
  const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const runtime = new Class(manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundle, part.file));
    for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${directory}: engine not ready after every part`);
  return runtime;
}

const cases = JSON.parse(readFileSync(new URL('../fixtures/cases.json', import.meta.url), 'utf8'));
const fixture = cases[values.case];
const mode = SPEAKER_MODES[fixture.speaker];
if (!mode) throw new Error(`${values.case}: a case cloning a clip runs in the page`);

const t0 = performance.now();
const speech = loadBundle(glue.SpeechRuntime, 'speech');
const decoder = loadBundle(glue.DecoderRuntime, DECODERS[fixture.decoder]);
const loadMs = performance.now() - t0;

const request = {
  text: fixture.text,
  seed: fixture.seed,
  speaker: { kind: 'default', id: fixture.voice, mode },
  condition_buckets: fixture.condition_buckets ?? {},
  speaker_cfg_scale: fixture.speaker_cfg_scale ?? 1,
};
const t1 = performance.now();
const plan = JSON.parse(speech.start(JSON.stringify(request), new Float32Array(0), 0));
decoder.start('{}', plan.leading_frames);
const chunks = [];
let firstAudioMs = null;
let progress;
do {
  progress = JSON.parse(speech.step());
  const samples = decoder.decode(speech.frames());
  if (samples.length) {
    chunks.push(samples);
    firstAudioMs ??= performance.now() - t1;
  }
} while (!progress.done);
chunks.push(decoder.finish());
const genMs = performance.now() - t1;

const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
let offset = 0;
for (const chunk of chunks) {
  samples.set(chunk, offset);
  offset += chunk.length;
}
const seconds = samples.length / glue.sample_rate();
const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
console.log(`${values.build}: load ${(loadMs / 1000).toFixed(2)}s, ${values.case} (${fixture.decoder}) ${progress.rows} rows, ${seconds.toFixed(2)}s audio (peak ${peak.toFixed(3)}) in ${(genMs / 1000).toFixed(2)}s: RTF ${(genMs / 1000 / seconds).toFixed(3)}, first audio ${firstAudioMs.toFixed(0)} ms`);

if (values.out) {
  writeFileSync(values.out, glue.wav(samples));
  console.log(`wrote ${values.out}`);
}
