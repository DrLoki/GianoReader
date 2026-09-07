//! Async Google Translate bridge.
//!
//! Ports the FREE Google Translate logic from `src/translator.js` to Rust.
//! Uses the unofficial `translate.googleapis.com` endpoint — no API key required.
//! Suitable for personal use only.

use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

/// Maximum characters per single translation request (~5000 is Google's limit).
const CHAR_LIMIT: usize = 4500;

/// Maximum characters per batch for Cloud Translation v3 (official limit: 30k codepoints).
const CHAR_LIMIT_V3: usize = 25000;

/// Errors returned by the translation engine.
#[derive(Debug)]
pub enum TranslateError {
    /// The HTTP request to Google Translate failed.
    NetworkFailure(String),
    /// The translation engine is not configured or unavailable.
    #[allow(dead_code)]
    NotConfigured,
    /// Invalid API credentials (403).
    InvalidCredentials(String),
    /// Rate limit / quota exceeded (429).
    RateLimited,
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranslateError::NetworkFailure(msg) => write!(f, "Translation network failure: {}", msg),
            TranslateError::NotConfigured => write!(f, "Translation engine not configured"),
            TranslateError::InvalidCredentials(msg) => write!(f, "Invalid credentials: {}", msg),
            TranslateError::RateLimited => write!(f, "Translation quota exceeded (rate limited)"),
        }
    }
}

impl std::error::Error for TranslateError {}

/// A batch of consecutive paragraphs joined by `\n\n`.
struct Batch {
    /// Index of the first paragraph in this batch (within the original `texts` array).
    start: usize,
    /// One-past-the-end index.
    end: usize,
    /// The joined text for this batch.
    text: String,
}

/// Translates an array of text strings using the free Google Translate endpoint.
///
/// Paragraphs are grouped into batches of up to [`CHAR_LIMIT`] characters (joined by `\n\n`),
/// each batch is sent as a GET request to the Google Translate API, and the response is split
/// back to re-align with the original paragraphs.
///
/// # Arguments
/// * `texts` — The paragraphs to translate (order is preserved).
/// * `source_lang` — BCP-47 source language code (e.g. `"en"`, `"auto"` for auto-detect).
/// * `target_lang` — BCP-47 target language code (e.g. `"it"`).
///
/// # Returns
/// A `Vec<String>` of the same length as `texts`, where `result[i]` is the translation of `texts[i]`.
pub async fn translate(
    texts: Vec<String>,
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, TranslateError> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let client = Client::new();
    let mut results: Vec<String> = vec![String::new(); texts.len()];

    // Build batches respecting CHAR_LIMIT
    let batches = build_batches(&texts);

    for batch in &batches {
        let translated = translate_chunk(&client, &batch.text, source_lang, target_lang).await?;
        let count = batch.end - batch.start;

        // Split the translated text by double-newline to realign with original paragraphs
        match realign_batch(&translated, count) {
            Some(parts) => {
                for (j, part) in parts.into_iter().enumerate() {
                    results[batch.start + j] = part;
                }
            }
            None => {
                // The translation engine did not preserve the "\n\n" separators
                // exactly (common with short dialogue-style lines, e.g.
                // "-i miss you"), so the split can't be trusted: fall back to
                // translating each paragraph in this batch individually to
                // avoid silently losing/misaligning text.
                for j in 0..count {
                    let idx = batch.start + j;
                    let single = translate_chunk(&client, &texts[idx], source_lang, target_lang).await?;
                    results[idx] = single.trim().to_string();
                }
            }
        }
    }

    Ok(results)
}

// ── Cloud Translation API v2 (Basic mode) ─────────────────────────────────────

/// A single translation entry in the v2 response.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationEntryV2 {
    translated_text: String,
}

/// Nested data wrapper in v2 response.
#[derive(Deserialize)]
struct TranslateV2ResponseData {
    translations: Vec<TranslationEntryV2>,
}

/// Response body from Cloud Translation API v2.
#[derive(Deserialize)]
struct TranslateV2Response {
    data: TranslateV2ResponseData,
}

/// A batch of consecutive paragraph indices for v2.
struct BatchV2 {
    start: usize,
    end: usize,
}

/// Maximum segments per v2 request.
const MAX_SEGMENTS_V2: usize = 128;

/// Translates an array of text strings using Google Cloud Translation API v2.
///
/// Uses the `q[]` array natively — no `\n\n` join/split workaround needed.
/// Batches by total character length up to [`CHAR_LIMIT_V3`] and max 128 segments.
///
/// # Arguments
/// * `texts` — The paragraphs to translate (order is preserved).
/// * `source_lang` — BCP-47 source language code (e.g. `"en"`, `"auto"`).
/// * `target_lang` — BCP-47 target language code (e.g. `"it"`).
/// * `api_key` — Google Cloud API key.
pub async fn translate_v2(
    texts: Vec<String>,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<Vec<String>, TranslateError> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let client = Client::new();
    let mut results: Vec<String> = vec![String::new(); texts.len()];

    // Build batches respecting CHAR_LIMIT_V3 and MAX_SEGMENTS_V2
    let batches = build_batches_v2(&texts);

    for batch in &batches {
        let slice: Vec<String> = texts[batch.start..batch.end].to_vec();
        let translated = translate_chunk_v2(
            &client, slice, source_lang, target_lang, api_key,
        )
        .await?;

        for (j, text) in translated.into_iter().enumerate() {
            results[batch.start + j] = text;
        }
    }

    Ok(results)
}

/// Groups paragraphs into batches where the sum of text lengths ≤ [`CHAR_LIMIT_V3`]
/// and count ≤ [`MAX_SEGMENTS_V2`].
fn build_batches_v2(texts: &[String]) -> Vec<BatchV2> {
    let mut batches = Vec::new();
    let mut batch_start: usize = 0;
    let mut batch_len: usize = 0;

    for (i, para) in texts.iter().enumerate() {
        let para_len = para.len();
        let batch_count = i - batch_start;
        if batch_len > 0 && ((batch_len + para_len) > CHAR_LIMIT_V3 || batch_count >= MAX_SEGMENTS_V2) {
            batches.push(BatchV2 {
                start: batch_start,
                end: i,
            });
            batch_start = i;
            batch_len = para_len;
        } else {
            batch_len += para_len;
        }
    }

    if batch_start < texts.len() {
        batches.push(BatchV2 {
            start: batch_start,
            end: texts.len(),
        });
    }

    batches
}

/// Sends a batch to the Cloud Translation API v2 and returns translated texts.
async fn translate_chunk_v2(
    client: &Client,
    q: Vec<String>,
    source_lang: &str,
    target_lang: &str,
    api_key: &str,
) -> Result<Vec<String>, TranslateError> {
    let url = format!(
        "https://translation.googleapis.com/language/translate/v2?key={}",
        api_key,
    );

    let mut body = serde_json::json!({
        "q": q,
        "target": target_lang,
        "format": "text"
    });

    if source_lang != "auto" && !source_lang.is_empty() {
        body["source"] = serde_json::Value::String(source_lang.to_string());
    }

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| TranslateError::NetworkFailure(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let err_text = response.text().await.unwrap_or_default();
        if status.as_u16() == 403 {
            return Err(TranslateError::InvalidCredentials(format!(
                "HTTP 403: {}",
                truncate_error(&err_text, 200)
            )));
        }
        if status.as_u16() == 429 {
            return Err(TranslateError::RateLimited);
        }
        return Err(TranslateError::NetworkFailure(format!(
            "Cloud Translation v2 error: HTTP {} — {}",
            status.as_u16(),
            truncate_error(&err_text, 200)
        )));
    }

    let data: TranslateV2Response = response.json().await.map_err(|e| {
        TranslateError::NetworkFailure(format!("Failed to parse v2 response: {}", e))
    })?;

    Ok(data
        .data
        .translations
        .into_iter()
        .map(|t| t.translated_text.trim().to_string())
        .collect())
}

/// Truncates an error string for display.
fn truncate_error(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        s
    } else {
        &s[..max_len]
    }
}

/// Attempts to split `translated` back into `count` pieces using the `"\n\n"`
/// separator used when joining the batch. Returns `None` if the number of
/// resulting pieces doesn't match `count` — this happens when the translation
/// engine reflows/merges short adjacent lines (e.g. short dialogue) and does
/// not preserve the separator reliably, meaning the split cannot be trusted
/// to realign translations with their original paragraphs.
fn realign_batch(translated: &str, count: usize) -> Option<Vec<String>> {
    let parts: Vec<&str> = translated.split("\n\n").collect();
    if parts.len() != count {
        return None;
    }
    Some(parts.iter().map(|s| s.trim().to_string()).collect())
}

/// Groups paragraphs into batches that don't exceed [`CHAR_LIMIT`] when joined by `\n\n`.
fn build_batches(texts: &[String]) -> Vec<Batch> {
    let mut batches = Vec::new();
    let mut batch_start: usize = 0;
    let mut batch_text = String::new();

    for (i, para) in texts.iter().enumerate() {
        let separator = if batch_text.is_empty() { "" } else { "\n\n" };
        let would_be_len = batch_text.len() + separator.len() + para.len();

        if !batch_text.is_empty() && would_be_len > CHAR_LIMIT {
            // Flush current batch
            batches.push(Batch {
                start: batch_start,
                end: i,
                text: batch_text,
            });
            batch_start = i;
            batch_text = para.clone();
        } else {
            if !batch_text.is_empty() {
                batch_text.push_str("\n\n");
            }
            batch_text.push_str(para);
        }
    }

    // Flush remaining
    if !batch_text.is_empty() {
        batches.push(Batch {
            start: batch_start,
            end: texts.len(),
            text: batch_text,
        });
    }

    batches
}

/// Translates a single already-prepared text chunk (which may itself contain
/// multiple paragraphs joined by `\n\n`) using the free Google Translate
/// endpoint, without any batching or realignment.
///
/// This mirrors the behaviour of the JS `translateChunk()` helper in
/// `src/translator.js`: the caller is responsible for splitting/joining
/// paragraphs before calling this function, and for re-splitting the
/// returned string afterwards if needed.
pub async fn translate_chunk_raw(
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, TranslateError> {
    let client = Client::new();
    translate_chunk(&client, text, source_lang, target_lang).await
}

/// Sends a single batch to the Google Translate endpoint and returns the translated text.
async fn translate_chunk(
    client: &Client,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, TranslateError> {
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
        source_lang,
        target_lang,
        urlencoding_encode(text),
    );

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TranslateError::NetworkFailure(e.to_string()))?;

    if !response.status().is_success() {
        return Err(TranslateError::NetworkFailure(format!(
            "Translation error: HTTP {}",
            response.status().as_u16()
        )));
    }

    let data: Value = response
        .json()
        .await
        .map_err(|e| TranslateError::NetworkFailure(format!("Failed to parse response: {}", e)))?;

    // Response structure: data[0] is an array of segments, each segment[0] is translated text
    let segments = data
        .get(0)
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            TranslateError::NetworkFailure("Unexpected response format: missing segments".into())
        })?;

    let mut result = String::new();
    for segment in segments {
        if let Some(translated_part) = segment.get(0).and_then(|v| v.as_str()) {
            result.push_str(translated_part);
        }
    }

    Ok(result)
}

/// Percent-encodes a string for use in a URL query parameter.
/// Uses the same encoding as JavaScript's `encodeURIComponent`.
fn urlencoding_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            // Unreserved characters (RFC 3986)
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_batches_empty() {
        let texts: Vec<String> = vec![];
        let batches = build_batches(&texts);
        assert!(batches.is_empty());
    }

    #[test]
    fn test_build_batches_single_paragraph() {
        let texts = vec!["Hello world".to_string()];
        let batches = build_batches(&texts);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 1);
        assert_eq!(batches[0].text, "Hello world");
    }

    #[test]
    fn test_build_batches_multiple_fit_in_one() {
        let texts = vec![
            "Short paragraph one.".to_string(),
            "Short paragraph two.".to_string(),
            "Short paragraph three.".to_string(),
        ];
        let batches = build_batches(&texts);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 3);
        assert_eq!(
            batches[0].text,
            "Short paragraph one.\n\nShort paragraph two.\n\nShort paragraph three."
        );
    }

    #[test]
    fn test_build_batches_split_on_limit() {
        // Create paragraphs that will exceed CHAR_LIMIT when combined
        let long_para = "x".repeat(2300);
        let texts = vec![long_para.clone(), long_para.clone(), long_para.clone()];
        let batches = build_batches(&texts);
        // First batch: para 0 + para 1 = 2300 + 2 + 2300 = 4602 > 4500
        // So first batch is just para 0 (2300 chars), second batch starts at 1
        // para 1 + para 2 = 2300 + 2 + 2300 = 4602 > 4500
        // So second batch is just para 1, third batch is para 2
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 1);
        assert_eq!(batches[1].start, 1);
        assert_eq!(batches[1].end, 2);
        assert_eq!(batches[2].start, 2);
        assert_eq!(batches[2].end, 3);
    }

    #[test]
    fn test_build_batches_exact_limit() {
        // Two paragraphs that together are exactly at the limit
        let para_len = (CHAR_LIMIT - 2) / 2; // subtract 2 for the "\n\n" separator
        let para = "a".repeat(para_len);
        let texts = vec![para.clone(), para.clone()];
        let batches = build_batches(&texts);
        // Should fit in one batch: para_len + 2 + para_len = CHAR_LIMIT
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 2);
    }

    #[test]
    fn test_build_batches_preserves_order() {
        let texts: Vec<String> = (0..10).map(|i| format!("Paragraph {}", i)).collect();
        let batches = build_batches(&texts);
        // All should fit in one batch since they're very short
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 10);
    }

    #[test]
    fn test_urlencoding_basic() {
        assert_eq!(urlencoding_encode("hello"), "hello");
        assert_eq!(urlencoding_encode("hello world"), "hello%20world");
        assert_eq!(urlencoding_encode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn test_urlencoding_unicode() {
        // "café" in UTF-8 is: 63 61 66 C3 A9
        let encoded = urlencoding_encode("café");
        assert_eq!(encoded, "caf%C3%A9");
    }

    #[test]
    fn test_urlencoding_newlines() {
        let encoded = urlencoding_encode("line1\n\nline2");
        assert_eq!(encoded, "line1%0A%0Aline2");
    }

    #[tokio::test]
    async fn test_translate_empty_input() {
        let result = translate(vec![], "en", "it").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn test_realign_batch_matching_count() {
        let result = realign_batch("Ciao\n\nMondo", 2);
        assert_eq!(result, Some(vec!["Ciao".to_string(), "Mondo".to_string()]));
    }

    #[test]
    fn test_realign_batch_trims_each_part() {
        let result = realign_batch(" Ciao \n\n Mondo ", 2);
        assert_eq!(result, Some(vec!["Ciao".to_string(), "Mondo".to_string()]));
    }

    #[test]
    fn test_realign_batch_mismatch_returns_none() {
        // Simulates the engine merging two short dialogue lines into one
        // segment, so only 1 piece comes back instead of the expected 2.
        let result = realign_batch("mi manchi anche tu", 2);
        assert_eq!(result, None);
    }

    #[test]
    fn test_realign_batch_single_paragraph() {
        let result = realign_batch("Ciao mondo", 1);
        assert_eq!(result, Some(vec!["Ciao mondo".to_string()]));
    }

    // ── Cloud Translation v2 batching tests ──────────────────────────────

    #[test]
    fn test_build_batches_v2_empty() {
        let texts: Vec<String> = vec![];
        let batches = build_batches_v2(&texts);
        assert!(batches.is_empty());
    }

    #[test]
    fn test_build_batches_v2_single() {
        let texts = vec!["Hello".to_string()];
        let batches = build_batches_v2(&texts);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 1);
    }

    #[test]
    fn test_build_batches_v2_all_fit() {
        let texts: Vec<String> = (0..100).map(|i| format!("Paragraph {}", i)).collect();
        let batches = build_batches_v2(&texts);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 100);
    }

    #[test]
    fn test_build_batches_v2_split_on_limit() {
        // Each paragraph is 10000 chars → 3 paragraphs = 30000 > 25000 limit
        let long_para = "x".repeat(10000);
        let texts = vec![long_para.clone(), long_para.clone(), long_para.clone()];
        let batches = build_batches_v2(&texts);
        // First batch: para 0 + para 1 = 20000 ≤ 25000 → fits
        // Adding para 2: 20000 + 10000 = 30000 > 25000 → flush
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 2);
        assert_eq!(batches[1].start, 2);
        assert_eq!(batches[1].end, 3);
    }

    #[test]
    fn test_build_batches_v2_split_on_segment_count() {
        // 200 short paragraphs → should split at 128
        let texts: Vec<String> = (0..200).map(|i| format!("P{}", i)).collect();
        let batches = build_batches_v2(&texts);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].start, 0);
        assert_eq!(batches[0].end, 128);
        assert_eq!(batches[1].start, 128);
        assert_eq!(batches[1].end, 200);
    }

    #[tokio::test]
    async fn test_translate_v2_empty_input() {
        let result = translate_v2(vec![], "en", "it", "fake-key").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
}
