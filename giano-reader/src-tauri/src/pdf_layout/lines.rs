//! Line building: text runs → visual lines (the atomic unit of the layout
//! analysis). Doing this *before* XY-Cut guarantees that no run can be lost
//! inside a gap and that words split into several runs are rejoined
//! correctly. Drop caps are detected and merged with the first line they
//! introduce ("T" + "he Cosmere…" → "The Cosmere…").

use crate::pdf_layout::model::{Bounds, TextElement};
use crate::pdf_layout::text::{font_is_bold, font_is_italic, normalize_fragment, push_fragment, collapse_spaces, starts_lowercase, strip_subset_prefix, visible_len};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Frag {
    pub src: usize,
    pub text: String,
    pub b: Bounds,
    pub fs: f32,
    pub font: String,
    pub artifact: bool,
    pub struct_id: Option<u32>,
    pub struct_role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Line {
    pub frags: Vec<Frag>,
    pub text: String,
    pub b: Bounds,
    /// Dominant font size (weighted by characters).
    pub fs: f32,
    pub font: String,
    pub bold: bool,
    /// Share of characters set in a bold face (distinguishes a bold
    /// run-in head "**Chapter 1.** This walks…" from a real heading line).
    pub bold_ratio: f32,
    pub italic: bool,
    pub artifact: bool,
    pub struct_id: Option<u32>,
    pub struct_role: Option<String>,
    /// Content-stream order (index of the first run): used by the tagged path.
    pub order: usize,
    /// Bounds of the drop cap merged at the start of this line, if any.
    pub drop_cap: Option<Bounds>,
}

impl Line {
    pub fn chars(&self) -> usize {
        visible_len(&self.text)
    }
}

pub struct PageLines {
    pub lines: Vec<Line>,
    pub drop_caps: Vec<Bounds>,
}

/// Mode of `values`, each weighted by a character count, rounded to 0.5pt.
pub fn weighted_mode<I: IntoIterator<Item = (f32, usize)>>(values: I, fallback: f32) -> f32 {
    let mut counts: HashMap<i32, usize> = HashMap::new();
    for (v, w) in values {
        if v.is_finite() && v > 0.0 {
            *counts.entry((v * 2.0).round() as i32).or_insert(0) += w.max(1);
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(k, _)| k as f32 / 2.0)
        .unwrap_or(fallback)
}

fn to_frags(items: &[TextElement]) -> Vec<Frag> {
    items
        .iter()
        .enumerate()
        .filter_map(|(i, it)| {
            let text = normalize_fragment(&it.text);
            if text.trim().is_empty() {
                return None;
            }
            if !(it.x.is_finite() && it.y.is_finite() && it.width.is_finite() && it.height.is_finite()) {
                return None;
            }
            let h = if it.height > 0.1 { it.height } else { it.font_size.max(1.0) };
            let fs = if it.font_size > 0.1 { it.font_size } else { h };
            Some(Frag {
                src: i,
                text,
                b: Bounds { x: it.x, y: it.y, w: it.width.max(0.0), h },
                fs,
                font: strip_subset_prefix(it.font_name.as_deref().unwrap_or("default")).to_string(),
                artifact: it.artifact,
                struct_id: it.struct_id,
                struct_role: it.struct_role.clone(),
            })
        })
        .collect()
}

pub fn build_lines(items: &[TextElement]) -> PageLines {
    let frags = to_frags(items);
    if frags.is_empty() {
        return PageLines { lines: Vec::new(), drop_caps: Vec::new() };
    }
    let body_fs = weighted_mode(frags.iter().map(|f| (f.fs, visible_len(&f.text))), 10.0);

    // ---- 1. drop caps -----------------------------------------------------
    let mut keep = vec![true; frags.len()];
    let mut drops: Vec<(usize, usize)> = Vec::new(); // (drop cap frag idx, frag idx it introduces)
    for (i, f) in frags.iter().enumerate() {
        let t = f.text.trim();
        let n = t.chars().count();
        if n == 0 || n > 2 || !t.chars().any(|c| c.is_alphabetic()) {
            continue;
        }
        if f.fs < 2.5 * body_fs || f.b.h < 2.0 * body_fs {
            continue;
        }
        let target = frags
            .iter()
            .enumerate()
            .filter(|(j, g)| {
                *j != i
                    && g.fs < f.fs * 0.6
                    && g.b.x >= f.b.x1() - 2.0
                    && g.b.x <= f.b.x1() + 3.0 * g.fs
                    && g.b.cy() >= f.b.y
                    && g.b.cy() <= f.b.y1()
            })
            .min_by(|a, b| a.1.b.y.total_cmp(&b.1.b.y).then(a.1.b.x.total_cmp(&b.1.b.x)));
        if let Some((j, _)) = target {
            keep[i] = false;
            drops.push((i, j));
        }
    }

    // ---- 2. lines: sweep left→right, a run joins the line whose right end
    // is horizontally adjacent (gap ≤ 1em) and whose core overlaps it
    // vertically by at least half the smaller height. Wide gaps (column
    // gutters, table cells) therefore always start a new line, and a tall
    // run in one column can never bridge two lines of another column.
    let mut order: Vec<usize> = (0..frags.len()).filter(|&i| keep[i]).collect();
    order.sort_by(|&a, &b| frags[a].b.x.total_cmp(&frags[b].b.x).then(frags[a].b.y.total_cmp(&frags[b].b.y)));

    struct Cluster {
        core: Bounds,
        right: f32,
        fs: f32,
        members: Vec<usize>,
    }
    let mut clusters: Vec<Cluster> = Vec::new();
    for i in order {
        let f = &frags[i];
        let mut best: Option<(usize, f32)> = None;
        for (k, c) in clusters.iter().enumerate() {
            let gap = f.b.x - c.right;
            if gap > 1.0 * f.fs.max(c.fs) || gap < -0.5 * f.fs.max(c.fs) - f.b.w.min(c.core.w) * 0.5 {
                continue;
            }
            let ov = f.b.v_overlap(&c.core);
            if ov > 0.0 && ov >= 0.5 * f.b.h.min(c.core.h) && best.map(|(_, o)| ov > o).unwrap_or(true) {
                best = Some((k, ov));
            }
        }
        match best {
            Some((k, _)) => {
                let c = &mut clusters[k];
                if f.b.h > c.core.h {
                    c.core = f.b;
                    c.fs = f.fs;
                }
                c.right = c.right.max(f.b.x1());
                c.members.push(i);
            }
            None => clusters.push(Cluster { core: f.b, right: f.b.x1(), fs: f.fs, members: vec![i] }),
        }
    }
    let mut lines: Vec<Line> = clusters.iter().map(|c| make_line(&frags, &c.members)).collect();

    // ---- 4. attach drop caps ---------------------------------------------
    let mut drop_caps = Vec::new();
    for (dc, target) in drops {
        let d = &frags[dc];
        let src = frags[target].src;
        if let Some(line) = lines.iter_mut().find(|l| l.frags.iter().any(|f| f.src == src)) {
            let letter = d.text.trim();
            line.text = if starts_lowercase(&line.text) {
                format!("{}{}", letter, line.text)
            } else {
                format!("{} {}", letter, line.text)
            };
            line.b = Bounds::from_edges(d.b.x.min(line.b.x), line.b.y, line.b.x1(), line.b.y1());
            line.drop_cap = Some(d.b);
            line.order = line.order.min(d.src);
            let mut df = d.clone();
            df.fs = line.fs; // don't let the drop cap skew font statistics
            line.frags.insert(0, df);
            drop_caps.push(d.b);
        } else {
            lines.push(make_line(&frags, &[dc]));
        }
    }

    lines.sort_by(|a, b| a.b.y.total_cmp(&b.b.y).then(a.b.x.total_cmp(&b.b.x)));
    PageLines { lines, drop_caps }
}

fn make_line(frags: &[Frag], idxs: &[usize]) -> Line {
    let mut text = String::new();
    let mut prev_right: Option<f32> = None;
    for &i in idxs {
        let f = &frags[i];
        let gap = prev_right.map(|r| f.b.x - r).unwrap_or(0.0);
        push_fragment(&mut text, &f.text, gap, f.fs);
        prev_right = Some(prev_right.map(|r| r.max(f.b.x1())).unwrap_or(f.b.x1()));
    }
    let text = collapse_spaces(&text);
    let b = Bounds::union_all(idxs.iter().map(|&i| &frags[i].b)).unwrap_or_default();
    let fs = weighted_mode(idxs.iter().map(|&i| (frags[i].fs, visible_len(&frags[i].text))), frags[idxs[0]].fs);

    let mut font_chars: HashMap<&str, usize> = HashMap::new();
    let mut struct_chars: HashMap<u32, usize> = HashMap::new();
    let mut artifact_chars = 0usize;
    let mut bold_chars = 0usize;
    let mut total = 0usize;
    for &i in idxs {
        let f = &frags[i];
        let n = visible_len(&f.text).max(1);
        total += n;
        *font_chars.entry(f.font.as_str()).or_insert(0) += n;
        if let Some(s) = f.struct_id {
            *struct_chars.entry(s).or_insert(0) += n;
        }
        if f.artifact {
            artifact_chars += n;
        }
        if font_is_bold(&f.font) {
            bold_chars += n;
        }
    }
    let font = font_chars.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(f, _)| f.to_string()).unwrap_or_default();
    let struct_id = struct_chars.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(s, _)| s);
    let struct_role = struct_id.and_then(|s| idxs.iter().find(|&&i| frags[i].struct_id == Some(s)).and_then(|&i| frags[i].struct_role.clone()));
    Line {
        frags: idxs.iter().map(|&i| frags[i].clone()).collect(),
        text,
        b,
        fs,
        bold: font_is_bold(&font),
        bold_ratio: bold_chars as f32 / total.max(1) as f32,
        italic: font_is_italic(&font),
        font,
        artifact: artifact_chars * 2 > total,
        struct_id,
        struct_role,
        order: idxs.iter().map(|&i| frags[i].src).min().unwrap_or(0),
        drop_cap: None,
    }
}

/// Group lines (indices) into visual rows: lines sharing a baseline.
/// Rows are returned top-to-bottom, each row sorted left-to-right.
pub fn group_rows(lines: &[Line], idxs: &[usize]) -> Vec<Vec<usize>> {
    let mut sorted: Vec<usize> = idxs.to_vec();
    sorted.sort_by(|&a, &b| lines[a].b.cy().total_cmp(&lines[b].b.cy()));
    let mut rows: Vec<(Bounds, Vec<usize>)> = Vec::new();
    for i in sorted {
        let l = &lines[i];
        let core = if l.drop_cap.is_some() { Bounds { y: l.b.y1() - l.fs * 1.2, h: l.fs * 1.2, ..l.b } } else { l.b };
        match rows.last_mut() {
            Some((rb, members)) if core.v_overlap(rb) >= 0.5 * core.h.min(rb.h) && core.v_overlap(rb) > 0.0 => {
                members.push(i);
            }
            _ => rows.push((core, vec![i])),
        }
    }
    rows.into_iter()
        .map(|(_, mut m)| {
            m.sort_by(|&a, &b| lines[a].b.x.total_cmp(&lines[b].b.x));
            m
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(text: &str, x: f32, y: f32, w: f32, fs: f32) -> TextElement {
        TextElement { text: text.into(), x, y, width: w, height: fs * 1.15, font_size: fs, ..Default::default() }
    }

    #[test]
    fn rejoins_split_words_and_splits_columns() {
        let items = vec![
            el("tra", 50.0, 100.0, 15.0, 10.0),
            el("duzione", 65.2, 100.0, 35.0, 10.0),
            el("finale", 103.0, 100.0, 30.0, 10.0),
            // right column, same baseline, 20pt gutter
            el("colonna", 153.0, 100.0, 40.0, 10.0),
        ];
        let pl = build_lines(&items);
        let texts: Vec<&str> = pl.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec!["traduzione finale", "colonna"]);
    }

    #[test]
    fn merges_drop_cap() {
        let mut items = vec![TextElement { text: "T".into(), x: 56.0, y: 75.0, width: 33.0, height: 66.0, font_size: 57.0, ..Default::default() }];
        for k in 0..5 {
            let x = if k < 4 { 92.0 } else { 56.0 };
            let t = if k == 0 { "he Cosmere game is" } else { "more text here" };
            items.push(el(t, x, 94.7 + 13.0 * k as f32, 150.0, 9.5));
        }
        let pl = build_lines(&items);
        assert_eq!(pl.drop_caps.len(), 1);
        assert!(pl.lines.iter().any(|l| l.text.starts_with("The Cosmere")));
        assert_eq!(pl.lines.len(), 5);
    }
}
