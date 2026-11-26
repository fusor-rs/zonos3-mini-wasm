import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';
import { Waveform } from './waveform.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// workers (the language model's, the decoder's of the chosen decoder, and while a clip is encoded
// the clip encoder's, each with its own memory) and, in threaded builds, their compute workers
// (fusor-ai's ComputePool), the audio worklet (engine/playback.js), and the voice clip, decoded in
// this page and sent with each request that clones it by its embedding, or encoded once into the
// codes each request that clones it by its codes reads. The speech worker hands each take's frames to the decoder worker, which
// hands the samples to the worklet: neither waits for the page. It measures each take and reports
// back with `engine` events, at most once per animation frame.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine workers), at most 8, shared out
// between the two engine workers, which run at the same time; `?threads=1` forces the
// single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
const SPEECH_THREADS = Math.max(1, Math.floor(THREADS / 2));
const DECODER_THREADS = Math.max(1, THREADS - SPEECH_THREADS);
// The bundles served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// others, `?build=web-single` pins a runtime build.
// A Hugging Face Space holds at most 1 GB, so the Space loads the bundles from the model repo
// fusorlabs/zonos3-mini-web (`just deploy-model`) instead of from beside the page.
const HOSTED_MODEL = 'https://huggingface.co/fusorlabs/zonos3-mini-web/resolve/main/';
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? HOSTED_MODEL : 'model/';
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;
// Each decoder's bundle directory.
const DECODERS = { keep2_plain: 'codec', full_mr: 'codec-full' };
// Bars of the voice clip's waveform.
const VOICE_PEAKS = 240;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const waveform = new Waveform(root, '#wave');
  const voiceWaveform = new Waveform(root, '#voice-wave');
  const workers = { speech: null, decoder: null, encoder: null };
  let notice = '';
  let loaded = false;
  let broken = false;
  let sampleRate = null;
  // The speech worker's `catalog`: its limits, voices, LACI languages and voice designer.
  let catalog = null;
  let audio = null;
  let jobs = 0;
  let job = null;
  let reportScheduled = false;
  let wavUrl = null;
  let requestsAtReady = 0;
  // The voice clip to clone, mono at `clip.rate` Hz, and the promise of its codes once asked for.
  let clip = null;
  // The clip being encoded: its job and its codes' promise's settlers.
  let encoding = null;

  const handlers = {
    speech: {
      step: (message) => {
        if (message.job !== job?.id) return;
        job.speech = message;
        if (message.stage === 'embed') job.embedMs = message.speechMs;
        scheduleProgress();
      },
      spoken: (message) => {
        if (message.job !== job?.id) return;
        job.speech = message;
      },
    },
    encoder: {
      progress: ({ done, total }) => status(`downloading the clip encoder · ${mb(done)} / ${mb(total)}`),
      ready: () => {
        const samples = clip.samples.slice();
        workers.encoder.worker.postMessage({ type: 'encode', job: encoding.job, clip: samples, clipRate: clip.rate }, [samples.buffer]);
      },
      encoding: ({ steps, total }) => status(`encoding the clip · step ${steps} of ${total}`),
      encoded: ({ codes, encodeMs }) => {
        encoding.resolve({ codes, encodeMs });
        endEncoder();
      },
      error: ({ message }) => failEncoding(message),
      fatal: ({ message }) => failEncoding(message),
    },
    decoder: {
      audio: (message) => {
        if (message.job !== job?.id) return;
        job.samples = message.samples;
        waveform.push(message.peaks);
        scheduleProgress();
      },
      done: (message) => finish(message),
    },
  };

  /** Starts the worker `name` on the bundle `directory`. */
  function start(name, directory, threads) {
    const worker = new Worker(new URL(`engine/${name}.js`, document.baseURI), { type: 'module', name: `zonos3-mini-${directory}` });
    const pool = new ComputePool(crash);
    const bundle = { worker, pool, directory, build: null, progress: { done: 0, total: 0, network: 0, cache: 0 }, ready: null };
    const routes = {
      [SPAWN_COMPUTE]: (message) => pool.spawn(message),
      runtime: (message) => {
        bundle.build = message;
        if (!message.sampleRate) return;
        sampleRate = message.sampleRate;
        // Built now, suspended until a click resumes it: the first take does not wait for the
        // context and the worklet module.
        if (audio) audio.then(({ node }) => connectWorklet(node));
        else audioOutput();
      },
      warning: ({ message }) => {
        console.warn(message);
        notice = ` (${message})`;
      },
      progress: (message) => {
        bundle.progress = message;
        reportLoading();
      },
      ready: (message) => {
        bundle.ready = message;
        if (message.catalog) catalog = message.catalog;
        if (!loaded && workers.speech?.ready && workers.decoder?.ready) ready();
      },
      error: ({ message }) => {
        if (!loaded) return fail(message);
        report({ type: 'error', message });
      },
      fatal: ({ message }) => fail(message),
      ...handlers[name],
    };
    worker.onmessage = ({ data }) => {
      if (!broken) routes[data.type]?.(data);
    };
    worker.onerror = (event) => crash(event.message || 'an engine worker failed');
    worker.postMessage({ type: 'load', modelUrl: new URL(`${directory}/`, MODEL_URL).href, threads, build: params.get('build'), variant: directory });
    workers[name] = bundle;
  }

  /** Loads `decoder`, ending the decoder loaded before, and wires it to the speech worker and the worklet. */
  function selectDecoder(decoder) {
    const directory = DECODERS[decoder];
    if (workers.decoder?.directory === directory) return;
    workers.decoder?.worker.terminate();
    workers.decoder?.pool.terminate();
    loaded = false;
    start('decoder', directory, DECODER_THREADS);
    const channel = new MessageChannel();
    workers.speech.worker.postMessage({ type: 'decoder', port: channel.port1 }, [channel.port1]);
    workers.decoder.worker.postMessage({ type: 'speech', port: channel.port2 }, [channel.port2]);
    // A subscription callback runs inside Rust's update: report once it has returned.
    queueMicrotask(reportLoading);
  }

  function reportLoading() {
    if (loaded) return;
    const bundles = [workers.speech, workers.decoder].filter(Boolean);
    const [done, size, network, cache] = ['done', 'total', 'network', 'cache'].map((key) => bundles.reduce((sum, bundle) => sum + bundle.progress[key], 0));
    const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
    report({ type: 'loading', fraction: size ? done / size : 0, detail: `${mb(done)} / ${mb(size)} · ${source}` });
  }

  function ready() {
    loaded = true;
    requestsAtReady = performance.getEntriesByType('resource').length;
    const bundles = [workers.speech, workers.decoder];
    const bundleBytes = bundles.reduce((sum, bundle) => sum + bundle.ready.total, 0);
    const cached = bundles.reduce((sum, bundle) => sum + bundle.ready.cache, 0);
    const loadedInfo = {
      build: `${workers.speech.build.build}${notice}`,
      threads: THREADS,
      bundle_bytes: bundleBytes,
      load_ms: Math.max(...bundles.map((bundle) => bundle.ready.ms)),
      from_device: cached === bundleBytes,
    };
    report({ type: 'ready', ...catalog, loaded: loadedInfo });
  }

  /** The audio output, built once: a context at the decoder's rate and the playback worklet. */
  function audioOutput() {
    audio ??= (async () => {
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('engine/playback.js', document.baseURI));
      const node = new AudioWorkletNode(context, 'zonos3-mini-playback', { outputChannelCount: [1] });
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => playbackEvent(data);
      connectWorklet(node);
      return { context, node };
    })();
    return audio;
  }

  /** Gives the decoder worker a port straight to the worklet. */
  function connectWorklet(node) {
    const channel = new MessageChannel();
    node.port.postMessage({ type: 'engine', port: channel.port1 }, [channel.port1]);
    workers.decoder.worker.postMessage({ type: 'audio', port: channel.port2 }, [channel.port2]);
  }

  /** A click that may start audio: resume the output inside its user activation. */
  function resumeAudio() {
    audio
      ?.then(({ context }) => context.resume())
      .catch(() => {}); // a failed output is reported by the take that needs it
  }

  /** The clip's codes and the time they took, from the encoder worker, started for them. */
  function encodeClip(current) {
    clip.codes ??= new Promise((resolve, reject) => {
      encoding = { job: current.id, resolve, reject };
      start('encoder', 'encoder', THREADS);
    });
    return clip.codes;
  }

  function endEncoder() {
    workers.encoder?.worker.terminate();
    workers.encoder?.pool.terminate();
    workers.encoder = null;
    encoding = null;
  }

  /** The encoding failed or was stopped: the clip is encoded afresh next time. */
  function failEncoding(message) {
    encoding?.reject(new Error(message));
    if (clip) clip.codes = null;
    endEncoder();
  }

  /** A progress line while the take has no audio yet. */
  function status(text) {
    if (!job || job.done) return;
    job.wallMs = performance.now() - job.t0;
    report({ type: 'progress', status: text, metrics: metrics() });
  }

  /** Uses the audio file `blob` as the voice clip, its first `max_clip_seconds`. */
  async function useClip(blob) {
    try {
      const context = new OfflineAudioContext(1, 1, sampleRate ?? 44100);
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const samples = mono(decoded);
      const most = catalog ? Math.floor(catalog.limits.max_clip_seconds * decoded.sampleRate) : samples.length;
      clip = { samples: samples.subarray(0, Math.min(samples.length, most)), rate: decoded.sampleRate, codes: null };
      const trimmed = clip.samples.length < samples.length;
      voiceWaveform.reset();
      voiceWaveform.push(peaksOf(clip.samples, VOICE_PEAKS));
      voiceWaveform.play(1);
      report({ type: 'clip', seconds: clip.samples.length / clip.rate, note: trimmed ? `Trimmed to the first ${catalog.limits.max_clip_seconds} s.` : '' });
    } catch (error) {
      report({ type: 'clip', seconds: clip ? clip.samples.length / clip.rate : 0, note: `Could not read that audio (${error?.message ?? error}).` });
    }
  }

  const onChange = ({ target }) => {
    if (target.id !== 'voice-file' || !target.files[0]) return;
    useClip(target.files[0]);
    target.value = '';
  };
  const onDrag = (event) => {
    event.preventDefault();
    root.querySelector('.dropzone')?.setAttribute('data-over', event.type === 'dragover');
  };
  const onDrop = (event) => {
    onDrag(event);
    root.querySelector('.dropzone')?.setAttribute('data-over', false);
    if (event.dataTransfer.files[0]) useClip(event.dataTransfer.files[0]);
  };
  root.addEventListener('change', onChange);
  root.addEventListener('dragover', onDrag);
  root.addEventListener('dragleave', onDrag);
  root.addEventListener('drop', onDrop);

  /** Runs the request the page holds, timed from now (the click, or the model being ready). */
  async function dispatch() {
    job = { id: ++jobs, t0: performance.now(), heardMs: null, embedMs: null, encodeMs: null, wallMs: 0, speech: null, samples: 0, decoder: null, done: false, stopped: false };
    const current = job;
    waveform.reset();
    try {
      const { context } = await audioOutput();
      await context.resume();
    } catch (error) {
      audio = null;
      report({ type: 'error', message: `no audio output (${error?.message ?? error})` });
      return;
    }
    if (current.stopped) {
      report({ type: 'done', status: 'stopped', audio: null, metrics: metrics() });
      report({ type: 'played' });
      return;
    }
    const request = JSON.parse(inputs.request.get());
    if (request.speaker.kind === 'codes') {
      try {
        const fresh = !clip.codes;
        const { codes, encodeMs } = await encodeClip(current);
        request.speaker.frames = Array.from({ length: codes.length / 10 }, (_, frame) => Array.from(codes.subarray(frame * 10, frame * 10 + 10)));
        if (fresh) current.encodeMs = encodeMs;
      } catch (error) {
        report({ type: 'error', message: `the clip could not be encoded (${error?.message ?? error})` });
        return;
      }
      if (current.stopped) {
        report({ type: 'done', status: 'stopped', audio: null, metrics: metrics() });
        report({ type: 'played' });
        return;
      }
    }
    const clones = request.speaker.kind === 'clip';
    const samples = clones ? clip.samples.slice() : new Float32Array(0);
    workers.speech.worker.postMessage({ type: 'generate', job: current.id, request: JSON.stringify(request), clip: samples, clipRate: clones ? clip.rate : 0 }, [samples.buffer]);
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    if (encoding?.job === job.id) failEncoding('stopped');
    workers.speech.worker.postMessage({ type: 'stop', job: job.id });
    const id = job.id;
    audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: id }));
  }

  function playbackEvent({ type, job: id, rendered }) {
    if (id !== job?.id) return;
    if (type === 'started') {
      job.heardMs = performance.now() - job.t0;
      scheduleProgress();
    } else if (type === 'position') {
      waveform.play(rendered / Math.max(1, job.samples));
    } else if (type === 'drained') {
      waveform.play(1);
      report({ type: 'played' });
    }
  }

  function scheduleProgress() {
    if (reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(() => {
      reportScheduled = false;
      if (!job) return;
      if (job.done) {
        report({ type: 'measured', metrics: metrics() });
        return;
      }
      job.wallMs = performance.now() - job.t0;
      const status = job.speech?.stage === 'speak' ? `speaking · row ${job.speech.rows} · ${(job.samples / sampleRate).toFixed(2)} s of audio` : 'reading the prompt…';
      report({ type: 'progress', status, metrics: metrics() });
    });
  }

  function metrics() {
    const workerRequests = (job.speech?.networkRequests ?? 0) + (job.decoder?.networkRequests ?? 0);
    const requests = performance.getEntriesByType('resource').length - requestsAtReady + workerRequests;
    return {
      heard_ms: job.heardMs,
      embed_ms: job.embedMs,
      encode_ms: job.encodeMs,
      wall_ms: job.wallMs,
      audio_seconds: job.samples / sampleRate,
      requests,
    };
  }

  function finish(message) {
    if (message.job !== job?.id) return;
    job.decoder = message;
    job.samples = message.samples;
    job.wallMs = performance.now() - job.t0;
    job.done = true;
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    wavUrl = message.samples ? URL.createObjectURL(new Blob([message.wav], { type: 'audio/wav' })) : null;
    report({ type: 'done', status: message.stopped ? 'stopped' : 'Done', audio: wavUrl, metrics: metrics() });
    if (!message.samples) report({ type: 'played' });
  }

  /** The model could not load, or an engine or a compute thread died. */
  function fail(message) {
    broken = true;
    for (const bundle of Object.values(workers)) {
      bundle?.worker.terminate();
      bundle?.pool.terminate();
    }
    if (job) audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: job.id }));
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  start('speech', 'speech', SPEECH_THREADS);
  onCleanup(inputs.decoder.subscribe(selectDecoder));
  onCleanup(onClicks(inputs.clicks, resumeAudio));
  onCleanup(onClicks(inputs.starts, dispatch));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(() => {
    root.removeEventListener('change', onChange);
    root.removeEventListener('dragover', onDrag);
    root.removeEventListener('dragleave', onDrag);
    root.removeEventListener('drop', onDrop);
    for (const bundle of Object.values(workers)) {
      bundle?.worker.terminate();
      bundle?.pool.terminate();
    }
    audio?.then(({ context }) => context.close());
    if (wavUrl) URL.revokeObjectURL(wavUrl);
  });
}

/** The mono mix of a decoded clip. */
function mono(buffer) {
  const mix = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    buffer.getChannelData(channel).forEach((sample, i) => (mix[i] += sample / buffer.numberOfChannels));
  }
  return mix;
}

/** `count` peaks of `samples`, each the loudest sample of an equal share of them. */
function peaksOf(samples, count) {
  const peaks = new Float32Array(count);
  const width = Math.max(1, Math.ceil(samples.length / count));
  samples.forEach((sample, i) => {
    const bin = Math.min(count - 1, Math.floor(i / width));
    peaks[bin] = Math.max(peaks[bin], Math.abs(sample));
  });
  return peaks;
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
