//! Reading flow: paragraph segmentation inside blocks, Tagged-PDF units,
//! and stitching of paragraphs broken by column / page / box / figure
//! interruptions into *logical paragraphs* (the unit of translation).

use crate::pdf_layout::lines::{group_rows, Line};
use crate::pdf_layout::model::Bounds;
use crate::pdf_layout::roles::{self, BODY, HEADING, SIDEBAR};
use crate::pdf_layout::text::{ends_terminal, join_lines_with, starts_lowercase, starts_with_bullet, trailing_hyphen, Hyphen};
use crate::pdf_layout::xycut::Leaf;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct UnitSeg {
    pub leaf_idx: usize,
    pub lines: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct Unit {
    pub page_idx: usize,
    pub segs: Vec<UnitSeg>,
    pub role: &'static str,
    /// Stitching thread: "main" for body text, the box id for sidebars,
    /// None for units that are never stitched (captions, headers…).
    pub thread: Option<String>,
    pub text: String,
    pub first_in_block: bool,
    pub last_in_block: bool,
    pub first_indented: bool,
    pub last_line_full: bool,
    pub rows: usize,
    pub first_fs: f32,
    pub last_fs: f32,
    pub first_bold: bool,
    pub last_bold: bool,
    pub tagged: bool,
}

struct Row {
    idxs: Vec<usize>,
    b: Bounds,
    text: String,
    fs: f32,
    /// Entire row set in bold (≥ 95% of characters).
    bold: bool,
}

fn make_rows(lines: &[Line], idxs: &[usize]) -> Vec<Row> {
    group_rows(lines, idxs)
        .into_iter()
        .map(|r| {
            // reading-frame bounds: indentation and spacing of rotated text
            // are measured along its own axes
            let b = Bounds::union_all(r.iter().map(|&i| &lines[i].fb)).unwrap_or_default();
            let text = r.iter().map(|&i| lines[i].text.as_str()).collect::<Vec<_>>().join(" ");
            let chars: usize = r.iter().map(|&i| lines[i].chars().max(1)).sum();
            let fs = r.iter().map(|&i| lines[i].fs * lines[i].chars().max(1) as f32).sum::<f32>() / chars as f32;
            let bold_chars: f32 = r.iter().map(|&i| lines[i].bold_ratio * lines[i].chars().max(1) as f32).sum();
            let bold = bold_chars >= 0.95 * chars as f32;
            Row { idxs: r, b, text, fs, bold }
        })
        .collect()
}

fn starts_upper_or_digit(s: &str) -> bool {
    s.trim_start()
        .trim_start_matches(['"', '\'', '‘', '“', '«', '(', '['])
        .chars()
        .next()
        .map(|c| c.is_uppercase() || c.is_ascii_digit())
        .unwrap_or(false)
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

fn join_rows(rows: &[&Row], keep_hard: bool) -> String {
    let mut t = String::new();
    for r in rows {
        t = join_lines_with(&t, &r.text, keep_hard).0;
    }
    t
}

/// Split the rows of a leaf into paragraphs. Returns the paragraphs as row
/// index ranges plus block metrics.
fn split_paragraphs(rows: &[Row], drop_caps: &[Bounds]) -> (Vec<std::ops::Range<usize>>, f32, f32) {
    let n = rows.len();
    let left = rows.iter().map(|r| r.b.x).fold(f32::INFINITY, f32::min);
    let right = if n >= 3 {
        let mut xs: Vec<f32> = rows.iter().map(|r| r.b.x1()).collect();
        xs.sort_by(|a, b| a.total_cmp(b));
        xs[((n as f32 * 0.9).ceil() as usize).min(n) - 1]
    } else {
        rows.iter().map(|r| r.b.x1()).fold(f32::NEG_INFINITY, f32::max)
    };
    if n <= 1 {
        return (vec![0..n], left, right);
    }
    let width = (right - left).max(1.0);
    let body_fs = median(rows.iter().map(|r| r.fs).collect()).unwrap_or(10.0);
    let justified = n >= 3 && {
        let full = rows[..n - 1].iter().filter(|r| r.b.x1() >= right - body_fs).count();
        full as f32 >= 0.6 * (n - 1) as f32
    };
    let leads: Vec<f32> = rows.windows(2).map(|w| w[1].b.cy() - w[0].b.cy()).filter(|d| *d > 0.0).collect();
    let lead = median(leads).unwrap_or(body_fs * 1.2);

    let in_shadow = |r: &Row| drop_caps.iter().any(|d| r.b.y < d.y1() && r.b.y1() > d.y - 2.0 && r.b.x >= d.x1() - 2.0);

    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..n {
        let (p, c) = (&rows[i - 1], &rows[i]);
        let fs = p.fs.max(c.fs);
        let term = ends_terminal(&p.text);
        let gap = c.b.y - p.b.y1();
        let step = c.b.cy() - p.b.cy();
        let indented = !in_shadow(c) && c.b.x > left + 0.8 * fs;
        // hanging indent: a new entry starts to the left of its continuation lines
        let outdented = !in_shadow(p) && c.b.x < p.b.x - 0.8 * fs;
        let prev_short_j = p.b.x1() < right - 2.0 * fs;
        let prev_short_r = p.b.x1() < right - (0.25 * width).max(2.0 * fs);

        let size_change = (c.fs - p.fs).abs() > 0.15 * fs;
        let bullet = starts_with_bullet(&c.text);
        let extra_leading = (n >= 3 && step > 1.4 * lead && gap > 0.25 * fs) || (n == 2 && gap > 0.8 * fs);
        // last line of a paragraph: short, and (justified) followed by a new sentence
        let short_end = if justified { prev_short_j && (term || starts_upper_or_digit(&c.text)) } else { prev_short_r && term };
        let indent_change = (indented || outdented) && term;
        let weight_change = p.bold != c.bold && (term || prev_short_j) && trailing_hyphen(&p.text) == Hyphen::None;
        let split = size_change || bullet || extra_leading || short_end || indent_change || weight_change;
        if split {
            out.push(start..i);
            start = i;
        }
    }
    out.push(start..n);
    (out, left, right)
}

#[allow(clippy::too_many_arguments)]
fn unit_from_rows(page_idx: usize, leaf_idx: usize, rows: &[&Row], role: &'static str, left: f32, right: f32, n_leaf_rows: usize, drop_caps: &[Bounds], keep_hard: bool) -> Unit {
    let first = rows[0];
    let last = rows[rows.len() - 1];
    let shadow = drop_caps.iter().any(|d| first.b.y < d.y1() && first.b.x >= d.x1() - 2.0);
    Unit {
        page_idx,
        segs: vec![UnitSeg { leaf_idx, lines: rows.iter().flat_map(|r| r.idxs.iter().copied()).collect() }],
        role,
        thread: None,
        text: join_rows(rows, keep_hard),
        first_in_block: false,
        last_in_block: false,
        first_indented: n_leaf_rows >= 2 && !shadow && first.b.x > left + 0.8 * first.fs,
        last_line_full: n_leaf_rows >= 2 && last.b.x1() >= right - 1.5 * last.fs,
        rows: rows.len(),
        first_fs: first.fs,
        last_fs: last.fs,
        first_bold: first.bold,
        last_bold: last.bold,
        tagged: false,
    }
}

#[allow(clippy::too_many_arguments)]
fn leaf_units(page_idx: usize, leaf_idx: usize, lines: &[Line], idxs: &[usize], role: &'static str, drop_caps: &[Bounds], body_fs: f32, keep_hard: bool) -> Vec<Unit> {
    if idxs.is_empty() {
        return Vec::new();
    }
    let rows = make_rows(lines, idxs);
    let splittable = matches!(role, BODY | SIDEBAR | roles::FOOTNOTE);
    let (ranges, left, right) = if splittable {
        split_paragraphs(&rows, drop_caps)
    } else {
        let left = rows.iter().map(|r| r.b.x).fold(f32::INFINITY, f32::min);
        let right = rows.iter().map(|r| r.b.x1()).fold(f32::NEG_INFINITY, f32::max);
        (vec![0..rows.len()], left, right)
    };
    let count = ranges.len();
    ranges
        .into_iter()
        .enumerate()
        .map(|(k, rg)| {
            let rs: Vec<&Row> = rows[rg].iter().collect();
            let mut u = unit_from_rows(page_idx, leaf_idx, &rs, role, left, right, rows.len(), drop_caps, keep_hard);
            u.first_in_block = k == 0;
            u.last_in_block = k + 1 == count;
            if u.role == BODY && looks_like_heading(&u, &rs, body_fs) {
                u.role = HEADING;
            }
            u
        })
        .collect()
}

fn looks_like_heading(u: &Unit, rows: &[&Row], body_fs: f32) -> bool {
    if u.rows > 3 {
        return false;
    }
    let chars = u.text.chars().count();
    // headings almost never end with a full stop (pull quotes / epigraphs do)
    if u.text.trim_end().ends_with('.') && !u.text.trim_end().ends_with("..") {
        return false;
    }
    let avg = rows.iter().map(|r| r.fs).sum::<f32>() / rows.len() as f32;
    if avg >= body_fs * 1.15 && chars <= 200 {
        return true;
    }
    let all_bold = rows.iter().all(|r| r.bold);
    all_bold && u.rows <= 2 && chars <= 120 && !ends_terminal(&u.text) && trailing_hyphen(&u.text) == Hyphen::None
}

pub struct PageFlowInput<'a> {
    pub page_idx: usize,
    pub lines: &'a [Line],
    pub leaves: &'a [Leaf],
    pub roles: &'a [&'static str],
    pub drop_caps: &'a [Bounds],
    pub tagged: bool,
    /// See [`crate::pdf_layout::text::join_lines_with`].
    pub keep_hard_hyphens: bool,
}

/// Build the ordered units of one page.
pub fn page_units(p: &PageFlowInput, body_fs: f32) -> Vec<Unit> {
    let mut units: Vec<(f64, Unit)> = Vec::new();
    let line_leaf: HashMap<usize, usize> = p.leaves.iter().enumerate().flat_map(|(k, l)| l.lines.iter().map(move |&i| (i, k))).collect();

    let in_struct = |i: usize| p.tagged && p.lines[i].struct_id.is_some() && !p.lines[i].artifact;

    // ---- tagged units: one per structure element, in structure order -----
    if p.tagged {
        let mut groups: HashMap<u32, Vec<usize>> = HashMap::new();
        for leaf in p.leaves {
            for &i in &leaf.lines {
                if in_struct(i) {
                    groups.entry(p.lines[i].struct_id.unwrap()).or_default().push(i);
                }
            }
        }
        for (sid, mut ls) in groups {
            ls.sort_by_key(|&i| p.lines[i].order);
            let mut segs: Vec<UnitSeg> = Vec::new();
            for i in ls {
                let k = line_leaf[&i];
                match segs.last_mut() {
                    Some(s) if s.leaf_idx == k => s.lines.push(i),
                    _ => segs.push(UnitSeg { leaf_idx: k, lines: vec![i] }),
                }
            }
            let first_leaf = segs[0].leaf_idx;
            let leaf_role = p.roles[first_leaf];
            let srole = p.lines[segs[0].lines[0]].struct_role.as_deref().and_then(roles::struct_role_to_role);
            let role = match (srole, leaf_role) {
                (_, roles::HEADER | roles::FOOTER | roles::PAGE_NUMBER) => leaf_role,
                (Some(r), _) => r,
                (None, r) => r,
            };
            let all: Vec<usize> = segs.iter().flat_map(|s| s.lines.iter().copied()).collect();
            let rows = make_rows(p.lines, &all);
            let text = segs
                .iter()
                .map(|s| {
                    let rs = make_rows(p.lines, &s.lines);
                    join_rows(&rs.iter().collect::<Vec<_>>(), p.keep_hard_hyphens)
                })
                .fold(String::new(), |acc, t| join_lines_with(&acc, &t, p.keep_hard_hyphens).0);
            let (first, last) = (&rows[0], &rows[rows.len() - 1]);
            let mut u = Unit {
                page_idx: p.page_idx,
                segs,
                role,
                thread: None,
                text,
                first_in_block: true,
                last_in_block: true,
                first_indented: false,
                last_line_full: true,
                rows: rows.len(),
                first_fs: first.fs,
                last_fs: last.fs,
                first_bold: first.bold,
                last_bold: last.bold,
                tagged: true,
            };
            if u.role == BODY && looks_like_heading(&u, &rows.iter().collect::<Vec<_>>(), body_fs) && srole.is_none() {
                u.role = HEADING;
            }
            units.push((sid as f64, u));
        }
    }

    // ---- untagged lines: leaf by leaf, in XY-Cut reading order ------------
    let mut last_key = -1.0f64;
    for (k, leaf) in p.leaves.iter().enumerate() {
        if p.tagged {
            if let Some(m) = leaf.lines.iter().filter(|&&i| in_struct(i)).map(|&i| p.lines[i].struct_id.unwrap()).max() {
                last_key = last_key.max(m as f64);
            }
        }
        let rest: Vec<usize> = leaf.lines.iter().copied().filter(|&i| !in_struct(i)).collect();
        for (j, u) in leaf_units(p.page_idx, k, p.lines, &rest, p.roles[k], p.drop_caps, body_fs, p.keep_hard_hyphens).into_iter().enumerate() {
            units.push((last_key + 0.001 * (k as f64 + 1.0) + 0.000001 * j as f64, u));
        }
    }

    units.sort_by(|a, b| a.0.total_cmp(&b.0));
    units
        .into_iter()
        .map(|(_, mut u)| {
            u.thread = match u.role {
                BODY => Some(p.leaves[u.segs[0].leaf_idx].box_id.clone().unwrap_or_else(|| "main".into())),
                SIDEBAR => p.leaves[u.segs[0].leaf_idx].box_id.clone(),
                _ => None,
            };
            u
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct JoinDraft {
    pub at_unit: usize,
    pub kind: &'static str,
    pub interrupted: bool,
    pub dehyphenated: bool,
}

#[derive(Debug, Clone)]
pub struct ParDraft {
    pub role: &'static str,
    pub text: String,
    pub units: Vec<usize>,
    pub joins: Vec<JoinDraft>,
}

/// Decide whether `next` continues the paragraph ending with `prev`.
pub fn can_continue(prev: &Unit, next: &Unit) -> bool {
    if !(prev.last_in_block && next.first_in_block) {
        return false;
    }
    if prev.tagged && next.tagged && prev.page_idx == next.page_idx {
        return false; // the structure tree already says these are distinct
    }
    if next.page_idx > prev.page_idx + 1 {
        return false;
    }
    let hy = trailing_hyphen(&prev.text) != Hyphen::None;
    if ends_terminal(&prev.text) && !hy {
        return false;
    }
    let fs = prev.last_fs.max(next.first_fs).max(1.0);
    if (prev.last_fs - next.first_fs).abs() > 0.12 * fs {
        return false;
    }
    if starts_with_bullet(&next.text) {
        return false;
    }
    if hy || starts_lowercase(&next.text) {
        return true;
    }
    // Upper-case start (proper noun, German noun…): require strong layout evidence.
    prev.rows >= 2 && prev.last_line_full && !next.first_indented && prev.last_bold == next.first_bold
}

pub fn stitch(units: &[Unit], enable: bool, keep_hard: bool) -> Vec<ParDraft> {
    let mut pars: Vec<ParDraft> = Vec::new();
    let mut open: HashMap<String, (usize, usize)> = HashMap::new(); // thread -> (par idx, emitted index)
    for (ui, u) in units.iter().enumerate() {
        let mut merged = false;
        if enable {
            if let Some(th) = &u.thread {
                if let Some(&(pi, at)) = open.get(th) {
                    let prev = &units[*pars[pi].units.last().unwrap()];
                    if can_continue(prev, u) {
                        let (t, dh) = join_lines_with(&pars[pi].text, &u.text, keep_hard);
                        let kind = if prev.page_idx != u.page_idx {
                            "page"
                        } else if th != "main" {
                            "box"
                        } else {
                            "column"
                        };
                        let par = &mut pars[pi];
                        par.joins.push(JoinDraft { at_unit: par.units.len(), kind, interrupted: ui > at + 1, dehyphenated: dh });
                        par.text = t;
                        par.units.push(ui);
                        open.insert(th.clone(), (pi, ui));
                        merged = true;
                    }
                }
            }
        }
        if !merged {
            pars.push(ParDraft { role: u.role, text: u.text.clone(), units: vec![ui], joins: Vec::new() });
            match &u.thread {
                Some(th) => {
                    open.insert(th.clone(), (pars.len() - 1, ui));
                }
                None => {
                    if u.role == HEADING {
                        open.remove("main");
                    }
                }
            }
        }
    }
    pars
}
