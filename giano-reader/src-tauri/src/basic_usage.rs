//! Monthly character count of the BASIC engine (Google Cloud Translation v2).
//!
//! Google does not expose the usage of a key through the key itself (that needs
//! Cloud Monitoring with OAuth), so the app counts the characters it sends:
//! both the desktop translations (`record_basic_usage` command) and the web
//! server's `/translate` in BASIC mode. Google bills the characters of the
//! source text, whitespace included, counted as Unicode code points.
//!
//! The count lives in `<app_local_data_dir>/giano-reader-basic-usage.json`
//! and starts over every calendar month (local time).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "giano-reader-basic-usage.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicUsage {
    /// "YYYY-MM"
    pub month: String,
    pub chars: u64,
}

/// Characters per month covered by Google's free tier (same value as
/// `BASIC_FREE_CHARS` in `basic-usage.js`).
pub const FREE_CHARS: u64 = 500_000;

static PATH: OnceLock<PathBuf> = OnceLock::new();
/// "Switch to FREE at 100 %" option of the desktop settings, pushed by the
/// frontend (`set_basic_auto_free`). When on, the web server stops serving
/// BASIC once the free tier is used up.
static AUTO_FREE: AtomicBool = AtomicBool::new(false);
static LOCK: Mutex<()> = Mutex::new(());

/// Sets the data directory (called once at startup).
pub fn init(app_data_dir: PathBuf) {
    let _ = PATH.set(app_data_dir.join(FILE_NAME));
}

fn current_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

/// Characters billed by Google for a set of texts.
pub fn billed_chars<S: AsRef<str>>(texts: &[S]) -> u64 {
    texts.iter().map(|t| t.as_ref().chars().count() as u64).sum()
}

/// Count of `month`, given the stored value (a different month starts at 0).
fn for_month(stored: Option<BasicUsage>, month: &str) -> BasicUsage {
    match stored {
        Some(u) if u.month == month => u,
        _ => BasicUsage { month: month.to_string(), chars: 0 },
    }
}

fn read(path: &PathBuf) -> Option<BasicUsage> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write(path: &PathBuf, usage: &BasicUsage) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(usage).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Count of the current month.
pub fn get() -> BasicUsage {
    let month = current_month();
    let Some(path) = PATH.get() else { return for_month(None, &month) };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for_month(read(path), &month)
}

/// Adds `chars` to the current month and returns the new count.
pub fn record(chars: u64) -> BasicUsage {
    let month = current_month();
    let Some(path) = PATH.get() else { return for_month(None, &month) };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut usage = for_month(read(path), &month);
    if chars > 0 {
        usage.chars = usage.chars.saturating_add(chars);
        if let Err(e) = write(path, &usage) {
            eprintln!("[basic_usage] write failed: {}", e);
        }
    }
    usage
}

/// Sets the "switch to FREE at 100 %" option.
pub fn set_auto_free(enabled: bool) {
    AUTO_FREE.store(enabled, Ordering::Relaxed);
}

/// Whether the option is on and `chars` has used up the free tier.
fn limit_reached_for(auto_free: bool, chars: u64) -> bool {
    auto_free && chars >= FREE_CHARS
}

/// True when BASIC must not be used any more this month (option on and the
/// free tier used up).
pub fn limit_reached() -> bool {
    let auto = AUTO_FREE.load(Ordering::Relaxed);
    auto && limit_reached_for(auto, get().chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_code_points_not_bytes() {
        assert_eq!(billed_chars(&["abc", "è ü"]), 6);
        assert_eq!(billed_chars(&["日本語"]), 3);
        assert_eq!(billed_chars::<&str>(&[]), 0);
    }

    #[test]
    fn a_new_month_starts_from_zero() {
        let old = BasicUsage { month: "2026-10".into(), chars: 900 };
        assert_eq!(for_month(Some(old.clone()), "2026-11").chars, 0);
        assert_eq!(for_month(Some(old), "2026-10").chars, 900);
        assert_eq!(for_month(None, "2026-11").month, "2026-11");
    }

    #[test]
    fn limit_only_with_the_option_on() {
        assert!(!limit_reached_for(false, FREE_CHARS * 2));
        assert!(!limit_reached_for(true, FREE_CHARS - 1));
        assert!(limit_reached_for(true, FREE_CHARS));
    }

    #[test]
    fn json_shape_is_camel_case() {
        let u = BasicUsage { month: "2026-11".into(), chars: 12 };
        assert_eq!(serde_json::to_string(&u).unwrap(), r#"{"month":"2026-11","chars":12}"#);
    }
}
