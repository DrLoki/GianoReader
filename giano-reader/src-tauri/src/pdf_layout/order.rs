//! Reading order of the blocks of a page, decoupled from the XY-Cut tree.
//!
//! XY-Cut order depends on which cut is tried first: with "rows first" a
//! horizontal gap between a figure and its caption can slice a two-column
//! page so that the right column is read before the left one. Here the order
//! is a topological sort of Breuel's pairwise relations (T. Breuel, "High
//! Performance Document Layout Analysis", 2003):
//!
//! 1. `a` precedes `b` if they overlap horizontally and `a` is above `b`;
//! 2. `a` precedes `b` if `a` is entirely left of `b` and no block (or
//!    figure) lying vertically between them overlaps both horizontally.
//!
//! Ties are broken by the XY-Cut order, so when geometry says nothing the
//! user's cut priority still decides. Running heads come first; footnotes,
//! figure text, footers and folios last.

use crate::pdf_layout::model::Bounds;
use crate::pdf_layout::roles::{DECORATION, FIGURE_TEXT, FOOTER, FOOTNOTE, HEADER, PAGE_NUMBER};

fn h_overlaps(a: &Bounds, b: &Bounds) -> bool {
    a.h_overlap(b) > 0.5_f32.min(0.1 * a.w.min(b.w))
}

/// Returns a permutation of `0..blocks.len()` (indices in XY-Cut order).
pub fn reading_order(blocks: &[Bounds], roles: &[&'static str], separators: &[Bounds]) -> Vec<usize> {
    let n = blocks.len();
    let tail_role = |r: &str| matches!(r, FOOTNOTE | FIGURE_TEXT | DECORATION | FOOTER | PAGE_NUMBER);
    let flow: Vec<usize> = (0..n).filter(|&i| roles[i] != HEADER && !tail_role(roles[i])).collect();

    // nodes: flow blocks followed by separators (figures) that take part in rule 2 only
    let mut nodes: Vec<Bounds> = flow.iter().map(|&i| blocks[i]).collect();
    let n_flow = nodes.len();
    nodes.extend(separators.iter().copied());

    let precedes = |a: usize, b: usize| -> bool {
        let (ba, bb) = (&nodes[a], &nodes[b]);
        if h_overlaps(ba, bb) {
            return ba.cy() < bb.cy() && ba.y < bb.y + 0.5 * bb.h;
        }
        if ba.x1() <= bb.x + 0.5 {
            let (top, bottom) = if ba.cy() < bb.cy() { (ba.y1(), bb.y) } else { (bb.y1(), ba.y) };
            let blocked = nodes.iter().enumerate().any(|(k, c)| {
                k != a && k != b && c.cy() > top.min(bottom) && c.cy() < top.max(bottom) && h_overlaps(c, ba) && h_overlaps(c, bb)
            });
            return !blocked;
        }
        false
    };

    // Kahn's algorithm over all nodes; separators are dropped from the output.
    let m = nodes.len();
    let mut succ: Vec<Vec<usize>> = vec![Vec::new(); m];
    let mut indeg = vec![0usize; m];
    for a in 0..m {
        for b in 0..m {
            if a != b && precedes(a, b) {
                succ[a].push(b);
                indeg[b] += 1;
            }
        }
    }
    // tie-break key: XY-Cut position for blocks, vertical position for figures
    let key = |k: usize| -> (f32, f32) {
        if k < n_flow {
            (k as f32, 0.0)
        } else {
            let s = &nodes[k];
            // place a figure just before the first flow block below it
            let after = (0..n_flow).filter(|&j| nodes[j].y >= s.y).min_by(|&x, &y| nodes[x].y.total_cmp(&nodes[y].y));
            (after.map(|j| j as f32 - 0.5).unwrap_or(n_flow as f32), 0.0)
        }
    };
    let mut done = vec![false; m];
    let mut out_flow: Vec<usize> = Vec::with_capacity(n_flow);
    for _ in 0..m {
        let ready = (0..m).filter(|&k| !done[k] && indeg[k] == 0).min_by(|&x, &y| key(x).partial_cmp(&key(y)).unwrap());
        // a cycle (contradictory geometry): fall back to the XY-Cut order
        let k = match ready.or_else(|| (0..m).filter(|&k| !done[k]).min_by(|&x, &y| key(x).partial_cmp(&key(y)).unwrap())) {
            Some(k) => k,
            None => break,
        };
        done[k] = true;
        for &s in &succ[k] {
            indeg[s] = indeg[s].saturating_sub(1);
        }
        if k < n_flow {
            out_flow.push(flow[k]);
        }
    }

    let mut heads: Vec<usize> = (0..n).filter(|&i| roles[i] == HEADER).collect();
    heads.sort_by(|&a, &b| blocks[a].y.total_cmp(&blocks[b].y).then(blocks[a].x.total_cmp(&blocks[b].x)));
    // footnotes and figure text after the flow, then footers / folios
    let rank = |r: &str| match r {
        FOOTNOTE => 0,
        FIGURE_TEXT => 1,
        DECORATION => 3,
        _ => 2,
    };
    let mut tails: Vec<usize> = (0..n).filter(|&i| tail_role(roles[i])).collect();
    tails.sort_by(|&a, &b| rank(roles[a]).cmp(&rank(roles[b])).then(blocks[a].y.total_cmp(&blocks[b].y)).then(blocks[a].x.total_cmp(&blocks[b].x)));
    heads.into_iter().chain(out_flow).chain(tails).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_layout::roles::BODY;

    fn b(x: f32, y: f32, w: f32, h: f32) -> Bounds {
        Bounds { x, y, w, h }
    }

    #[test]
    fn two_columns_with_full_width_figure() {
        // XY order deliberately wrong: right-top, left-top, left-bottom, right-bottom
        let blocks = [b(320.0, 100.0, 220.0, 200.0), b(50.0, 100.0, 220.0, 200.0), b(50.0, 500.0, 220.0, 200.0), b(320.0, 500.0, 220.0, 200.0)];
        let roles = [BODY; 4];
        let fig = [b(50.0, 320.0, 490.0, 150.0)];
        assert_eq!(reading_order(&blocks, &roles, &fig), vec![1, 0, 2, 3]);
        // without the figure the left column is read top to bottom first
        assert_eq!(reading_order(&blocks, &roles, &[]), vec![1, 2, 0, 3]);
    }
}
