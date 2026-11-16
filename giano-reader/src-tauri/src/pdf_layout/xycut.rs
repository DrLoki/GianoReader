//! Recursive XY-Cut over *lines*.
//!
//! Invariant: every input line ends up in exactly one leaf. Cuts are
//! expressed as split coordinates and lines are assigned by their centre, so
//! nothing can "fall into a gap"; groups that are too thin are merged with a
//! neighbour instead of being skipped.

use crate::pdf_layout::lines::{group_rows, weighted_mode, Line};
use crate::pdf_layout::model::{AnalysisOptions, Bounds, CutDiag, Formatting, Gap, LayoutNode, Projections};
use std::collections::HashMap;

const MAX_DEPTH: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BoxKind {
    Sidebar,
    Table,
}

#[derive(Debug, Clone)]
pub struct Leaf {
    pub id: String,
    /// Line indices in visual order (rows top→bottom, left→right).
    pub lines: Vec<usize>,
    pub bounds: Bounds,
    pub box_kind: Option<BoxKind>,
    pub box_id: Option<String>,
}

pub struct PageLayout {
    pub root: LayoutNode,
    /// Leaves in reading order.
    pub leaves: Vec<Leaf>,
    pub projections: Projections,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Axis {
    X,
    Y,
}

struct Plan {
    axis: Axis,
    splits: Vec<f32>,
    strength: f32,
    kind: &'static str,
}

struct Ctx<'a> {
    lines: &'a [Line],
    /// Non-text regions (images, boxes) that occupy space in projections:
    /// without them a cut could run "through" a figure and break columns.
    obstacles: Vec<Bounds>,
    opts: &'a AnalysisOptions,
    page_num: u32,
    counter: usize,
    leaves: HashMap<String, Leaf>,
    box_kind: Option<BoxKind>,
    box_id: Option<String>,
}

fn lo(b: &Bounds, a: Axis) -> f32 {
    if a == Axis::X { b.x } else { b.y }
}
fn hi(b: &Bounds, a: Axis) -> f32 {
    if a == Axis::X { b.x1() } else { b.y1() }
}
fn mid(b: &Bounds, a: Axis) -> f32 {
    if a == Axis::X { b.cx() } else { b.cy() }
}

/// Merge the projections of `boxes` on `axis` and return the empty intervals.
/// With `outer = Some((min, max))` the leading / trailing margins are included.
pub fn projection_gaps(boxes: &[Bounds], axis_x: bool, outer: Option<(f32, f32)>) -> Vec<Gap> {
    let a = if axis_x { Axis::X } else { Axis::Y };
    let mut iv: Vec<(f32, f32)> = boxes.iter().map(|b| (lo(b, a), hi(b, a))).collect();
    if iv.is_empty() {
        return Vec::new();
    }
    iv.sort_by(|p, q| p.0.total_cmp(&q.0));
    let mut merged: Vec<(f32, f32)> = Vec::new();
    for (s, e) in iv {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    let mut gaps = Vec::new();
    if let Some((min, _)) = outer {
        if merged[0].0 - min > 0.1 {
            gaps.push(Gap { start: min, end: merged[0].0, size: merged[0].0 - min });
        }
    }
    for w in merged.windows(2) {
        if w[1].0 > w[0].1 {
            gaps.push(Gap { start: w[0].1, end: w[1].0, size: w[1].0 - w[0].1 });
        }
    }
    if let Some((_, max)) = outer {
        let last = merged[merged.len() - 1].1;
        if max - last > 0.1 {
            gaps.push(Gap { start: last, end: max, size: max - last });
        }
    }
    gaps
}

impl<'a> Ctx<'a> {
    fn bbox(&self, idxs: &[usize]) -> Bounds {
        Bounds::union_all(idxs.iter().map(|&i| &self.lines[i].b)).unwrap_or_default()
    }

    fn dominant_fs(&self, idxs: &[usize]) -> f32 {
        weighted_mode(idxs.iter().map(|&i| (self.lines[i].fs, self.lines[i].chars())), 10.0)
    }

    /// (threshold_x, threshold_y, min_width, min_height)
    fn thresholds(&self, idxs: &[usize]) -> (f32, f32, f32, f32) {
        let dom = self.dominant_fs(idxs);
        if let Some(m) = &self.opts.manual {
            return (m.threshold_x.max(0.5), m.threshold_y.max(0.5), m.min_width.max(0.0), m.min_height.max(0.0));
        }
        let min_w = 1.5 * dom;
        let min_h = 0.0;
        match self.opts.strategy.as_str() {
            "delta-x" => (self.delta_x_gutter(idxs, dom).max(0.8 * dom), self.leading_threshold(idxs, dom), min_w, min_h),
            "zero-run" => (10.0, 5.0, min_w, min_h),
            "dominant-font" => (dom, dom, min_w, min_h),
            _ => (self.delta_x_gutter(idxs, dom).max(dom), self.leading_threshold(idxs, dom), min_w, min_h),
        }
    }

    /// Vertical threshold relative to the block's own line spacing: a gap is
    /// a cut candidate when it is clearly larger than the typical gap between
    /// consecutive lines (section spacing, space above headings). Bounded to
    /// [max(4 pt, ½ em), 1 em]; 1 em when there are too few gaps to measure.
    fn leading_threshold(&self, idxs: &[usize], dom: f32) -> f32 {
        let upper = dom.max(4.0);
        let boxes: Vec<Bounds> = idxs.iter().map(|&i| self.lines[i].b).collect();
        let mut gaps: Vec<f32> = projection_gaps(&boxes, false, None)
            .into_iter()
            .map(|g| g.size)
            .filter(|&s| s < 1.5 * dom)
            .collect();
        if gaps.len() < 5 {
            return upper;
        }
        gaps.sort_by(|a, b| a.total_cmp(b));
        let median = gaps[gaps.len() / 2];
        (LEADING_FACTOR * median).clamp((0.5 * dom).max(4.0), upper)
    }

    /// Strategy 1 (delta-x histogram): collect horizontal distances between
    /// neighbouring runs sharing a baseline; the valley between the
    /// word-spacing peak and the gutter peak is the column threshold.
    fn delta_x_gutter(&self, idxs: &[usize], dom: f32) -> f32 {
        let rows = group_rows(self.lines, idxs);
        let mut deltas: Vec<f32> = Vec::new();
        for row in rows {
            let mut frs: Vec<(f32, f32)> = row.iter().flat_map(|&i| self.lines[i].frags.iter().map(|f| (f.b.x, f.b.x1()))).collect();
            frs.sort_by(|a, b| a.0.total_cmp(&b.0));
            for w in frs.windows(2) {
                let d = w[1].0 - w[0].1;
                if d > 0.1 && d < 150.0 {
                    deltas.push(d);
                }
            }
        }
        let fallback = dom;
        if deltas.is_empty() {
            return fallback;
        }
        let mut hist = vec![0usize; 100];
        for d in deltas {
            let b = d.round() as usize;
            if b < hist.len() {
                hist[b] += 1;
            }
        }
        let (mut pb, mut fb) = (4usize, 0usize);
        for (i, &h) in hist.iter().enumerate().take(11).skip(2) {
            if h > fb {
                fb = h;
                pb = i;
            }
        }
        let (mut pc, mut fc) = (0usize, 0usize);
        for (i, &h) in hist.iter().enumerate().take(80).skip(pb + 4) {
            if h > fc {
                fc = h;
                pc = i;
            }
        }
        if pc > pb && fc >= 2 {
            let mut best = (usize::MAX, pb + 2);
            for (i, &h) in hist.iter().enumerate().take(pc + 1).skip(pb) {
                if h < best.0 {
                    best = (h, i);
                }
            }
            return best.1 as f32;
        }
        fallback
    }

    fn internal_gaps(&self, idxs: &[usize], axis: Axis) -> Vec<Gap> {
        let mut boxes: Vec<Bounds> = idxs.iter().map(|&i| self.lines[i].b).collect();
        let bb = self.bbox(idxs);
        for o in &self.obstacles {
            // clip the obstacle to the block; ignore it if it does not overlap
            let x0 = o.x.max(bb.x);
            let y0 = o.y.max(bb.y);
            let x1 = o.x1().min(bb.x1());
            let y1 = o.y1().min(bb.y1());
            if x1 - x0 > 1.0 && y1 - y0 > 1.0 {
                boxes.push(Bounds::from_edges(x0, y0, x1, y1));
            }
        }
        projection_gaps(&boxes, axis == Axis::X, None)
    }

    /// Fallback when columns overlap on the global X projection (e.g. a
    /// centred title spans both columns): vote, row by row, for the most
    /// consistent vertical split line. Lines crossing that line are cut out
    /// with horizontal splits first, so they are never dropped.
    fn per_row_plan(&self, idxs: &[usize], min_gap: f32, dom: f32) -> Option<Plan> {
        if idxs.len() < 4 {
            return None;
        }
        let bb = self.bbox(idxs);
        let rows = group_rows(self.lines, idxs);
        let mut votes: Vec<f32> = Vec::new();
        let mut multi = 0usize;
        for row in &rows {
            if row.len() < 2 {
                continue;
            }
            multi += 1;
            let mut best: Option<(f32, f32)> = None;
            for w in row.windows(2) {
                let r = self.lines[w[0]].b.x1();
                let l = self.lines[w[1]].b.x;
                let g = l - r;
                let m = (r + l) * 0.5;
                let rel = (m - bb.x) / bb.w.max(1.0);
                if g >= min_gap && (0.1..=0.9).contains(&rel) && best.map(|(s, _)| g > s).unwrap_or(true) {
                    best = Some((g, m));
                }
            }
            if let Some((_, m)) = best {
                votes.push(m);
            }
        }
        if votes.is_empty() {
            return None;
        }
        votes.sort_by(|a, b| a.total_cmp(b));
        let tol = (2.0 * dom).max(8.0);
        let mut clusters: Vec<(f32, usize)> = Vec::new();
        for v in votes {
            match clusters.iter_mut().find(|c| (v - c.0).abs() < tol) {
                Some(c) => {
                    c.0 = (c.0 * c.1 as f32 + v) / (c.1 + 1) as f32;
                    c.1 += 1;
                }
                None => clusters.push((v, 1)),
            }
        }
        clusters.sort_by(|a, b| b.1.cmp(&a.1));
        let need = ((multi as f32 * 0.25).ceil() as usize).max(2);
        let (split, count) = clusters[0];
        if count < need {
            return None;
        }
        let crossing: Vec<usize> = idxs.iter().copied().filter(|&i| {
            let b = &self.lines[i].b;
            b.x < split - 1.0 && b.x1() > split + 1.0
        }).collect();
        if crossing.is_empty() {
            return Some(Plan { axis: Axis::X, splits: vec![split], strength: min_gap, kind: "per-row" });
        }
        // Horizontal cuts at the top/bottom edges of the crossing lines,
        // where no other line straddles the cut.
        let mut ys: Vec<f32> = Vec::new();
        for &c in &crossing {
            let b = self.lines[c].b;
            for y in [b.y - 0.01, b.y1() + 0.01] {
                let straddled = idxs.iter().any(|&i| {
                    let l = &self.lines[i].b;
                    l.y < y && l.y1() > y
                });
                if !straddled && y > bb.y && y < bb.y1() {
                    ys.push(y);
                }
            }
        }
        ys.sort_by(|a, b| a.total_cmp(b));
        ys.dedup_by(|a, b| (*a - *b).abs() < 0.5);
        if !ys.is_empty() {
            return Some(Plan { axis: Axis::Y, splits: ys, strength: min_gap, kind: "per-row-isolate" });
        }
        // Cannot isolate the crossing lines: still cut, assigning them by centre.
        Some(Plan { axis: Axis::X, splits: vec![split], strength: min_gap * 0.5, kind: "per-row-centre" })
    }

    fn partition(&self, idxs: &[usize], plan: &Plan, min_extent: f32) -> Vec<Vec<usize>> {
        let mut splits = plan.splits.clone();
        splits.sort_by(|a, b| a.total_cmp(b));
        let mut groups: Vec<Vec<usize>> = vec![Vec::new(); splits.len() + 1];
        for &i in idxs {
            let c = mid(&self.lines[i].b, plan.axis);
            let k = splits.iter().filter(|&&s| c >= s).count();
            groups[k].push(i);
        }
        groups.retain(|g| !g.is_empty());
        // merge groups thinner than min_extent into their closest neighbour
        loop {
            if groups.len() <= 1 {
                break;
            }
            let extents: Vec<(f32, f32)> = groups
                .iter()
                .map(|g| {
                    let b = self.bbox(g);
                    (lo(&b, plan.axis), hi(&b, plan.axis))
                })
                .collect();
            let thin = extents.iter().position(|(a, b)| b - a < min_extent);
            let k = match thin {
                Some(k) => k,
                None => break,
            };
            let left_d = if k > 0 { extents[k].0 - extents[k - 1].1 } else { f32::INFINITY };
            let right_d = if k + 1 < groups.len() { extents[k + 1].0 - extents[k].1 } else { f32::INFINITY };
            let target = if left_d <= right_d { k - 1 } else { k + 1 };
            let g = groups.remove(k);
            let t = if target > k { target - 1 } else { target };
            groups[t].extend(g);
        }
        groups
    }

    fn subdivide(&mut self, idxs: Vec<usize>, depth: usize) -> LayoutNode {
        if idxs.len() <= 1 || depth >= MAX_DEPTH {
            let reason = if idxs.len() <= 1 { "leaf: single line" } else { "leaf: max depth" };
            let diag = CutDiag { decision: reason.into(), lines: idxs.len(), ..Default::default() };
            return self.leaf(idxs, depth, Some(diag));
        }
        let (tx, ty, min_w, min_h) = self.thresholds(&idxs);
        let dom = self.dominant_fs(&idxs);

        let all_x = self.internal_gaps(&idxs, Axis::X);
        let all_y = self.internal_gaps(&idxs, Axis::Y);
        let largest = |g: &[Gap]| g.iter().map(|g| g.size).fold(0.0, f32::max);
        let mut diag = CutDiag {
            source: if self.opts.manual.is_some() { "manual".into() } else { format!("auto:{}", self.opts.strategy) },
            dominant_font: dom,
            threshold_x: tx,
            threshold_y: ty,
            min_width: min_w,
            min_height: min_h,
            largest_x_gap: largest(&all_x),
            largest_y_gap: largest(&all_y),
            lines: idxs.len(),
            ..Default::default()
        };
        let xg: Vec<Gap> = all_x.into_iter().filter(|g| g.size >= tx).collect();
        let yg: Vec<Gap> = all_y.into_iter().filter(|g| g.size >= ty).collect();

        let x_plan = if !xg.is_empty() {
            Some(Plan {
                axis: Axis::X,
                strength: xg.iter().map(|g| g.size).fold(0.0, f32::max),
                splits: xg.iter().map(|g| (g.start + g.end) * 0.5).collect(),
                kind: "gaps",
            })
        } else {
            self.per_row_plan(&idxs, tx, dom)
        };
        // When the global gaps only isolate thin groups (a margin credit, a
        // folio), they collapse on partition: the per-row vote is the fallback.
        let x_fallback = match &x_plan {
            Some(p) if p.kind == "gaps" && self.partition(&idxs, p, min_w).len() < 2 => self.per_row_plan(&idxs, tx, dom),
            _ => None,
        };
        let y_plan = if !yg.is_empty() {
            Some(Plan {
                axis: Axis::Y,
                strength: yg.iter().map(|g| g.size).fold(0.0, f32::max),
                splits: yg.iter().map(|g| (g.start + g.end) * 0.5).collect(),
                kind: "gaps",
            })
        } else {
            None
        };
        diag.x_plan = x_plan.as_ref().map(|p| p.kind).unwrap_or("none").into();
        diag.x_gaps = xg;
        diag.y_gaps = yg;

        let plans: Vec<Plan> = match self.opts.priority.as_str() {
            "X" => [x_plan, x_fallback, y_plan].into_iter().flatten().collect(),
            "max-gap" => {
                let mut v: Vec<Plan> = [x_plan, y_plan].into_iter().flatten().collect();
                v.sort_by(|a, b| b.strength.total_cmp(&a.strength));
                v.extend(x_fallback);
                v
            }
            _ => [y_plan, x_plan, x_fallback].into_iter().flatten().collect(),
        };

        for plan in plans {
            let min_extent = if plan.axis == Axis::X { min_w } else { min_h };
            let groups = self.partition(&idxs, &plan, min_extent);
            let axis = if plan.axis == Axis::X { "X" } else { "Y" };
            diag.tried.push(format!("{} {} ({} splits): {} groups after merging < {:.1}pt", axis, plan.kind, plan.splits.len(), groups.len(), min_extent));
            if groups.len() >= 2 {
                diag.decision = format!("cut {} into {}", axis, groups.len());
                let my_id = self.next_id();
                let bounds = self.bbox(&idxs);
                let children = groups.into_iter().map(|g| self.subdivide(g, depth + 1)).collect();
                return LayoutNode {
                    id: my_id,
                    node_type: "container".into(),
                    bounds,
                    depth,
                    cut_direction: Some(if plan.axis == Axis::X { "X".into() } else { "Y".into() }),
                    is_bordered_box: None,
                    is_table: None,
                    text: None,
                    formatting: None,
                    role: None,
                    reading_order: None,
                    paragraph_ids: None,
                    children: Some(children),
                    diag: Some(diag),
                };
            }
        }
        diag.decision = if diag.tried.is_empty() {
            format!(
                "leaf: no gap above threshold (largest X {:.1} < {:.1}, largest Y {:.1} < {:.1})",
                diag.largest_x_gap, tx, diag.largest_y_gap, ty
            )
        } else {
            "leaf: every cut collapsed into one group (thin groups merged)".into()
        };
        self.leaf(idxs, depth, Some(diag))
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("p{}-b{}", self.page_num, self.counter)
    }

    fn leaf(&mut self, idxs: Vec<usize>, depth: usize, diag: Option<CutDiag>) -> LayoutNode {
        let id = self.next_id();
        let rows = group_rows(self.lines, &idxs);
        let ordered: Vec<usize> = rows.iter().flatten().copied().collect();
        let bounds = self.bbox(&idxs);
        let text = rows
            .iter()
            .map(|r| r.iter().map(|&i| self.lines[i].text.as_str()).collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        let formatting = leaf_formatting(self.lines, &rows, &bounds);
        self.leaves.insert(
            id.clone(),
            Leaf { id: id.clone(), lines: ordered, bounds, box_kind: self.box_kind, box_id: self.box_id.clone() },
        );
        LayoutNode {
            id,
            node_type: "leaf".into(),
            bounds,
            depth,
            cut_direction: None,
            is_bordered_box: None,
            is_table: None,
            text: Some(text),
            formatting: Some(formatting),
            role: None,
            reading_order: None,
            paragraph_ids: None,
            children: None,
            diag,
        }
    }
}

pub fn leaf_formatting(lines: &[Line], rows: &[Vec<usize>], bounds: &Bounds) -> Formatting {
    let all: Vec<usize> = rows.iter().flatten().copied().collect();
    if all.is_empty() {
        return Formatting {
            font_family: "default".into(),
            font_size: 10.0,
            avg_font_size: 10.0,
            font_weight: "normal".into(),
            font_style: "normal".into(),
            color: "#ffffff".into(),
            alignment: "left".into(),
        };
    }
    let fs = weighted_mode(all.iter().map(|&i| (lines[i].fs, lines[i].chars())), 10.0);
    let total_chars: usize = all.iter().map(|&i| lines[i].chars().max(1)).sum();
    let avg = all.iter().map(|&i| lines[i].fs * lines[i].chars().max(1) as f32).sum::<f32>() / total_chars as f32;
    let mut fonts: HashMap<&str, usize> = HashMap::new();
    for &i in &all {
        *fonts.entry(lines[i].font.as_str()).or_insert(0) += lines[i].chars();
    }
    let family = fonts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(f, _)| f.to_string()).unwrap_or_default();
    let bold_chars: usize = all.iter().filter(|&&i| lines[i].bold).map(|&i| lines[i].chars()).sum();
    let italic_chars: usize = all.iter().filter(|&&i| lines[i].italic).map(|&i| lines[i].chars()).sum();
    Formatting {
        font_family: family,
        font_size: fs,
        avg_font_size: (avg * 10.0).round() / 10.0,
        font_weight: if bold_chars * 2 > total_chars { "bold".into() } else { "normal".into() },
        font_style: if italic_chars * 2 > total_chars { "italic".into() } else { "normal".into() },
        color: "#ffffff".into(),
        alignment: alignment(lines, rows, bounds, fs),
    }
}

pub fn alignment(lines: &[Line], rows: &[Vec<usize>], b: &Bounds, fs: f32) -> String {
    if rows.is_empty() {
        return "left".into();
    }
    let tol = 0.6 * fs;
    let n = rows.len() as f32;
    let (mut l, mut r, mut c) = (0.0, 0.0, 0.0);
    for row in rows {
        let x0 = row.iter().map(|&i| lines[i].b.x).fold(f32::INFINITY, f32::min);
        let x1 = row.iter().map(|&i| lines[i].b.x1()).fold(f32::NEG_INFINITY, f32::max);
        l += (x0 - b.x).abs();
        r += (b.x1() - x1).abs();
        c += ((x0 + x1) * 0.5 - b.cx()).abs();
    }
    let (l, r, c) = (l / n, r / n, c / n);
    if rows.len() > 1 && c < tol && l > tol && r > tol {
        "center".into()
    } else if rows.len() > 1 && r < tol * 0.6 && l > tol {
        "right".into()
    } else if rows.len() > 2 && l < tol && r < tol * 1.5 {
        "justify".into()
    } else {
        "left".into()
    }
}

/// Clean up vector rectangles: drop page frames and rules, deduplicate
/// fill+stroke pairs, and merge grids of touching cells into one table box.
fn prepare_boxes(boxes: &[Bounds], page: &Bounds) -> Vec<(Bounds, BoxKind)> {
    let mut v: Vec<Bounds> = boxes
        .iter()
        .copied()
        .filter(|b| b.w.is_finite() && b.h.is_finite() && b.w > 20.0 && b.h > 10.0 && b.w < page.w * 0.98 && b.h < page.h * 0.98)
        .collect();
    v.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    v.dedup_by(|a, b| (a.x - b.x).abs() < 1.0 && (a.y - b.y).abs() < 1.0 && (a.w - b.w).abs() < 1.0 && (a.h - b.h).abs() < 1.0);

    // union-find on touching (non-nested) rectangles
    let n = v.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        let mut r = i;
        while p[r] != r {
            r = p[r];
        }
        let mut j = i;
        while p[j] != r {
            let nx = p[j];
            p[j] = r;
            j = nx;
        }
        r
    }
    let contains = |a: &Bounds, b: &Bounds| a.x <= b.x + 0.5 && a.y <= b.y + 0.5 && a.x1() >= b.x1() - 0.5 && a.y1() >= b.y1() - 0.5;
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (&v[i], &v[j]);
            if contains(a, b) || contains(b, a) {
                continue;
            }
            let grown = Bounds { x: a.x - 1.5, y: a.y - 1.5, w: a.w + 3.0, h: a.h + 3.0 };
            if grown.h_overlap(b) > 0.0 && grown.v_overlap(b) > 0.0 {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut out = Vec::new();
    for (_, g) in groups {
        if g.len() >= 3 {
            let u = Bounds::union_all(g.iter().map(|&i| &v[i])).unwrap();
            out.push((u, BoxKind::Table));
        } else {
            for i in g {
                out.push((v[i], BoxKind::Sidebar));
            }
        }
    }
    out
}

fn walk_order(node: &mut LayoutNode, order: &mut Vec<String>) {
    if node.node_type == "leaf" {
        node.reading_order = Some(order.len());
        order.push(node.id.clone());
    }
    if let Some(ch) = node.children.as_mut() {
        for c in ch {
            walk_order(c, order);
        }
    }
}

/// Gap between consecutive lines × this factor = vertical cut threshold.
const LEADING_FACTOR: f32 = 3.5;

/// An image with running text printed over it (decorative artwork behind the
/// columns) is a background, not a figure: it must not hide the gutters.
fn is_background(img: &Bounds, lines: &[Line]) -> bool {
    let inside: Vec<&Line> = lines.iter().filter(|l| img.contains_point(l.b.cx(), l.b.cy())).collect();
    if inside.len() < 3 {
        return false;
    }
    let covered: f32 = inside.iter().map(|l| l.b.area()).sum();
    covered >= img.area().max(1.0) * 0.1
}

pub fn layout_page(page_num: u32, page_bounds: Bounds, lines: &[Line], boxes: &[Bounds], images: &[Bounds], opts: &AnalysisOptions) -> PageLayout {
    let mut ctx = Ctx { lines, obstacles: Vec::new(), opts, page_num, counter: 0, leaves: HashMap::new(), box_kind: None, box_id: None };

    // ---- boxes: assign each line to the smallest box containing its centre
    let mut boxes = prepare_boxes(boxes, &page_bounds);
    boxes.sort_by(|a, b| a.0.area().total_cmp(&b.0.area()));
    let mut owner: Vec<Option<usize>> = vec![None; lines.len()];
    for (i, l) in lines.iter().enumerate() {
        owner[i] = boxes.iter().position(|(b, _)| b.contains_point(l.b.cx(), l.b.cy()));
    }
    let total = lines.len().max(1);
    let mut box_nodes: Vec<LayoutNode> = Vec::new();
    for (k, (bb, kind)) in boxes.iter().enumerate() {
        let members: Vec<usize> = (0..lines.len()).filter(|&i| owner[i] == Some(k)).collect();
        if members.is_empty() {
            continue;
        }
        // a frame around (almost) the whole text is decoration, not a box;
        // a shading behind a single row (highlighted heading) is not a box either
        let single_row = *kind == BoxKind::Sidebar && group_rows(lines, &members).len() <= 1;
        if single_row || (members.len() * 10 >= total * 6 && bb.area() > page_bounds.area() * 0.4) {
            for i in members {
                owner[i] = None;
            }
            continue;
        }
        ctx.counter += 1;
        let id = format!("p{}-box{}", page_num, ctx.counter);
        ctx.box_kind = Some(*kind);
        ctx.box_id = Some(id.clone());
        let inner = ctx.subdivide(members, 2);
        ctx.box_kind = None;
        ctx.box_id = None;
        let cut = inner.cut_direction.clone();
        let children = if inner.node_type == "leaf" { vec![inner] } else { inner.children.unwrap_or_default() };
        box_nodes.push(LayoutNode {
            id,
            node_type: "container".into(),
            bounds: *bb,
            depth: 1,
            cut_direction: cut,
            is_bordered_box: Some(true),
            is_table: if *kind == BoxKind::Table { Some(true) } else { None },
            text: None,
            formatting: None,
            role: None,
            reading_order: None,
            paragraph_ids: None,
            children: Some(children),
            diag: None,
        });
    }

    // ---- body: images and the boxes kept above are obstacles for the cuts
    ctx.obstacles = images
        .iter()
        .filter(|b| b.area() < page_bounds.area() * 0.8 && !is_background(b, lines))
        .copied()
        .chain(box_nodes.iter().map(|n| n.bounds))
        .collect();
    let body: Vec<usize> = (0..lines.len()).filter(|&i| owner[i].is_none()).collect();
    let mut root_children: Vec<LayoutNode> = Vec::new();
    let mut root_cut = None;
    let mut root_diag = None;
    if !body.is_empty() {
        let node = ctx.subdivide(body, 1);
        if node.node_type == "leaf" {
            root_children.push(node);
        } else {
            root_cut = node.cut_direction.clone();
            root_diag = node.diag.clone();
            root_children.extend(node.children.unwrap_or_default());
        }
    }
    // Boxes interleave by vertical position when the body is a stack of
    // horizontal bands; with a column-first body they are read afterwards.
    if root_cut.as_deref() == Some("X") {
        root_children.extend(box_nodes);
    } else {
        for b in box_nodes {
            let pos = root_children.iter().position(|c| c.bounds.y > b.bounds.y).unwrap_or(root_children.len());
            root_children.insert(pos, b);
        }
    }

    let mut root = LayoutNode {
        id: format!("p{}-root", page_num),
        node_type: "root".into(),
        bounds: page_bounds,
        depth: 0,
        cut_direction: root_cut,
        is_bordered_box: None,
        is_table: None,
        text: None,
        formatting: None,
        role: None,
        reading_order: None,
        paragraph_ids: None,
        children: Some(root_children),
        // the body's first cut is flattened into the root: keep its diagnostics
        diag: root_diag,
    };
    let mut order = Vec::new();
    walk_order(&mut root, &mut order);
    let leaves = order.iter().filter_map(|id| ctx.leaves.remove(id)).collect();

    let line_boxes: Vec<Bounds> = lines.iter().map(|l| l.b).collect();
    let projections = Projections {
        x_gaps: projection_gaps(&line_boxes, true, Some((page_bounds.x, page_bounds.x1()))),
        y_gaps: projection_gaps(&line_boxes, false, Some((page_bounds.y, page_bounds.y1()))),
        page_bounds,
    };
    PageLayout { root, leaves, projections }
}
