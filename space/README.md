---
title: zonos3-mini-wasm
short_description: Text to speech in 27 voices or yours, on your CPU
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
models:
  - fusorlabs/zonos3-mini-web
  - Zyphra/ZONOS3-Mini
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Text to speech with Zyphra's [ZONOS3-Mini](https://huggingface.co/Zyphra/ZONOS3-Mini), computed on
your own CPU in the browser: the model, compiled to WebAssembly with fusor-ai, downloads once and
then runs sealed from the network. Type a text and hear it in one of 27 default voices, in a voice
you design with the model's steering controls, or in a voice cloned from a clip you drop into the
page; the speech streams to your speakers as it is computed. Neither the text nor the clip leaves
the page. The model is Apache-2.0; its license ships beside the bundles as `model/LICENSE`. The
page's code is MIT; its source is
[github.com/fusor-rs/zonos3-mini-wasm](https://github.com/fusor-rs/zonos3-mini-wasm).
