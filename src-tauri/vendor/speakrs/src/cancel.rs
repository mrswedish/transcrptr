//! Transkribera-patch: avbrytflagga och förloppsräknare för pågående diarisering.
//!
//! speakrs har varken avbrott eller förloppsrapportering. Anroparen sätter flaggan med
//! [`request_cancel`]; segmenterings- och embedding-looparna kontrollerar den mellan varje
//! fönster respektive chunk och uppdaterar samtidigt förloppet i promille (0..=970).
//! Båda är globala atomärer, så anroparen ska kalla [`reset_cancel`] innan en ny körning startar.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static CANCEL: AtomicBool = AtomicBool::new(false);
static PROGRESS_PERMILLE: AtomicU32 = AtomicU32::new(0);

/// Begär att pågående körning avbryts.
pub fn request_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Nollställer avbrytflaggan och förloppsräknaren inför en ny körning.
pub fn reset_cancel() {
    CANCEL.store(false, Ordering::Relaxed);
    PROGRESS_PERMILLE.store(0, Ordering::Relaxed);
}

/// Sant om avbrott har begärts.
pub fn is_cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

/// Uppdaterar förloppet i promille (0..=1000).
pub fn set_progress(permille: u32) {
    PROGRESS_PERMILLE.store(permille.min(1000), Ordering::Relaxed);
}

/// Läser aktuellt förlopp i promille (0..=1000).
pub fn progress() -> u32 {
    PROGRESS_PERMILLE.load(Ordering::Relaxed)
}
