//! Async Google Translate bridge.
//!
//! Ports the FREE Google Translate logic from `src/translator.js` to Rust.
//! Uses the unofficial `translate.googleapis.com` endpoint — no API key required.
//! Suitable for personal use only.

use reqwest::Client;
use serde_json::Value;

/// Maximum characters per single translation request (~5000 is Google's limit).
const CHAR_LIMIT: usize = 4500;

/// Errors returned by the translation engine.
#[derive(Debug)]
pub enum TranslateError {
    /// The HTTP request to Google Translate failed.
    NetworkFailure(String),
    /// The translation engine is not configured or unavailable.
    #[allow(dead_code)]
    NotConfigured,
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranslateError::NetworkFailure(msg) => write!(f, "Translation network failure: {}", msg),
            TranslateError::NotConfigured => write!(f, "Translation engine not configured"),
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

        // Split the translated text by double-newline to realign with original paragraphs
        let parts: Vec<&str> = translated.split("\n\n").collect();
        let count = batch.end - batch.start;

        for j in 0..count {
            results[batch.start + j] = parts
                .get(j)
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
        }
    }

    Ok(results)
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
}
