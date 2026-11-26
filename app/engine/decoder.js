// The decoder's home: a codec bundle (`codec/`, keep2_plain, or `codec-full/`, full_mr) in a module
// Worker with its own runtime instance and memory. The page starts one for the decoder chosen and
// ends it when another is chosen.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Decode: the speech worker's messages arrive through `speechPort` in the order it sent them:
// `start` (the take's frames to drop), `frames` (each chunk the stream hands out, decoded as one
// call, so the samples do not depend on timing) and `end`. Every chunk's samples go straight to
// the page's audio worklet through `audioPort`, and a summary of them (peaks) to the page. At the
// end the page gets the whole WAV.

import { engine, load, post, report, requestsSinceReady, serve } from './dist/host/worker.js';

// Samples per waveform bar the page draws: eight bars a frame of speech (2,940 samples, 1/15 s).
const SAMPLES_PER_PEAK = 2940 / 8;

let audioPort = null;
let take = null;

serve({
  load: ({ modelUrl, threads, build, variant }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'zonos3_mini_runtime',
      className: 'DecoderRuntime',
      cacheName: `zonos3-mini-${variant}`,
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads, sampleRate: started.glue.sample_rate() }),
      onReady: (progress) => post({ type: 'ready', decoder: engine.rt.decoder(), ...progress }),
    }),
  audio: ({ port }) => (audioPort = port),
  speech: ({ port }) => {
    port.onmessage = ({ data }) => {
      try {
        speechMessages[data.type](data);
      } catch (error) {
        report(error, data.job);
      }
    };
  },
});

const speechMessages = {
  start: ({ job, leadingFrames }) => {
    engine.rt.start('{}', leadingFrames);
    take = { job, t0: performance.now(), chunks: [], samples: 0 };
    audioPort.postMessage({ type: 'start', job });
  },
  frames: ({ job, codes }) => {
    if (job !== take?.job) return;
    serveSamples(engine.rt.decode(codes));
  },
  end: ({ job, stopped }) => {
    if (job !== take?.job) return;
    if (stopped) engine.rt.cancel();
    else serveSamples(engine.rt.finish());
    audioPort.postMessage({ type: 'end', job });
    const wav = engine.glue.wav(concat(take.chunks, take.samples));
    const stats = { job, stopped, samples: take.samples, decodeMs: performance.now() - take.t0, networkRequests: requestsSinceReady() };
    take = null;
    post({ type: 'done', wav, ...stats }, [wav.buffer]);
  },
};

/** Sends `samples` to the worklet, and their peaks to the page. */
function serveSamples(samples) {
  if (!samples.length) return;
  take.samples += samples.length;
  take.chunks.push(samples.slice());
  post({ type: 'audio', job: take.job, peaks: peaks(samples), samples: take.samples, decodeMs: performance.now() - take.t0 });
  audioPort.postMessage({ type: 'pcm', job: take.job, samples }, [samples.buffer]);
}

function peaks(samples) {
  const out = new Float32Array(Math.ceil(samples.length / SAMPLES_PER_PEAK));
  const width = Math.ceil(samples.length / out.length);
  samples.forEach((s, i) => {
    const bin = Math.floor(i / width);
    out[bin] = Math.max(out[bin], Math.abs(s));
  });
  return out;
}

function concat(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
