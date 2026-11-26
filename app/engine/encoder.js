// The clip encoder's home: the `encoder/` bundle (the codec's encoder and its w2v-BERT teacher) in
// a module Worker with its own runtime instance and memory. The page starts it when a clip is first
// cloned by its codes and ends it once the codes are out.
//
// Encode: one `step()` per macrotask (a lane's front, each of its stages, its teacher, its codes),
// each reported to the page, then the clip's codes, a frame of 10 after another.

import { engine, load, post, serve, yieldTask } from './dist/host/worker.js';

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'zonos3_mini_runtime',
      className: 'EncoderRuntime',
      cacheName: 'zonos3-mini-encoder',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  encode,
});

async function encode({ job, clip, clipRate }) {
  const { rt } = engine;
  const t0 = performance.now();
  rt.start(clip, clipRate);
  for (;;) {
    const progress = JSON.parse(rt.step());
    post({ type: 'encoding', job, steps: progress.steps, total: progress.total });
    if (progress.done) break;
    await yieldTask();
  }
  const codes = rt.codes();
  post({ type: 'encoded', job, codes, encodeMs: performance.now() - t0 }, [codes.buffer]);
}
