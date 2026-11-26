---
license: apache-2.0
base_model:
  - Zyphra/ZONOS3-Mini
pipeline_tag: text-to-speech
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
  - voice-cloning
---

# ZONOS3-Mini, compiled for the browser

Zyphra's [ZONOS3-Mini](https://huggingface.co/Zyphra/ZONOS3-Mini) compiled into four
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundles: the weights the browser runtime of
[zonos3-mini-wasm](https://github.com/fusor-rs/zonos3-mini-wasm) loads to speak a text in 27
default voices, a designed voice or a voice cloned from a clip, on the device's CPU. Try it in the
Space [fusorlabs/zonos3-mini-wasm](https://huggingface.co/spaces/fusorlabs/zonos3-mini-wasm).

- **Source:** `Zyphra/ZONOS3-Mini` at revision `2921b8821772b0bd10a04456863d21abf9d2f283`, with
  the steering directions and the short-text registry of Zyphra's
  [reference repository](https://github.com/Zyphra/ZONOS3-Mini) at commit
  `a50e14117d99181ba7f28047b451ba03ba1a09a9`, compiled with the `q7` profile (every large matrix
  7-bit) into four bundles, each loaded by an engine with its own WebAssembly memory:
  - `speech/`: the language model, the default voices, the speaker encoder, the LACI alignment
    heads and the steering directions (1046 MB).
  - `codec/`: the codec's decoder with its default head (163 MB).
  - `codec-full/`: the decoder with the full multi-resolution head, loaded when chosen (1146 MB).
  - `encoder/`: the codec's encoder and its w2v-BERT teacher, loaded the first time a clip is
    cloned by its codes (1575 MB).
- **Format:** each `manifest.json` lists every tensor and part; each part is named by its BLAKE3
  hash, which the runtime checks as it loads.
- **Reproduce it:** `just model` in zonos3-mini-wasm downloads the checkpoint and compiles the same
  bundles.

This is not a PyTorch or safetensors checkpoint: it only loads in the zonos3-mini-wasm runtime.

The model is Apache-2.0 ([LICENSE](LICENSE)). The steering directions and the short-text registry
come from the reference repository, which is MIT ([LICENSE-MIT](LICENSE-MIT)).
