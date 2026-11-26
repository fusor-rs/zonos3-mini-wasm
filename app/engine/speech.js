// The language model's home: the `speech/` bundle (the language model, the default voices and the
// speaker encoder) in a module Worker with its own runtime instance and memory.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Generate: one `step()` per macrotask, so a stop request is seen between steps. The prompt (and a
// clip's embedding) comes first, then one row a step; the frames each step completes go straight
// to the decoder worker through `decoderPort`, in the order the stream hands them out, and a
// summary of the step to the page.
//
// After the model is loaded nothing else is fetched: synthesis is entirely local.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

let decoderPort = null;
let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'zonos3_mini_runtime',
      className: 'SpeechRuntime',
      cacheName: 'zonos3-mini-speech',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', catalog: catalog(), ...progress }),
    }),
  decoder: ({ port }) => (decoderPort = port),
  generate,
  stop: ({ job }) => (stoppedJob = job),
});

/** What the page offers: the runtime's limits, the default voices, LACI's languages, the voice designer. */
function catalog() {
  const { glue, rt } = engine;
  return {
    limits: JSON.parse(glue.limits()),
    voices: JSON.parse(rt.voices()),
    languages: JSON.parse(rt.laci_languages()),
    steering: JSON.parse(rt.steering()),
  };
}

async function generate({ job, request, clip, clipRate }) {
  const { rt } = engine;
  const t0 = performance.now();
  const plan = JSON.parse(rt.start(request, clip, clipRate));
  decoderPort.postMessage({ type: 'start', job, leadingFrames: plan.leading_frames });
  let progress = { rows: 0 };
  try {
    for (;;) {
      if (stoppedJob === job) {
        rt.cancel();
        break;
      }
      progress = JSON.parse(rt.step());
      const codes = rt.frames();
      if (codes.length) decoderPort.postMessage({ type: 'frames', job, codes }, [codes.buffer]);
      post({ type: 'step', job, stage: progress.stage, rows: progress.rows, speechMs: performance.now() - t0 });
      if (progress.done) break;
      await yieldTask();
    }
  } finally {
    // A take that did not finish (stopped, or failed) is not finished by the decoder either.
    decoderPort.postMessage({ type: 'end', job, stopped: !progress.done });
  }
  post({ type: 'spoken', job, stage: progress.stage, rows: progress.rows, speechMs: performance.now() - t0, networkRequests: requestsSinceReady() });
}
