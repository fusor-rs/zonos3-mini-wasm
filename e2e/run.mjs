// End-to-end run in headless Chrome, in a fresh profile:
//
// 1. Open the page, keep its default voice (Rupert, by his recording) and text, and press Speak
//    while the model is still loading: the request is queued and runs the moment the model is
//    ready (measures page open → first audio). Checks: speech came out, nothing was requested
//    after the model was ready, and the WAV the page offers is intelligible (faster-whisper word
//    error rate).
// 2. Pick Willow by her speaker embedding and speak with the model warm (measures click → first
//    audio and the real-time factor): intelligible, no requests.
//    Then design her voice with a preset of the voice designer (steering) and speak again:
//    intelligible, no requests.
// 3. Drop a clip longer than the speaker encoder reads (Willow's clip in the checkpoint, looped
//    past 60 s) into the page and speak in it by its speaker embedding, with LACI on: the page
//    keeps its first 60 s, the reference's limit, and embeds them in the browser's memory
//    (records the time it took): intelligible, no requests.
// 4. Drop Willow's clip itself and speak in it by its codes, the page's default: the page
//    downloads the clip encoder then and encodes the clip (records the time it took):
//    intelligible, no requests but the encoder's. Both clip takes at the page's default seed.
// 5. Pick Rupert again, choose the full multi-resolution decoder, which the page downloads then,
//    and speak again.
// 6. Reload: the revisit must load every part from OPFS.
//
//   ASR_PYTHON=<python with faster-whisper> PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// The intelligibility check needs ASR_PYTHON, a Python with faster-whisper (scripts/asr_check.py);
// without it the run fails, unless --skip-asr says to accept a run without that check.
// Results (JSON, WAVs, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CASES = JSON.parse(readFileSync(join(ROOT, 'fixtures/cases.json'), 'utf8'));
const ENGLISH = CASES.reference_en.text;
const WILLOW = 'English/Willow_en-asrm_F_1';
const RUPERT = CASES.reference_en.voice;
const WILLOW_CLIP = join(ROOT, `.cache/checkpoint/gguf/voices/${WILLOW}.wav`);
// Whole loops of Willow's clip (24.9 s) past the 60 s the speaker encoder reads.
const CLIP_LOOPS = 3;
const MAX_WER = 0.15;
// The voice designer's preset of the steered take.
const PRESET = 'Chatty podcaster';
const values = flags({ 'skip-asr': { type: 'boolean', default: false } });
const ASR_PYTHON = process.env.ASR_PYTHON;
const DEADLINE_MS = 10 * 60 * 1000;

// The page's state machine is `main[data-phase]`: loading, ready, generating, broken.
const settled = () => /^(ready|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const finished = () => /^(Done|stopped|error)/.test(document.getElementById('status')?.textContent ?? '');
const heard = () => /\d/.test(document.getElementById('heard')?.textContent ?? '');
const playedOut = () => document.querySelector('.live')?.dataset.playing === 'false';

/** The live metric tiles, as the page shows them. */
async function metrics(page) {
  const tiles = ['load', 'heard', 'rtf', 'requests'];
  const texts = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const notes = await page.$$eval('.metrics dd.muted', (nodes) => nodes.map((node) => node.textContent));
  const status = await page.textContent('#status');
  return { ...Object.fromEntries(tiles.map((id, i) => [id, texts[i]])), notes, status };
}

/** Saves the WAV the page offers to `path`; returns its size in bytes. */
async function saveWav(page, path) {
  const base64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(document.getElementById('download').href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return Buffer.from(base64, 'base64').length;
}

/** Saves the take `name` once played: its WAV and a screenshot; returns the WAV's path. */
async function keep({ page, runDir, check }, name) {
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  await page.screenshot({ path: join(runDir, `${STAMP}-${name}.png`), fullPage: true });
  const wav = join(runDir, `${STAMP}-${name}.wav`);
  const bytes = await saveWav(page, wav);
  check(bytes > 44 + 88200, `${name}: WAV ${(bytes / 1e6).toFixed(2)} MB -> ${wav}`);
  return wav;
}

/** The transcript of `wav` and its word error rate, as `scripts/asr_check.py` prints them. */
function transcribe(wav) {
  const out = execFileSync(ASR_PYTHON, [join(ROOT, 'scripts/asr_check.py'), '--text', ENGLISH, wav], { encoding: 'utf8' });
  return out.trim().split('\n').at(-1);
}

/** Checks that the take `name` in `wav` is intelligible, when ASR is on. */
function checkWords({ results, check }, name, wav) {
  if (!ASR_PYTHON) {
    results[`${name}Asr`] = 'not checked';
    return check(values['skip-asr'], 'ASR not checked: set ASR_PYTHON to a Python with faster-whisper, or pass --skip-asr');
  }
  const line = transcribe(wav);
  results[`${name}Asr`] = line;
  check(Number(/WER=([\d.]+)/.exec(line)[1]) <= MAX_WER, `${name}: ASR ${line}`);
}

/** `path`, a WAV file of `wav`'s format holding its samples `loops` times over. */
function loopWav(wav, loops, path) {
  const bytes = readFileSync(wav);
  let at = 12;
  while (bytes.toString('ascii', at, at + 4) !== 'data') at += 8 + bytes.readUInt32LE(at + 4);
  const data = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at + 4));
  const header = Buffer.from(bytes.subarray(0, at + 8));
  header.writeUInt32LE(header.length - 8 + data.length * loops, 4);
  header.writeUInt32LE(data.length * loops, at + 4);
  writeFileSync(path, Buffer.concat([header, ...Array(loops).fill(data)]));
  return path;
}

/** The clip encoder's own fetches: its worker, the runtime it starts and its bundle. */
const encoderRequest = (url) => /\/engine\/(encoder\.js|dist\/)|\/model\/encoder\//.test(url);

/** Clicks Speak, waits for the take `name` to finish and checks it: speech out, nothing fetched
 *  but what `allowed` (a URL predicate) lets through. */
async function speak(context, name, allowed) {
  const { page, requests, results, check } = context;
  const requestsBefore = requests.length;
  await page.click('#generate');
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  const spoken = await metrics(page);
  spoken.requestsDuringSynthesis = fetched(requests, requestsBefore);
  results[name] = spoken;
  check(spoken.status.startsWith('Done'), `${name}: first audio ${spoken.heard} (${spoken.notes[1]}), RTF ${spoken.rtf}, ${spoken.status}`);
  const unexpected = spoken.requestsDuringSynthesis.filter((url) => !allowed?.(url));
  const counted = allowed ? '' : `, page counts ${spoken.requests}`;
  check(unexpected.length === 0 && (allowed || spoken.requests === '0'), `${name}: requests during synthesis: ${spoken.requestsDuringSynthesis.length} seen, ${unexpected.length} unexpected${counted}`);
  return keep(context, name);
}

/** Speaks the take `name` and checks it, its words included. */
async function checkSpeech(context, name, allowed) {
  checkWords(context, name, await speak(context, name, allowed));
}

await run({ root: ROOT, name: 'zonos3-mini', values }, async (context) => {
  const { page, base, query, results, check, revisit } = context;
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
  results.queuedAt = await page.getAttribute('main', 'data-phase');
  await page.click('#generate');
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.openToFirstAudioMs = Date.now() - t0;
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.runtime = await page.textContent('#runtime');
  results.cold = await metrics(page);
  check(results.cold.status.startsWith('Done'), `queued run (clicked while ${results.queuedAt}): page open to first audio ${results.openToFirstAudioMs} ms, load ${results.cold.load}; ${results.runtime}`);
  check(results.cold.requests === '0', `requests after the model was ready: page counts ${results.cold.requests}`);
  checkWords(context, 'cold', await keep(context, 'cold'));

  await page.click(`[data-voice="${WILLOW}"]`);
  await page.selectOption('#mode', 'embedding');
  await checkSpeech(context, 'warm');

  await page.click('.designer summary');
  await page.click(`.designer button:has-text("${PRESET}")`);
  await checkSpeech(context, 'steered');
  await page.click('#design-reset');

  await page.setInputFiles('#voice-file', loopWav(WILLOW_CLIP, CLIP_LOOPS, join(context.runDir, `${STAMP}-long-clip.wav`)));
  await page.waitForSelector('[data-voice="clip"][aria-pressed="true"]');
  results.longClip = await page.textContent('[data-voice="clip"]');
  results.longClipNote = await page.textContent('#clip-note');
  await page.selectOption('#clip-mode', 'embedding');
  await page.check('#laci');
  await checkSpeech(context, 'long');
  results.long.embed = await page.textContent('#heard-note');
  check(/embedding the clip/.test(results.long.embed), `long: ${results.longClip} (${results.longClipNote}), ${results.long.embed}`);

  await page.uncheck('#laci');
  await page.setInputFiles('#voice-file', WILLOW_CLIP);
  await page.waitForFunction(() => /^$/.test(document.getElementById('clip-note')?.textContent ?? 'x'));
  results.clipVoice = await page.textContent('[data-voice="clip"]');
  await page.selectOption('#clip-mode', 'codes');
  await checkSpeech(context, 'clip', encoderRequest);
  results.clip.encode = await page.textContent('#heard-note');
  check(/encoding the clip/.test(results.clip.encode), `clip: ${results.clipVoice}, ${results.clip.encode}`);

  await page.click(`[data-voice="${RUPERT}"]`);
  await page.selectOption('#mode', 'reference');
  await page.selectOption('#decoder', 'full_mr');
  await page.waitForSelector('main[data-phase="loading"]');
  await page.waitForFunction(settled, null, { timeout: DEADLINE_MS });
  await checkSpeech(context, 'full');

  await revisit(settled, DEADLINE_MS);
});
