use std::collections::BTreeMap;

use fusor::{JsInputs, Signal, signal};
use serde::Deserialize;

use crate::request::{Limits, Request, Sampling, Speaker, Steering, voice_label};

const SAMPLE_TEXT: &str =
    "The old lighthouse keeper climbed the stairs every evening to light the lamp.";
const DEFAULT_VOICE: &str = "English/Rupert_en-British_M_1";
// The voice chip of the uploaded clip.
const CLIP: &str = "clip";
// How the clip is cloned: by its codes (the reference's default), or by its speaker embedding.
const BY_CODES: &str = "codes";
const BY_EMBEDDING: &str = "embedding";
const DEFAULT_SEED: f64 = 7.0;
// A guidance scale that leaves it off, the reference's default.
const UNGUIDED: f64 = 1.0;
const DEFAULT_LANGUAGE: &str = "en_us";
// The prefix of an accent's slider, as the designer's presets name them.
const ACCENT: &str = "accent:";

// The runtime build and the bundles, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {} bundles · {source} in {}",
            self.build,
            megabytes(self.bundle_bytes),
            seconds(self.load_ms)
        )
    }
}

// One take as `web/app.js` measures it, live while it runs. `heard_ms` and `wall_ms` are timed on
// the page from the click (for a queued request, from the model being ready) to the first sample
// the audio worklet rendered and to the decoder's last samples; `embed_ms`, for a cloned voice,
// to the clip's embedding.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    heard_ms: Option<f64>,
    embed_ms: Option<f64>,
    encode_ms: Option<f64>,
    wall_ms: f64,
    audio_seconds: f64,
    requests: u32,
}

impl Metrics {
    fn heard(&self) -> String {
        self.heard_ms.map_or("–".into(), milliseconds)
    }

    fn heard_note(&self) -> String {
        match (self.encode_ms, self.embed_ms) {
            (Some(ms), _) => format!("from the click, {} of it encoding the clip", seconds(ms)),
            (None, Some(ms)) => format!("from the click, {} of it embedding the clip", seconds(ms)),
            (None, None) => "from the click".into(),
        }
    }

    fn real_time_factor(&self) -> String {
        if self.audio_seconds == 0.0 {
            return "–".into();
        }
        format!("{:.3}", self.wall_ms / 1000.0 / self.audio_seconds)
    }

    fn speedup(&self) -> String {
        if self.wall_ms == 0.0 || self.audio_seconds == 0.0 {
            return "audio seconds per wall second".into();
        }
        format!(
            "{:.1}× faster than real time",
            self.audio_seconds * 1000.0 / self.wall_ms
        )
    }

    fn audio(&self) -> String {
        format!("{:.2} s of speech", self.audio_seconds)
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        limits: Limits,
        voices: Vec<String>,
        languages: Vec<String>,
        steering: Steering,
        loaded: Loaded,
    },
    // The uploaded clip: its length, and a note about it (trimmed, unreadable).
    Clip {
        seconds: f64,
        note: String,
    },
    Progress {
        status: String,
        metrics: Metrics,
    },
    // The audio is decoded; `audio` is the WAV's blob URL.
    Done {
        status: String,
        audio: Option<String>,
        metrics: Metrics,
    },
    // New measurements after `Done` (the first sample can play after the last frame).
    Measured {
        metrics: Metrics,
    },
    // The last queued sample was played, or playback was stopped.
    Played,
    // A take failed; the engines can run the next one.
    Error {
        message: String,
    },
    // The model could not load, or an engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Generating,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Generating => "generating",
            Self::Broken => "broken",
        }
    }
}

// A voice to pick: a default voice, or the uploaded clip.
#[derive(Clone, PartialEq)]
struct Voice {
    id: String,
    label: String,
}

// A condition's slider, its value the bucket id.
#[derive(Clone, PartialEq)]
struct ConditionView {
    name: String,
    label: String,
    unknown: usize,
}

// A voice designer's slider, a control or an accent; its level lives in `App::levels`.
#[derive(Clone, PartialEq)]
struct Knob {
    id: String,
    label: String,
    poles: Option<[String; 2]>,
    min: f64,
    max: f64,
    // Each direction's weight at a positive level, and at a negative one.
    plus: BTreeMap<String, f64>,
    minus: BTreeMap<String, f64>,
    // It moves the speaker embedding, which a voice by its recording lacks.
    raw: bool,
}

impl Knob {
    // The sliders of the designer's controls, then of its accents.
    fn all(steering: &Steering) -> Vec<Self> {
        let raw =
            |weights: &BTreeMap<String, f64>| weights.keys().any(|id| steering.raw.contains(id));
        let controls = steering.ui.controls.iter().map(|control| {
            // A unipolar control has no `-` pole.
            let weights = |pole: &str| control.map.get(pole).cloned().unwrap_or_default();
            let (plus, minus) = (weights("+"), weights("-"));
            Self {
                id: control.id.clone(),
                label: control.label.clone(),
                poles: control.poles.clone(),
                min: control.range[0],
                max: control.range[1],
                raw: raw(&plus) || raw(&minus),
                plus,
                minus,
            }
        });
        let accents = steering.ui.accents.iter().map(|accent| Self {
            id: format!("{ACCENT}{}", accent.id),
            label: format!("Accent · {}", accent.label),
            poles: None,
            min: accent.range[0],
            max: accent.range[1],
            plus: accent.map.clone(),
            minus: BTreeMap::new(),
            raw: raw(&accent.map),
        });
        controls.chain(accents).collect()
    }

    // Each direction's dose at `level`.
    fn doses(&self, level: f64) -> impl Iterator<Item = (&String, f64)> {
        let weights = if level < 0.0 { &self.minus } else { &self.plus };
        weights
            .iter()
            .map(move |(id, weight)| (id, weight * level.abs()))
    }
}

#[derive(JsInputs)]
struct App {
    text: Signal<String>,
    voice: Signal<String>,
    mode: Signal<String>,
    clip_mode: Signal<String>,
    speaking_rate: Signal<f64>,
    loudness: Signal<f64>,
    fmax: Signal<f64>,
    guidance: Signal<f64>,
    controls_guidance: Signal<f64>,
    laci: Signal<bool>,
    language: Signal<String>,
    languages: Signal<Vec<String>>,
    knobs: Signal<Vec<Knob>>,
    // Every knob's level, by its id.
    levels: Signal<BTreeMap<String, Signal<f64>>>,
    presets: Signal<BTreeMap<String, BTreeMap<String, f64>>>,
    seed: Signal<f64>,
    temperature: Signal<f64>,
    top_k: Signal<f64>,
    top_p: Signal<f64>,
    min_p: Signal<f64>,
    repetition_penalty: Signal<f64>,
    repetition_window: Signal<f64>,
    repetition_codebooks: Signal<f64>,
    // `web/app.js` loads the decoder this names, and acts on every new count: `clicks` (Speak)
    // resumes the audio output inside the user's gesture, `starts` runs `request`, `stops` stops
    // the take and the playback.
    #[js]
    decoder: Signal<String>,
    #[js]
    request: Signal<String>,
    #[js]
    clicks: Signal<u32>,
    #[js]
    starts: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    phase: Signal<Phase>,
    // Speak was clicked while the model loaded: it runs as soon as the model is ready.
    queued: Signal<bool>,
    playing: Signal<bool>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    limits: Signal<Option<Limits>>,
    voices: Signal<Vec<String>>,
    // The uploaded clip, in seconds, and what to tell about it.
    clip_seconds: Signal<f64>,
    clip_note: Signal<String>,
    status: Signal<String>,
    audio: Signal<Option<String>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            text: signal(SAMPLE_TEXT.into()),
            voice: signal(DEFAULT_VOICE.into()),
            mode: signal("reference".into()),
            clip_mode: signal(BY_CODES.into()),
            speaking_rate: signal(0.0),
            loudness: signal(0.0),
            fmax: signal(0.0),
            guidance: signal(UNGUIDED),
            controls_guidance: signal(UNGUIDED),
            laci: signal(false),
            language: signal(DEFAULT_LANGUAGE.into()),
            languages: signal(Vec::new()),
            knobs: signal(Vec::new()),
            levels: signal(BTreeMap::new()),
            presets: signal(BTreeMap::new()),
            seed: signal(DEFAULT_SEED),
            temperature: signal(0.0),
            top_k: signal(0.0),
            top_p: signal(0.0),
            min_p: signal(0.0),
            repetition_penalty: signal(0.0),
            repetition_window: signal(0.0),
            repetition_codebooks: signal(0.0),
            decoder: signal("keep2_plain".into()),
            request: signal(String::new()),
            clicks: signal(0),
            starts: signal(0),
            stops: signal(0),
            phase: signal(Phase::Loading),
            queued: signal(false),
            playing: signal(false),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            limits: signal(None),
            voices: signal(Vec::new()),
            clip_seconds: signal(0.0),
            clip_note: signal(String::new()),
            status: signal(String::new()),
            audio: signal(None),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn generate(&self) {
        self.clicks.update(|count| *count += 1);
        let Some(request) = self.request() else {
            return;
        };
        if self.phase.get() == Phase::Loading {
            self.queued.set(true);
            self.status
                .set("Queued: it speaks the moment the model is ready.".into());
        } else {
            self.begin(request);
        }
    }

    // The engine request with the form's settings, as JSON, or `None` after telling what is
    // wrong.
    fn request(&self) -> Option<String> {
        let text = self.text.get().trim().to_string();
        if text.is_empty() {
            self.status.set("Type some text first.".into());
            return None;
        }
        let voice = self.voice.get();
        let speaker = if voice == CLIP {
            if self.clip_seconds.get() == 0.0 {
                self.status.set("Add a clip of the voice first.".into());
                return None;
            }
            if self.clip_mode.get() == BY_CODES {
                Speaker::Codes { frames: Vec::new() }
            } else {
                Speaker::Clip
            }
        } else {
            Speaker::Default {
                id: voice,
                mode: self.mode.get(),
            }
        };
        let request = Request {
            text,
            seed: self.seed.get() as u64,
            speaker,
            condition_buckets: self.condition_buckets(),
            sampling: self.sampling(),
            speaker_cfg_scale: self.guidance.get(),
            language: self.language.get(),
            laci: self.laci.get(),
            controls: self.controls(),
            controls_cfg_scale: self.controls_guidance.get(),
        };
        Some(serde_json::to_string(&request).expect("plain data serializes"))
    }

    // The slider of the condition `name`, for the conditions the page offers.
    fn condition(&self, name: &str) -> Option<&Signal<f64>> {
        match name {
            "loudness" => Some(&self.loudness),
            "fmax" => Some(&self.fmax),
            "speaking_rate" => Some(&self.speaking_rate),
            _ => None,
        }
    }

    // The slider of a condition `conditions` shows.
    fn slider(&self, name: &str) -> Signal<f64> {
        self.condition(name)
            .expect("the page shows only the conditions it offers")
            .clone()
    }

    // The buckets the sliders set; a slider at the unknown bucket leaves its condition out.
    fn condition_buckets(&self) -> BTreeMap<String, usize> {
        self.conditions()
            .into_iter()
            .filter_map(|view| {
                let bucket = self.slider(&view.name).get() as usize;
                (bucket < view.unknown).then_some((view.name, bucket))
            })
            .collect()
    }

    fn sampling(&self) -> Sampling {
        Sampling {
            temperature: self.temperature.get(),
            top_k: self.top_k.get() as u32,
            top_p: self.top_p.get(),
            min_p: self.min_p.get(),
            repetition_penalty: self.repetition_penalty.get(),
            repetition_window: self.repetition_window.get() as u32,
            repetition_codebooks: self.repetition_codebooks.get() as u32,
        }
    }

    // The form at the reference's defaults: the sampler's settings, the conditions not set.
    fn reset_settings(&self, limits: &Limits) {
        let defaults = &limits.sampling;
        self.temperature.set(defaults.temperature);
        self.top_k.set(f64::from(defaults.top_k));
        self.top_p.set(defaults.top_p);
        self.min_p.set(defaults.min_p);
        self.repetition_penalty.set(defaults.repetition_penalty);
        self.repetition_window
            .set(f64::from(defaults.repetition_window));
        self.repetition_codebooks
            .set(f64::from(defaults.repetition_codebooks));
        self.guidance.set(UNGUIDED);
        self.controls_guidance.set(UNGUIDED);
        self.seed.set(DEFAULT_SEED);
        for condition in &limits.conditions {
            if let Some(slider) = self.condition(&condition.name) {
                slider.set(condition.unknown() as f64);
            }
        }
    }

    fn begin(&self, request: String) {
        self.request.set(request);
        self.phase.set(Phase::Generating);
        self.playing.set(true);
        self.measured.set(true);
        self.metrics.set(Metrics::default());
        self.status.set("Preparing…".into());
        self.starts.update(|count| *count += 1);
    }

    fn stop(&self) {
        if self.queued.get() {
            self.queued.set(false);
            self.status.set("Cancelled.".into());
            return;
        }
        self.stops.update(|count| *count += 1);
    }

    fn choose(&self, voice: Voice) {
        self.voice.set(voice.id);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => self.loading(fraction, detail),
            Report::Ready {
                limits,
                voices,
                languages,
                steering,
                loaded,
            } => {
                self.languages.set(languages);
                self.design(&steering);
                self.ready(limits, voices, loaded);
            }
            Report::Clip { seconds, note } => {
                self.clip_seconds.set(seconds);
                self.clip_note.set(note);
                if seconds > 0.0 {
                    self.voice.set(CLIP.into());
                }
            }
            Report::Progress { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done {
                status,
                audio,
                metrics,
            } => {
                self.status.set(status);
                self.audio.set(audio);
                self.metrics.set(metrics);
                self.phase.set(Phase::Ready);
            }
            Report::Measured { metrics } => self.metrics.set(metrics),
            Report::Played => self.playing.set(false),
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.playing.set(false);
                self.phase.set(Phase::Ready);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    // Loading, at first or after another decoder was chosen.
    fn loading(&self, fraction: f64, detail: String) {
        self.fraction.set(fraction);
        self.detail.set(detail);
        if self.phase.get() == Phase::Ready {
            self.phase.set(Phase::Loading);
        }
    }

    fn ready(&self, limits: Limits, voices: Vec<String>, loaded: Loaded) {
        if self.limits.get().is_none() {
            self.reset_settings(&limits);
        }
        self.limits.set(Some(limits));
        self.voices.set(voices);
        self.loaded.set(Some(loaded));
        self.phase.set(Phase::Ready);
        let queued = self.queued.get();
        self.queued.set(false);
        if queued && let Some(request) = self.request() {
            self.begin(request);
        }
    }

    fn voice_choices(&self) -> Vec<Voice> {
        let mut choices: Vec<Voice> = self
            .voices
            .get()
            .iter()
            .map(|id| Voice {
                id: id.clone(),
                label: voice_label(id),
            })
            .collect();
        if self.clip_seconds.get() > 0.0 {
            choices.push(Voice {
                id: CLIP.into(),
                label: format!("Your clip · {:.1} s", self.clip_seconds.get()),
            });
        }
        choices
    }

    fn chosen(&self, voice: &Voice) -> bool {
        self.voice.get() == voice.id
    }

    fn clones(&self) -> bool {
        self.voice.get() == CLIP
    }

    // The sliders of the runtime's conditions the page offers, in the runtime's order.
    fn conditions(&self) -> Vec<ConditionView> {
        let Some(limits) = self.limits.get() else {
            return Vec::new();
        };
        limits
            .conditions
            .iter()
            .filter_map(|condition| {
                let bucket = self.condition(&condition.name)?.get() as usize;
                Some(ConditionView {
                    name: condition.name.clone(),
                    label: condition.describe(bucket),
                    unknown: condition.unknown(),
                })
            })
            .collect()
    }

    // The voice designer's sliders at level 0, the first time the model is ready.
    fn design(&self, steering: &Steering) {
        if !self.knobs.with_untracked(Vec::is_empty) {
            return;
        }
        let knobs = Knob::all(steering);
        let levels = knobs.iter().map(|knob| (knob.id.clone(), signal(0.0)));
        self.levels.replace(levels.collect());
        self.knobs.set(knobs);
        self.presets.set(steering.ui.presets.clone());
    }

    fn level(&self, id: &str) -> Signal<f64> {
        self.levels
            .with(|levels| levels.get(id).expect("every knob has a level").clone())
    }

    fn level_label(&self, knob: &Knob) -> String {
        let level = self.level(&knob.id).get();
        let pole = knob
            .poles
            .as_ref()
            .map(|[minus, plus]| if level < 0.0 { minus } else { plus });
        match pole {
            _ if level == 0.0 => "off".into(),
            Some(pole) => format!("{:.1} {pole}", level.abs()),
            None => format!("{level:.1}"),
        }
    }

    // The take's voice speaks by its embedding, which the knobs of `raw` directions move.
    fn by_embedding(&self) -> bool {
        let mode = if self.clones() {
            self.clip_mode.get()
        } else {
            self.mode.get()
        };
        mode == BY_EMBEDDING
    }

    fn knob_disabled(&self, knob: &Knob) -> bool {
        knob.raw && !self.by_embedding()
    }

    // The doses the enabled knobs set, summed by direction.
    fn controls(&self) -> BTreeMap<String, f64> {
        let mut doses = BTreeMap::new();
        for knob in self
            .knobs
            .get()
            .iter()
            .filter(|knob| !self.knob_disabled(knob))
        {
            for (id, dose) in knob.doses(self.level(&knob.id).get()) {
                *doses.entry(id.clone()).or_insert(0.0) += dose;
            }
        }
        doses.retain(|_, dose| *dose != 0.0);
        doses
    }

    fn preset_names(&self) -> Vec<String> {
        self.presets
            .with(|presets| presets.keys().cloned().collect())
    }

    fn reset_design(&self) {
        self.levels.with(|levels| {
            for level in levels.values() {
                level.set(0.0);
            }
        });
    }

    // Every knob at the preset's level, 0 for those it leaves out.
    fn apply_preset(&self, name: &str) {
        let preset = self.presets.with(|presets| presets.get(name).cloned());
        let preset = preset.expect("a preset's button names one of the presets");
        self.levels.with(|levels| {
            for (id, level) in levels {
                level.set(preset.get(id).copied().unwrap_or(0.0));
            }
        });
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn generate_label(&self) -> &'static str {
        match (self.phase.get(), self.queued.get()) {
            (Phase::Loading, true) => "Queued",
            (Phase::Loading, false) => "Speak when ready",
            _ => "Speak",
        }
    }

    fn can_stop(&self) -> bool {
        self.phase.get() == Phase::Generating || self.playing.get() || self.queued.get()
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn can_generate(&self) -> bool {
        match self.phase.get() {
            Phase::Loading => !self.queued.get(),
            Phase::Ready => true,
            Phase::Generating | Phase::Broken => false,
        }
    }

    // Another decoder can be chosen: nothing is running.
    fn can_switch(&self) -> bool {
        self.phase.get() == Phase::Ready
    }

    fn load_time(&self) -> String {
        self.loaded
            .get()
            .map_or("–".into(), |loaded| seconds(loaded.load_ms))
    }

    fn load_source(&self) -> &'static str {
        match self.loaded.get() {
            Some(loaded) if loaded.from_device => "from this device's storage",
            Some(_) => "downloaded",
            None => "waiting for the model",
        }
    }
}

// A guidance scale as its slider shows it.
fn scale_label(scale: f64) -> String {
    if scale == UNGUIDED {
        "off".into()
    } else {
        format!("{scale:.1}")
    }
}

fn milliseconds(ms: f64) -> String {
    format!("{ms:.0} ms")
}

fn seconds(ms: f64) -> String {
    format!("{:.1} s", ms / 1000.0)
}

fn megabytes(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1e6)
}

fusor::template!("web/index.html");
