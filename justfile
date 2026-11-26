# ZONOS3-Mini in the browser. `just ui` builds everything, the model included, and serves the page;
# `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "zonos3-mini"
# The `speech` bundle is about 1 GB (the language model, the default voices and the speaker
# encoder), each decoder's its own (`codec` 0.16 GB, `codec-full` 1.1 GB) and the clip encoder's
# 1.6 GB, each engine in a worker of its own; the KV caches and the activations on top.
export MAX_MEMORY := "4294967296"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
model_f32 := "dist/model-f32"
cases := "fixtures/cases.json"
goldens := "fixtures/goldens"
# The reference the goldens come from (vendor/fusor-ai/models/zonos3-mini/reference): Zyphra's
# zonos3 package at the pinned commit, under the versions of its uv.lock.
reference_repository := ".cache/reference"
reference_revision := "a50e14117d99181ba7f28047b451ba03ba1a09a9"
reference := "uv run --no-project --python 3.12 --with torch==2.9.1 --with torchaudio==2.9.1 --with transformers==4.57.3 --with tokenizers==0.22.2 --with numpy==2.4.1 --with descript-audio-codec==1.0.0 --with soundfile==0.13.1 --with einops==0.8.2 --with safetensors==0.7.0 --with scipy==1.17.1 --with zyphra-textnorm==0.2.0 --with omegaconf==2.4.0 --with pyyaml==6.0.3 python -I"

host:
    bash -n scripts/fetch-checkpoint.sh
    node --check app/web/app.js
    node --check app/web/waveform.js
    node --check app/engine/speech.js
    node --check app/engine/decoder.js
    node --check app/engine/encoder.js
    node --check app/engine/playback.js
    node --check scripts/node-smoke.mjs
    node --check scripts/render-images.mjs
    node --check scripts/site-bundle.mjs
    node --check e2e/run.mjs
    python3 -m py_compile scripts/asr_check.py

# Downloads the pinned checkpoint (14.3 GB, sha256-checked) unless it is already there, then
# compiles the bundles `speech/`, `codec/` and `codec-full/` into dist/model.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/zonos3-mini compile {{checkpoint}} {{model}}

# Try it on localhost. The bundles and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# Every stage against the reference's goldens (vendor/fusor-ai/models/zonos3-mini/reference),
# with the f32 bundles.
parity: native
    test -f {{goldens}}/golden_f32_reference_en.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/zonos3-mini compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/zonos3-mini parity {{model_f32}} {{goldens}}/golden_f32_*.safetensors

# Golden tensors of every case, from the reference in f32 on the CPU.
goldens:
    scripts/fetch-checkpoint.sh {{checkpoint}}
    test -d {{reference_repository}} || git clone --quiet https://github.com/Zyphra/ZONOS3-Mini.git {{reference_repository}}
    git -C {{reference_repository}} checkout --quiet {{reference_revision}}
    {{reference}} {{fusor_ai}}/models/zonos3-mini/reference/dump.py {{reference_repository}}/model/src {{checkpoint}} {{cases}} {{goldens}}

bench: model
    target/release/zonos3-mini bench {{model}}

# The Python the intelligibility checks run Whisper in.
asr:
    test -x .cache/asr/bin/python || (uv venv .cache/asr --python 3.12 && uv pip install --python .cache/asr/bin/python faster-whisper==1.2.1 av==15.1.0)

# The README's banner and benchmark summary, light and dark.
images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

# The page, its four runtimes and the bundles beside it, as a static site in target/site. The
# checkpoint ships no license file: the model's is Apache-2.0 by its card (space/MODEL-LICENSE),
# and the steering directions and the short-text registry carry the reference repository's MIT.
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    for bundle in speech codec codec-full encoder; do node scripts/site-bundle.mjs {{model}}/$bundle target/site/model/$bundle || exit 1; done
    cp space/MODEL-LICENSE target/site/model/LICENSE
    cp {{checkpoint}}/reference/LICENSE target/site/model/LICENSE-MIT

# The Space holds at most 1 GB, so it gets the page, the runtimes and the licenses, and the page
# loads the bundles from the model repo fusorlabs/zonos3-mini-web (`just deploy-model`). The
# Space is created as a static Space first: creating it with the upload makes a Gradio Space,
# which Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/zonos3-mini-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/zonos3-mini-wasm", repo_type="space", space_sdk="static", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/zonos3-mini-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy zonos3-mini-wasm {{version}}",
    )
    PY

# Deploy them before the Space whenever a bundle changes: a runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's four bundles, with space/MODEL.md as their card, to the model repo
# fusorlabs/zonos3-mini-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/zonos3-mini-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/zonos3-mini-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the zonos3-mini-wasm {{version}} bundles",
    )
    PY

# The checks clone a voice from a default voice's clip in the checkpoint (`model` fetches it).
fixtures:
