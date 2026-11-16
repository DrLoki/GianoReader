//! Motore di analisi del layout dei PDF (portato da PDF X-Ray).
//!
//! runs → righe → blocchi XY-Cut → ruoli → ordine di lettura → paragrafi
//! logici (ricuciti tra colonne/pagine). Tutte le coordinate sono in punti PDF
//! (origine in alto a sinistra). Vedi `PDF-X-Ray/docs/layout-pipeline.md`.

pub mod flow;
pub mod lines;
pub mod model;
pub mod order;
pub mod pipeline;
pub mod reflow;
pub mod roles;
pub mod text;
pub mod xycut;

#[cfg(test)]
mod pipeline_tests;
