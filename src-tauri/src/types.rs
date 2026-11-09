//! Delade datatyper mot frontend.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub(crate) struct ProgressPayload {
    pub(crate) progress: f32,
    pub(crate) downloaded: u64,
    pub(crate) total: u64,
}


#[derive(Serialize, Clone)]
pub(crate) struct TranscriptionProgressPayload {
    pub(crate) progress: i32,
}

#[derive(Serialize)]
pub(crate) struct TokenInfo {
    pub(crate) text: String,
    pub(crate) prob: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptSegment {
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) text: String,
    pub(crate) tokens: Vec<TokenInfo>,
    /// 1, 2, … i den ordning talarna först hörs. None = talaridentifiering av eller osäker.
    pub(crate) speaker_id: Option<i32>,
}

#[derive(Serialize, Clone)]
pub(crate) struct DiarizationPhasePayload {
    /// "start" | "done" | "failed"
    pub(crate) phase: &'static str,
    pub(crate) speakers: i32,
    pub(crate) message: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ModelInfo {
    pub(crate) name: String,
    pub(crate) size: String,
    pub(crate) revision: String,
    pub(crate) quantized: bool,
    pub(crate) size_bytes: u64,
    pub(crate) downloaded: bool,
}

#[derive(Serialize)]
pub(crate) struct DiskInfo {
    pub(crate) total_space: u64,
    pub(crate) available_space: u64,
    pub(crate) models_dir_size: u64,
}

