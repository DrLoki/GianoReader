//! Document pipeline:
//!
//! runs → lines → XY-Cut blocks → roles (page + cross-page) → units
//! (paragraphs / structure elements) → stitched logical paragraphs.

use crate::pdf_layout::flow::{page_units, stitch, PageFlowInput, Unit};
use crate::pdf_layout::lines::{build_lines, group_rows, weighted_mode, PageLines};
use crate::pdf_layout::model::*;
use crate::pdf_layout::roles::{classify_leaf, confirm_running, running_candidates, PAGE_NUMBER};
use crate::pdf_layout::text::{font_is_bold, font_is_italic, normalize_fragment, visible_len};
use crate::pdf_layout::xycut::{alignment, layout_page, PageLayout};
use std::collections::HashMap;

fn page_is_tagged(pl: &PageLines) -> bool {
    let mut total = 0usize;
    let mut tagged = 0usize;
    for l in &pl.lines {
        if l.artifact {
            continue;
        }
        let n = l.chars().max(1);
        total += n;
        if l.struct_id.is_some() {
            tagged += n;
        }
    }
    total > 0 && tagged * 10 >= total * 7
}

fn make_segment(page: &PageInput, layout: &PageLayout, pl: &PageLines, leaf_idx: usize, line_idxs: &[usize]) -> Segment {
    let lines = &pl.lines;
    let rows = group_rows(lines, line_idxs);
    let row_bounds: Vec<Bounds> = rows.iter().filter_map(|r| Bounds::union_all(r.iter().map(|&i| &lines[i].b))).collect();
    let bounds = Bounds::union_all(row_bounds.iter()).unwrap_or_default();
    let text = rows
        .iter()
        .map(|r| r.iter().map(|&i| lines[i].text.as_str()).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    let fs = weighted_mode(line_idxs.iter().map(|&i| (lines[i].fs, lines[i].chars())), 10.0);
    let mut fonts: HashMap<&str, usize> = HashMap::new();
    for &i in line_idxs {
        *fonts.entry(lines[i].font.as_str()).or_insert(0) += lines[i].chars();
    }
    let font = fonts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(f, _)| f.to_string()).unwrap_or_default();
    Segment {
        page_num: page.page_num,
        block_id: layout.leaves[leaf_idx].id.clone(),
        bounds,
        lines: row_bounds,
        char_count: visible_len(&text),
        text,
        font_size: fs,
        bold: font_is_bold(&font),
        italic: font_is_italic(&font),
        font_name: font,
        alignment: alignment(lines, &rows, &bounds, fs),
    }
}

fn set_reading_order(node: &mut LayoutNode, pos: &HashMap<String, usize>) {
    if node.node_type == "leaf" {
        node.reading_order = pos.get(&node.id).copied();
    }
    if let Some(ch) = node.children.as_mut() {
        for c in ch {
            set_reading_order(c, pos);
        }
    }
}

fn write_back(node: &mut LayoutNode, info: &HashMap<String, (&'static str, Vec<String>)>) {
    if node.node_type == "leaf" {
        if let Some((role, pars)) = info.get(&node.id) {
            node.role = Some(role.to_string());
            node.paragraph_ids = Some(pars.clone());
        }
    }
    if let Some(ch) = node.children.as_mut() {
        for c in ch {
            write_back(c, info);
        }
    }
}

pub fn analyze_document(pages: &[PageInput], opts: &AnalysisOptions) -> DocumentResult {
    // 1. lines
    let page_lines: Vec<PageLines> = pages.iter().map(|p| build_lines(&p.items)).collect();
    let body_fs = weighted_mode(page_lines.iter().flat_map(|pl| pl.lines.iter().map(|l| (l.fs, l.chars()))), 10.0);

    // 2. layout
    let mut layouts: Vec<PageLayout> = pages
        .iter()
        .zip(&page_lines)
        .map(|(p, pl)| layout_page(p.page_num, p.page_bounds, &pl.lines, &p.bordered_boxes, &p.images, opts))
        .collect();

    // 3. roles: page level, then running heads / footers across pages
    let mut roles: Vec<Vec<&'static str>> = pages
        .iter()
        .zip(&page_lines)
        .zip(&layouts)
        .map(|((p, pl), lay)| lay.leaves.iter().map(|leaf| classify_leaf(&pl.lines, leaf, &p.page_bounds, &p.images, body_fs, opts.use_tags)).collect())
        .collect();
    if pages.len() > 1 {
        let mut cands = Vec::new();
        for (pi, ((p, pl), lay)) in pages.iter().zip(&page_lines).zip(&layouts).enumerate() {
            cands.extend(running_candidates(pi, &pl.lines, &lay.leaves, &roles[pi], &p.page_bounds));
        }
        let mut hs: Vec<f32> = pages.iter().map(|p| p.page_bounds.h).collect();
        hs.sort_by(|a, b| a.total_cmp(b));
        for (pi, li, r) in confirm_running(&cands, hs[hs.len() / 2]) {
            roles[pi][li] = r;
        }
    }

    // 3b. reading order (topological, figures act as separators)
    for pi in 0..pages.len() {
        let lay = &mut layouts[pi];
        let blocks: Vec<Bounds> = lay.leaves.iter().map(|l| l.bounds).collect();
        let page_area = pages[pi].page_bounds.area();
        let seps: Vec<Bounds> = pages[pi].images.iter().filter(|b| b.area() < page_area * 0.8).copied().collect();
        let perm = crate::pdf_layout::order::reading_order(&blocks, &roles[pi], &seps);
        lay.leaves = perm.iter().map(|&i| lay.leaves[i].clone()).collect();
        roles[pi] = perm.iter().map(|&i| roles[pi][i]).collect();
        let pos: HashMap<String, usize> = lay.leaves.iter().enumerate().map(|(k, l)| (l.id.clone(), k)).collect();
        set_reading_order(&mut lay.root, &pos);
    }

    // 4. units
    let tagged: Vec<bool> = page_lines.iter().map(|pl| opts.use_tags && page_is_tagged(pl)).collect();
    // Typesetters that emit U+00AD for discretionary breaks leave '-' only
    // for real compounds: in that case line-final '-' must be kept.
    let keep_hard_hyphens = page_lines
        .iter()
        .flat_map(|pl| pl.lines.iter())
        .any(|l| l.text.trim_end().ends_with(crate::pdf_layout::text::SOFT_HYPHEN));
    let mut units: Vec<Unit> = Vec::new();
    for pi in 0..pages.len() {
        let input = PageFlowInput {
            page_idx: pi,
            lines: &page_lines[pi].lines,
            leaves: &layouts[pi].leaves,
            roles: &roles[pi],
            drop_caps: &page_lines[pi].drop_caps,
            tagged: tagged[pi],
            keep_hard_hyphens,
        };
        units.extend(page_units(&input, body_fs));
    }

    // 5. stitching
    let drafts = stitch(&units, opts.stitch, keep_hard_hyphens);

    // 6. logical paragraphs
    let mut paragraphs = Vec::with_capacity(drafts.len());
    let mut leaf_pars: Vec<HashMap<String, Vec<String>>> = vec![HashMap::new(); pages.len()];
    let mut stitched = 0usize;
    for (k, d) in drafts.iter().enumerate() {
        let id = format!("par{}", k + 1);
        let mut segments: Vec<Segment> = Vec::new();
        let mut joins: Vec<Join> = Vec::new();
        let mut unit_first_seg: Vec<usize> = Vec::new();
        for &ui in &d.units {
            let u = &units[ui];
            unit_first_seg.push(segments.len());
            for (si, s) in u.segs.iter().enumerate() {
                if si > 0 {
                    joins.push(Join { at_segment: segments.len(), kind: "column".into(), interrupted: false, dehyphenated: false });
                }
                let seg = make_segment(&pages[u.page_idx], &layouts[u.page_idx], &page_lines[u.page_idx], s.leaf_idx, &s.lines);
                let list = leaf_pars[u.page_idx].entry(seg.block_id.clone()).or_default();
                if !list.contains(&id) {
                    list.push(id.clone());
                }
                segments.push(seg);
            }
        }
        for j in &d.joins {
            stitched += 1;
            joins.push(Join {
                at_segment: unit_first_seg[j.at_unit],
                kind: j.kind.into(),
                interrupted: j.interrupted,
                dehyphenated: j.dehyphenated,
            });
        }
        joins.sort_by_key(|j| j.at_segment);
        paragraphs.push(LogicalParagraph {
            id,
            role: d.role.to_string(),
            text: d.text.clone(),
            translatable: d.role != PAGE_NUMBER,
            segments,
            joins,
        });
    }

    // 7. write roles + paragraph ids back into the trees
    let mut out_pages = Vec::with_capacity(pages.len());
    for (pi, lay) in layouts.iter_mut().enumerate() {
        let info: HashMap<String, (&'static str, Vec<String>)> = lay
            .leaves
            .iter()
            .enumerate()
            .map(|(k, leaf)| (leaf.id.clone(), (roles[pi][k], leaf_pars[pi].get(&leaf.id).cloned().unwrap_or_default())))
            .collect();
        write_back(&mut lay.root, &info);
        out_pages.push(PageResult {
            page_num: pages[pi].page_num,
            page_bounds: pages[pi].page_bounds,
            root: lay.root.clone(),
            projections: lay.projections.clone(),
            lines: page_lines[pi].lines.iter().map(|l| LineOut { bounds: l.b, text: l.text.clone(), font_size: l.fs }).collect(),
            drop_caps: page_lines[pi].drop_caps.clone(),
            tagged_order: tagged[pi],
        });
    }

    let input_chars = pages
        .iter()
        .flat_map(|p| p.items.iter())
        .map(|it| visible_len(&normalize_fragment(&it.text)))
        .sum();
    let output_chars = paragraphs.iter().flat_map(|p| p.segments.iter()).map(|s| s.char_count).sum();

    DocumentResult {
        stats: DocumentStats {
            page_count: pages.len(),
            paragraph_count: paragraphs.len(),
            stitched_joins: stitched,
            body_font_size: body_fs,
            input_chars,
            output_chars,
        },
        pages: out_pages,
        paragraphs,
    }
}
