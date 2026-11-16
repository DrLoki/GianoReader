//! Text-level helpers: normalisation, fragment joining, de-hyphenation and
//! the small lexical heuristics used by role detection and stitching.

pub const SOFT_HYPHEN: char = '\u{00AD}';

/// Normalise a raw text run: expand typographic ligatures, drop line feeds
/// that pdf.js appends on end-of-line runs, map exotic spaces to ' '.
pub fn normalize_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{FB00}' => out.push_str("ff"),
            '\u{FB01}' => out.push_str("fi"),
            '\u{FB02}' => out.push_str("fl"),
            '\u{FB03}' => out.push_str("ffi"),
            '\u{FB04}' => out.push_str("ffl"),
            '\u{FB05}' | '\u{FB06}' => out.push_str("st"),
            '\n' | '\r' => {}
            '\t' | '\u{00A0}' | '\u{2007}' | '\u{202F}' | '\u{2009}' | '\u{200A}' => out.push(' '),
            '\u{200B}' | '\u{FEFF}' => {}
            _ => out.push(c),
        }
    }
    out
}

/// Number of non-whitespace characters (used by the conservation invariant).
pub fn visible_len(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

/// Append `next` to `acc`, inserting a space only when the geometric gap
/// between the two runs looks like a word space (pdf.js splits words into
/// several runs on kerning / font changes, so blindly joining with ' '
/// produces "tra duzione").
pub fn push_fragment(acc: &mut String, next: &str, gap: f32, font_size: f32) {
    if acc.is_empty() {
        acc.push_str(next.trim_start());
        return;
    }
    let acc_space = acc.ends_with(' ');
    let next_space = next.starts_with(' ');
    let word_gap = gap > 0.15 * font_size.max(1.0);
    if word_gap && !acc_space && !next_space {
        acc.push(' ');
    }
    if acc_space && next_space {
        acc.push_str(next.trim_start());
    } else {
        acc.push_str(next);
    }
}

pub fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c == ' ' {
            if !prev_space {
                out.push(c);
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

const CLOSERS: &[char] = &['"', '\'', '’', '”', '»', ')', ']', '}', '*', '†', '‡'];

/// True if the text ends a sentence (and therefore can end a paragraph).
pub fn ends_terminal(s: &str) -> bool {
    let t = s.trim_end();
    // strip closing quotes / brackets, and trailing footnote markers like "word.¹" / "word.12"
    let t = t.trim_end_matches(|c: char| CLOSERS.contains(&c) || is_superscript_digit(c));
    match t.chars().last() {
        Some(c) => matches!(c, '.' | '!' | '?' | '…' | ':' | '。' | '！' | '？'),
        None => false,
    }
}

fn is_superscript_digit(c: char) -> bool {
    matches!(c, '¹' | '²' | '³' | '⁰' | '⁴' | '⁵' | '⁶' | '⁷' | '⁸' | '⁹')
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hyphen {
    None,
    Soft,
    Hard,
}

pub fn trailing_hyphen(s: &str) -> Hyphen {
    let t = s.trim_end();
    let mut it = t.chars().rev();
    match (it.next(), it.next()) {
        (Some(SOFT_HYPHEN), _) => Hyphen::Soft,
        (Some('-') | Some('\u{2010}'), Some(prev)) if prev.is_alphabetic() => Hyphen::Hard,
        _ => Hyphen::None,
    }
}

pub fn starts_lowercase(s: &str) -> bool {
    s.trim_start()
        .trim_start_matches(['"', '\'', '‘', '“', '«', '(', '['])
        .chars()
        .next()
        .map(|c| c.is_lowercase())
        .unwrap_or(false)
}

/// Join two consecutive lines (or paragraph pieces) of the same paragraph,
/// removing end-of-line hyphenation. Returns the joined text and whether a
/// hyphen was removed / a word rejoined.
#[allow(dead_code)] // usata solo dai test; tenuta allineata a PDF X-Ray
pub fn join_lines(a: &str, b: &str) -> (String, bool) {
    join_lines_with(a, b, false)
}

/// Like [`join_lines`]; with `keep_hard_hyphens` a line-final '-' is treated
/// as part of a compound ("storm-" + "blasted" → "storm-blasted"). This is
/// right for documents whose typesetter marks discretionary breaks with a
/// soft hyphen (U+00AD), so that '-' at a line end is always a real hyphen.
pub fn join_lines_with(a: &str, b: &str, keep_hard_hyphens: bool) -> (String, bool) {
    let a_t = a.trim_end();
    let b_t = b.trim_start();
    if a_t.is_empty() {
        return (b_t.to_string(), false);
    }
    if b_t.is_empty() {
        return (a_t.to_string(), false);
    }
    match trailing_hyphen(a_t) {
        Hyphen::Soft => {
            let mut s = a_t.trim_end_matches(SOFT_HYPHEN).to_string();
            s.push_str(b_t);
            (s, true)
        }
        Hyphen::Hard => {
            if starts_lowercase(b_t) && !keep_hard_hyphens {
                let mut s = a_t[..a_t.len() - a_t.chars().last().unwrap().len_utf8()].to_string();
                s.push_str(b_t);
                (s, true)
            } else {
                // "Jean-" + "Paul": keep the hyphen, no space
                (format!("{}{}", a_t, b_t), true)
            }
        }
        Hyphen::None => (format!("{} {}", a_t, b_t), false),
    }
}

/// Remove soft hyphens that are not at a line end.
#[allow(dead_code)] // API di PDF X-Ray, non usata qui
pub fn strip_inner_soft_hyphens(s: &str) -> String {
    s.chars().filter(|&c| c != SOFT_HYPHEN).collect()
}

/// Key used to recognise running heads / footers repeated across pages:
/// lowercase, digits folded to '#', whitespace collapsed.
pub fn repetition_key(s: &str) -> String {
    let folded: String = s
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c.to_lowercase().next().unwrap_or(c) })
        .collect();
    let mut key = collapse_spaces(&folded);
    // fold roman numerals used as folios at either end ("xii", "iv")
    let parts: Vec<&str> = key.split(' ').collect();
    if parts.len() > 1 {
        let is_roman = |p: &str| !p.is_empty() && p.len() <= 7 && p.chars().all(|c| "ivxlcdm".contains(c));
        let mut p = parts.clone();
        if is_roman(p[0]) {
            p[0] = "#";
        }
        let last = p.len() - 1;
        if is_roman(p[last]) {
            p[last] = "#";
        }
        key = p.join(" ");
    }
    key
}

/// "12", "- 12 -", "xii", "Page 3", "3 / 120", "p. 4", "Pag. 7 di 30"…
pub fn is_page_number(s: &str) -> bool {
    let t = collapse_spaces(&s.to_lowercase());
    if t.is_empty() || t.chars().count() > 20 {
        return false;
    }
    let t = t.trim_matches(|c: char| c == '-' || c == '–' || c == '—' || c == '|' || c == ' ' || c == '[' || c == ']');
    let t = ["page ", "pagina ", "pag. ", "pag ", "p. ", "seite ", "s. "]
        .iter()
        .fold(t.to_string(), |acc, p| acc.strip_prefix(p).map(|r| r.to_string()).unwrap_or(acc));
    let tokens: Vec<&str> = t.split([' ', '/']).filter(|x| !x.is_empty()).collect();
    if tokens.is_empty() || tokens.len() > 3 {
        return false;
    }
    let is_num = |p: &str| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit());
    let is_roman = |p: &str| !p.is_empty() && p.len() <= 7 && p.chars().all(|c| "ivxlcdm".contains(c));
    match tokens.as_slice() {
        [a] => is_num(a) || is_roman(a),
        [a, b] => is_num(a) && is_num(b),
        [a, sep, b] => is_num(a) && is_num(b) && ["of", "di", "de", "von", "sur"].contains(sep),
        _ => false,
    }
}

/// Typical caption openers ("Fig. 3", "Figure 2:", "Tabella 1", "Source:"…).
pub fn has_caption_prefix(s: &str) -> bool {
    let t = s.trim_start().to_lowercase();
    const P: &[&str] = &[
        "fig.", "fig ", "figure", "figura", "figur ", "abb.", "abbildung", "tab.", "table", "tabella",
        "tableau", "tabelle", "tav.", "tavola", "chart", "grafico", "graph", "plate", "illustration",
        "illustrazione", "photo", "foto", "image", "immagine", "source:", "fonte:", "map ", "mappa",
        "diagram", "schema", "exhibit", "listing",
    ];
    P.iter().any(|p| {
        if let Some(rest) = t.strip_prefix(p) {
            // "Figure" alone is not enough: it must be followed by a number / label / punctuation
            p.ends_with(':') || rest.trim_start().chars().next().map(|c| c.is_ascii_digit() || c.is_ascii_uppercase() || c == ':' || c == '.' || "ivxlcdm".contains(c)).unwrap_or(false)
        } else {
            false
        }
    })
}

/// Bullet / enumeration at the start of a line: "• text", "– text", "1. text", "a) text".
pub fn starts_with_bullet(s: &str) -> bool {
    let t = s.trim_start();
    let mut chars = t.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if matches!(first, '•' | '◦' | '▪' | '‣' | '·' | '●' | '○' | '■' | '□' | '➢' | '►' | '✓' | '✔') {
        return true;
    }
    if matches!(first, '–' | '—' | '-' | '*') {
        return chars.next() == Some(' ');
    }
    // "1." "12)" "a)" "iv."
    let head: String = t.chars().take_while(|c| c.is_alphanumeric()).collect();
    if head.is_empty() || head.chars().count() > 4 {
        return false;
    }
    let after = &t[head.len()..];
    let numeric = head.chars().all(|c| c.is_ascii_digit());
    let letter = head.chars().count() == 1 && head.chars().all(|c| c.is_alphabetic());
    let roman = head.chars().all(|c| "ivxlcdm".contains(c));
    (numeric || letter || roman) && (after.starts_with(". ") || after.starts_with(") "))
}

pub fn strip_subset_prefix(name: &str) -> &str {
    // "ABCDEF+Garamond-Bold" -> "Garamond-Bold"
    match name.find('+') {
        Some(6) if name[..6].chars().all(|c| c.is_ascii_uppercase()) => &name[7..],
        _ => name,
    }
}

pub fn font_is_bold(name: &str) -> bool {
    let n = name.to_lowercase();
    ["bold", "black", "heavy", "semibold", "semibol", "demi", "extrab", "-bd", "-sb", "-hv", "medium"]
        .iter()
        .any(|k| n.contains(k))
}

pub fn font_is_italic(name: &str) -> bool {
    let n = name.to_lowercase();
    if n.contains("italic") || n.contains("oblique") || n.contains("kursiv") || n.contains("corsivo") {
        return true;
    }
    // style suffix after the last '-' : "Minion-It", "Plantin-BoldIt", "Garamond-SemiboldIt"
    match n.rsplit_once('-') {
        Some((_, style)) => style == "it" || style.ends_with("it") && style.len() <= 12,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_fragments_by_gap() {
        let mut s = String::new();
        push_fragment(&mut s, "tra", 0.0, 10.0);
        push_fragment(&mut s, "duzione", 0.3, 10.0);
        push_fragment(&mut s, "corretta", 3.0, 10.0);
        assert_eq!(s, "traduzione corretta");
        let mut s = String::from("word ");
        push_fragment(&mut s, " next", 3.0, 10.0);
        assert_eq!(s, "word next");
    }

    #[test]
    fn dehyphenates() {
        assert_eq!(join_lines("una tradu-", "zione").0, "una traduzione");
        assert_eq!(join_lines("una tradu\u{00AD}", "zione").0, "una traduzione");
        assert_eq!(join_lines("Jean-", "Paul Sartre").0, "Jean-Paul Sartre");
        assert_eq!(join_lines("fine riga", "inizio").0, "fine riga inizio");
        assert_eq!(join_lines("pagina 3 -", "nuovo").0, "pagina 3 - nuovo");
        assert_eq!(join_lines_with("storm-", "blasted", true).0, "storm-blasted");
    }

    #[test]
    fn terminal_punctuation() {
        assert!(ends_terminal("Fine della frase."));
        assert!(ends_terminal("Detto «così.»"));
        assert!(ends_terminal("vedi nota.¹"));
        assert!(!ends_terminal("continua nella"));
        assert!(!ends_terminal("elenco,"));
    }

    #[test]
    fn page_numbers() {
        for s in ["12", " - 12 - ", "xii", "Page 3", "3 / 120", "Pag. 7 di 30"] {
            assert!(is_page_number(s), "{s}");
        }
        for s in ["Introduction", "12 Angry Men", "Chapter 3"] {
            assert!(!is_page_number(s), "{s}");
        }
    }

    #[test]
    fn captions_and_bullets() {
        assert!(has_caption_prefix("Figure 3: the map"));
        assert!(has_caption_prefix("Fig. 2 – Schema"));
        assert!(has_caption_prefix("Tabella 1. Dati"));
        assert!(!has_caption_prefix("Figure out what to do"));
        assert!(!has_caption_prefix("Tablets are useful"));
        assert!(starts_with_bullet("• item"));
        assert!(starts_with_bullet("1. item"));
        assert!(starts_with_bullet("b) item"));
        assert!(!starts_with_bullet("Il 1990 fu"));
    }

    #[test]
    fn repetition_keys() {
        assert_eq!(repetition_key("Chapter 3  — Combat 45"), repetition_key("Chapter 4 — Combat 46"));
        assert_eq!(repetition_key("xii Introduction"), repetition_key("xiv Introduction"));
    }

    #[test]
    fn ligatures() {
        assert_eq!(normalize_fragment("e\u{FB03}cient\n"), "efficient");
    }
}
