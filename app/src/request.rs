//! What the page asks the engine for: the runtime's limits (`limits()`), and the request
//! (`zonos3_mini::session::Request`) built from the form.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// The runtime's limits, `limits()`.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Limits {
    pub conditions: Vec<Condition>,
    pub sampling: Sampling,
    pub max_clip_seconds: f64,
}

// A condition row's buckets: values below the first edge, between two, at or past the last;
// the bucket after them is the unknown one, which the request leaves out.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Condition {
    pub name: String,
    pub unit: String,
    pub edges: Vec<f64>,
}

impl Condition {
    // The unknown bucket's id, which follows the measured ones.
    pub fn unknown(&self) -> usize {
        self.edges.len() + 1
    }

    // What bucket `bucket` holds, in the condition's unit; the unknown bucket is "not set".
    pub fn describe(&self, bucket: usize) -> String {
        let unit = &self.unit;
        let lower = bucket
            .checked_sub(1)
            .and_then(|below| self.edges.get(below));
        match (lower, self.edges.get(bucket)) {
            (None, Some(upper)) => format!("below {upper:.1} {unit}"),
            (Some(lower), Some(upper)) => format!("{lower:.1} to {upper:.1} {unit}"),
            (Some(lower), None) => format!("{lower:.1} {unit} or more"),
            (None, None) => "not set".into(),
        }
    }
}

// The sampler's settings, `zonos3_mini::sampling::Settings`.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Sampling {
    pub temperature: f64,
    pub top_k: u32,
    pub top_p: f64,
    pub min_p: f64,
    pub repetition_penalty: f64,
    pub repetition_window: u32,
    pub repetition_codebooks: u32,
}

// Whom a take speaks as: a default voice by its reference frames or its embedding, the clip sent
// with the request, through the speaker encoder, or the clip's codes, which `web/app.js` fills
// in from the clip encoder.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Speaker {
    Default { id: String, mode: String },
    Clip,
    Codes { frames: Vec<[u32; 10]> },
}

#[derive(Serialize)]
pub struct Request {
    pub text: String,
    pub seed: u64,
    pub speaker: Speaker,
    pub condition_buckets: BTreeMap<String, usize>,
    pub sampling: Sampling,
    pub speaker_cfg_scale: f64,
    pub language: String,
    pub laci: bool,
    pub controls: BTreeMap<String, f64>,
    pub controls_cfg_scale: f64,
}

// The voice designer, the runtime's `steering()`: the steering bundle's `ui`, and the directions
// that move the speaker embedding.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Steering {
    pub ui: Designer,
    pub raw: Vec<String>,
}

// The controls and accents the designer offers, and its presets: each a level for some of them,
// accents named `accent:<id>`.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Designer {
    pub controls: Vec<Control>,
    pub accents: Vec<Accent>,
    pub presets: BTreeMap<String, BTreeMap<String, f64>>,
}

// A slider: its level times each direction's weight is the direction's dose, from the `+` map at
// a positive level and from the `-` one (a bipolar control's) at a negative one.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Control {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub poles: Option<[String; 2]>,
    pub map: BTreeMap<String, BTreeMap<String, f64>>,
    pub range: [f64; 2],
}

#[derive(Clone, PartialEq, Deserialize)]
pub struct Accent {
    pub id: String,
    pub label: String,
    pub map: BTreeMap<String, f64>,
    pub range: [f64; 2],
}

// A default voice's id (`<Language>/<Name>_<details>`) as a person reads it: `Name · Language`.
pub fn voice_label(id: &str) -> String {
    let (language, file) = id
        .split_once('/')
        .expect("the runtime's voice ids are <language>/<name>");
    let name = file.split_once('_').map_or(file, |(name, _)| name);
    format!("{name} · {language}")
}
