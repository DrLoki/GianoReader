//! Block role classification.
//!
//! Page level: Tagged-PDF artifacts / structure roles when available, then
//! geometric + lexical heuristics (margins, page-number patterns, caption
//! prefixes, proximity to images, footnote markers).
//! Document level: running heads / footers are recognised because the same
//! text (digits folded) repeats at the same height on nearby pages.

use crate::pdf_layout::lines::{group_rows, Line};
use crate::pdf_layout::model::Bounds;
use crate::pdf_layout::text::{has_caption_prefix, is_page_number, repetition_key, visible_len};
use crate::pdf_layout::xycut::{BoxKind, Leaf};

pub const BODY: &str = "body";
pub const HEADING: &str = "heading";
pub const HEADER: &str = "header";
pub const FOOTER: &str = "footer";
pub const PAGE_NUMBER: &str = "page-number";
pub const CAPTION: &str = "caption";
pub const FOOTNOTE: &str = "footnote";
pub const SIDEBAR: &str = "sidebar";
pub const TABLE: &str = "table";
pub const FIGURE_TEXT: &str = "figure-text";
/// Ornamental glyphs set in a decorative font: not text, never translated.
pub const DECORATION: &str = "decoration";

/// Maps a (role-mapped) structure type to one of our roles.
pub fn struct_role_to_role(r: &str) -> Option<&'static str> {
    match r {
        "H" | "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "Title" => Some(HEADING),
        "Caption" => Some(CAPTION),
        "Note" | "FENote" => Some(FOOTNOTE),
        "Table" | "TR" | "TD" | "TH" | "THead" | "TBody" | "TFoot" => Some(TABLE),
        "Figure" | "Formula" => Some(FIGURE_TEXT),
        "P" | "LI" | "L" | "Lbl" | "LBody" | "BlockQuote" | "TOCI" | "TOC" | "Code" | "Div" | "Sect" | "Art" | "Part" => Some(BODY),
        _ => None,
    }
}

fn leaf_text(lines: &[Line], leaf: &Leaf) -> String {
    leaf.lines.iter().map(|&i| lines[i].text.as_str()).collect::<Vec<_>>().join(" ")
}

pub fn classify_leaf(lines: &[Line], leaf: &Leaf, page: &Bounds, images: &[Bounds], body_fs: f32, use_tags: bool) -> &'static str {
    let ls: Vec<&Line> = leaf.lines.iter().map(|&i| &lines[i]).collect();
    let total: usize = ls.iter().map(|l| l.chars().max(1)).sum();
    let text = leaf_text(lines, leaf);
    let b = leaf.bounds;
    let rows = group_rows(lines, &leaf.lines).len();

    // --- Tagged PDF: explicit artifacts and structure roles -------------
    if use_tags {
        let art: usize = ls.iter().filter(|l| l.artifact).map(|l| l.chars().max(1)).sum();
        if art * 10 >= total * 8 {
            if ls.iter().all(|l| l.rot != 0) {
                return FIGURE_TEXT; // rotated credit / margin label, not a running head
            }
            if is_page_number(&text) {
                return PAGE_NUMBER;
            }
            return if b.cy() < page.cy() { HEADER } else { FOOTER };
        }
        let mut votes: std::collections::HashMap<&'static str, usize> = Default::default();
        let mut tagged = 0usize;
        for l in &ls {
            if let Some(r) = l.struct_role.as_deref().and_then(struct_role_to_role) {
                *votes.entry(r).or_insert(0) += l.chars().max(1);
                tagged += l.chars().max(1);
            }
        }
        if tagged * 10 >= total * 7 {
            let (r, _) = votes.into_iter().max_by_key(|(_, n)| *n).unwrap();
            if r != BODY && r != HEADING {
                return r;
            }
        }
    }

    if ls.iter().all(|l| l.decor) {
        return DECORATION;
    }

    // --- boxes -------------------------------------------------------------
    match leaf.box_kind {
        Some(BoxKind::Table) => return TABLE,
        Some(BoxKind::Sidebar) => {
            if has_caption_prefix(&text) && rows <= 4 {
                return CAPTION;
            }
            return SIDEBAR;
        }
        None => {}
    }

    // --- rotated text (credits, margin captions): never part of the flow ---
    if ls.iter().all(|l| l.rot != 0) {
        return FIGURE_TEXT;
    }
    if rows == 1 && ls.len() == 1 && b.h > 2.5 * b.w && total > 3 {
        return FIGURE_TEXT;
    }

    // --- margins: header / footer / folio ---------------------------------
    let top_band = page.y + page.h * 0.07;
    let bottom_band = page.y1() - page.h * 0.07;
    let in_top = b.y1() <= top_band;
    let in_bottom = b.y >= bottom_band;
    if is_page_number(&text) && (b.y1() <= page.y + page.h * 0.12 || b.y >= page.y1() - page.h * 0.12) {
        return PAGE_NUMBER;
    }
    if rows <= 2 && in_top {
        return HEADER;
    }
    if rows <= 2 && in_bottom {
        return FOOTER;
    }

    let avg_fs = ls.iter().map(|l| l.fs * l.chars().max(1) as f32).sum::<f32>() / total as f32;
    let italic = ls.iter().filter(|l| l.italic).map(|l| l.chars()).sum::<usize>() * 2 > total;

    // --- captions ------------------------------------------------------------
    let near_image = images.iter().any(|img| {
        let below = b.y - img.y1();
        let above = img.y - b.y1();
        let close = (below >= -2.0 && below <= 2.5 * avg_fs) || (above >= -2.0 && above <= 2.5 * avg_fs);
        let beside = (b.x - img.x1()).abs() <= 2.0 * avg_fs || (img.x - b.x1()).abs() <= 2.0 * avg_fs;
        let h_ok = b.h_overlap(img) >= 0.5 * b.w.min(img.w);
        let v_ok = b.v_overlap(img) >= 0.5 * b.h;
        (close && h_ok) || (beside && v_ok)
    });
    let prefix = has_caption_prefix(&text);
    if rows <= 6 && prefix && (near_image || avg_fs < body_fs * 0.97 || italic) {
        return CAPTION;
    }
    if rows <= 4 && near_image && (avg_fs < body_fs * 0.97 || italic) {
        return CAPTION;
    }

    // --- footnotes -----------------------------------------------------------
    if b.y >= page.y + page.h * 0.6 && avg_fs <= body_fs * 0.9 {
        let first = text.trim_start().chars().next().unwrap_or(' ');
        let marker = first.is_ascii_digit() || matches!(first, '*' | '†' | '‡' | '§' | '¹' | '²' | '³' | '⁴' | '⁵' | '⁶' | '⁷' | '⁸' | '⁹');
        if marker || b.y >= page.y + page.h * 0.8 {
            return FOOTNOTE;
        }
    }

    if prefix && rows <= 3 {
        return CAPTION;
    }
    BODY
}

pub struct RunningCandidate {
    pub page_idx: usize,
    pub leaf_idx: usize,
    pub key: String,
    pub cy: f32,
    pub top: bool,
    pub page_number: bool,
}

/// Collect leaves in the outer 12% bands with at most two rows.
pub fn running_candidates(page_idx: usize, lines: &[Line], leaves: &[Leaf], roles: &[&'static str], page: &Bounds) -> Vec<RunningCandidate> {
    let mut out = Vec::new();
    for (k, leaf) in leaves.iter().enumerate() {
        if !matches!(roles[k], BODY | HEADING | HEADER | FOOTER | PAGE_NUMBER) || leaf.box_kind.is_some() {
            continue;
        }
        let b = leaf.bounds;
        let top = b.y1() <= page.y + page.h * 0.12;
        let bottom = b.y >= page.y1() - page.h * 0.12;
        if !(top || bottom) || group_rows(lines, &leaf.lines).len() > 2 {
            continue;
        }
        let text = leaf_text(lines, leaf);
        if visible_len(&text) == 0 {
            continue;
        }
        out.push(RunningCandidate {
            page_idx,
            leaf_idx: k,
            key: repetition_key(&text),
            cy: b.cy(),
            top,
            page_number: is_page_number(&text),
        });
    }
    out
}

/// Returns (page_idx, leaf_idx, role) for every candidate confirmed by
/// repetition on another page within ±4 pages.
pub fn confirm_running(cands: &[RunningCandidate], page_h: f32) -> Vec<(usize, usize, &'static str)> {
    let mut out = Vec::new();
    for c in cands {
        let repeated = cands.iter().any(|o| {
            o.page_idx != c.page_idx
                && (o.page_idx as i64 - c.page_idx as i64).abs() <= 4
                && (o.cy - c.cy).abs() <= page_h * 0.02 + 2.0
                && (o.key == c.key || (o.page_number && c.page_number))
        });
        if repeated {
            let role = if c.page_number { PAGE_NUMBER } else if c.top { HEADER } else { FOOTER };
            out.push((c.page_idx, c.leaf_idx, role));
        }
    }
    out
}
