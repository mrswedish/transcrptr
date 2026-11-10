//! Transkribera-patch: avbrytflagga för pågående diarisering.
//!
//! speakrs har inget sätt att avbryta en körning. Anroparen sätter flaggan med
//! [`request_cancel`]; segmenterings- och embedding-looparna kontrollerar den mellan varje
//! fönster respektive chunk och avslutar då med ett fel. Flaggan är global, så anroparen ska
//! kalla [`reset_cancel`] innan en ny körning startar.

use std::sync::atomic::{AtomicBool, Ordering};

static CANCEL: AtomicBool = AtomicBool::new(false);

/// Begär att pågående körning avbryts.
pub fn request_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Nollställer flaggan inför en ny körning.
pub fn reset_cancel() {
    CANCEL.store(false, Ordering::Relaxed);
}

/// Sant om avbrott har begärts.
pub fn is_cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}
