//! Re-projection of a translated paragraph onto the original layout: the
//! translated text is split across the paragraph's segments (column / page
//! pieces) proportionally to the amount of original text each held,
//! cutting at word boundaries and preferring sentence boundaries.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistUnit {
    pub text: String,
    pub weights: Vec<f32>,
}

fn is_sentence_end(word: &str) -> bool {
    crate::pdf_layout::text::ends_terminal(word) || word.ends_with(';')
}

pub fn distribute(text: &str, weights: &[f32]) -> Vec<String> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![text.trim().to_string()];
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return vec![String::new(); n];
    }
    let mut w: Vec<f32> = weights.iter().map(|x| if x.is_finite() { x.max(0.0) } else { 0.0 }).collect();
    let total_w: f32 = w.iter().sum();
    if total_w <= 0.0 {
        w = vec![1.0; n];
    }
    let total_w: f32 = w.iter().sum();

    // prefix[b] = characters (incl. one space) of words[..b]
    let mut prefix = vec![0usize; words.len() + 1];
    for (i, wd) in words.iter().enumerate() {
        prefix[i + 1] = prefix[i] + wd.chars().count() + 1;
    }
    let total_len = prefix[words.len()] as f32;
    let bonus = 0.12 * total_len;

    let mut cuts = Vec::with_capacity(n - 1);
    let mut start = 0usize;
    let mut cum = 0.0f32;
    for k in 0..n - 1 {
        cum += w[k];
        let target = cum / total_w * total_len;
        let remaining_segs = n - 1 - k;
        let max_b = words.len().saturating_sub(remaining_segs).max(start);
        let min_b = if start < max_b { start + 1 } else { start };
        let mut best = (f32::INFINITY, min_b);
        for b in min_b..=max_b {
            let mut cost = (prefix[b] as f32 - target).abs();
            if b > 0 && is_sentence_end(words[b - 1]) {
                cost -= bonus;
            }
            if cost < best.0 {
                best = (cost, b);
            }
        }
        cuts.push(best.1);
        start = best.1;
    }
    let mut out = Vec::with_capacity(n);
    let mut s = 0;
    for &c in cuts.iter().chain(std::iter::once(&words.len())) {
        out.push(words[s..c].join(" "));
        s = c;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proportional_split() {
        let t = "uno due tre quattro cinque sei sette otto nove dieci";
        let parts = distribute(t, &[1.0, 1.0]);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts.join(" "), t);
        let (a, b) = (parts[0].len() as i32, parts[1].len() as i32);
        assert!((a - b).abs() < 12, "{parts:?}");
    }

    #[test]
    fn prefers_sentence_boundary() {
        let t = "Prima frase breve. Seconda frase che continua parecchio oltre il punto medio del testo";
        let parts = distribute(t, &[0.3, 0.7]);
        assert_eq!(parts[0], "Prima frase breve.");
    }

    #[test]
    fn more_segments_than_words() {
        let parts = distribute("ciao", &[1.0, 1.0, 1.0]);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.concat(), "ciao");
    }
}
