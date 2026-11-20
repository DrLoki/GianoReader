//! Shared data model: analysis input (as produced by the frontend extractor or
//! the CLI fixtures) and analysis output (layout trees + logical paragraphs).
//!
//! All coordinates are expressed in **PDF points**, page origin top-left,
//! y growing downwards (pdf.js viewport at scale 1). The UI applies the zoom
//! factor only when drawing.

use serde::{Deserialize, Deserializer, Serialize};

/// JSON has no NaN: a non-finite coordinate computed by the extractor arrives
/// as `null`. Read it as NaN so one bad run doesn't reject the whole request;
/// the pipeline drops non-finite geometry on entry (`PageInput::sanitized`).
fn f32_or_nan<'de, D: Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    Ok(Option::<f32>::deserialize(d)?.unwrap_or(f32::NAN))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct Bounds {
    #[serde(deserialize_with = "f32_or_nan")]
    pub x: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub y: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub w: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub h: f32,
}

impl Bounds {
    pub fn from_edges(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Bounds { x: x0.min(x1), y: y0.min(y1), w: (x1 - x0).abs(), h: (y1 - y0).abs() }
    }
    pub fn x1(&self) -> f32 {
        self.x + self.w
    }
    pub fn y1(&self) -> f32 {
        self.y + self.h
    }
    pub fn cx(&self) -> f32 {
        self.x + self.w * 0.5
    }
    pub fn cy(&self) -> f32 {
        self.y + self.h * 0.5
    }
    pub fn union(&self, o: &Bounds) -> Bounds {
        Bounds::from_edges(self.x.min(o.x), self.y.min(o.y), self.x1().max(o.x1()), self.y1().max(o.y1()))
    }
    pub fn contains_point(&self, x: f32, y: f32) -> bool {
        x >= self.x && x <= self.x1() && y >= self.y && y <= self.y1()
    }
    /// Length of the horizontal overlap between the two boxes (0 if disjoint).
    pub fn h_overlap(&self, o: &Bounds) -> f32 {
        (self.x1().min(o.x1()) - self.x.max(o.x)).max(0.0)
    }
    /// Length of the vertical overlap between the two boxes (0 if disjoint).
    pub fn v_overlap(&self, o: &Bounds) -> f32 {
        (self.y1().min(o.y1()) - self.y.max(o.y)).max(0.0)
    }
    pub fn is_finite(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.w.is_finite() && self.h.is_finite()
    }
    pub fn area(&self) -> f32 {
        self.w * self.h
    }
    pub fn union_all<'a, I: IntoIterator<Item = &'a Bounds>>(it: I) -> Option<Bounds> {
        it.into_iter().fold(None, |acc: Option<Bounds>, b| Some(match acc {
            None => *b,
            Some(a) => a.union(b),
        }))
    }
}

/// One text run as extracted by pdf.js (or PyMuPDF in the legacy fixtures).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextElement {
    pub text: String,
    #[serde(deserialize_with = "f32_or_nan")]
    pub x: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub y: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub width: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub height: f32,
    #[serde(deserialize_with = "f32_or_nan")]
    pub font_size: f32,
    #[serde(default)]
    pub font_name: Option<String>,
    /// Marked-content id (`<pageRef>_mc<MCID>`) of the innermost marked content.
    #[serde(default)]
    pub mcid: Option<String>,
    /// True when the run lies inside an `/Artifact` marked-content sequence
    /// (running heads, page numbers, decorations in Tagged PDFs).
    #[serde(default)]
    pub artifact: bool,
    /// Index (tree order) of the block-level structure element owning the run.
    #[serde(default)]
    pub struct_id: Option<u32>,
    /// Role of that structure element (`P`, `H1`, `Caption`, `Note`, …).
    #[serde(default)]
    pub struct_role: Option<String>,
    /// Direction of the baseline in degrees (screen coordinates, clockwise:
    /// 0 horizontal, 90 reading top→bottom, 270 bottom→top). Absent in
    /// older inputs.
    #[serde(default)]
    pub rot: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInput {
    #[serde(default = "default_page_num", alias = "page_num")]
    pub page_num: u32,
    #[serde(alias = "page_bounds")]
    pub page_bounds: Bounds,
    pub items: Vec<TextElement>,
    /// Vector rectangles found on the page (candidate boxes / table cells).
    #[serde(default, alias = "bordered_boxes")]
    pub bordered_boxes: Vec<Bounds>,
    /// Placed raster images (used to detect captions).
    #[serde(default)]
    pub images: Vec<Bounds>,
}

impl PageInput {
    /// Copy without runs, boxes or images whose geometry is not finite
    /// (they cannot be placed; counting them would break the conservation check).
    pub fn sanitized(&self) -> PageInput {
        let ok = |it: &&TextElement| it.x.is_finite() && it.y.is_finite() && it.width.is_finite() && it.height.is_finite();
        // the same run painted twice at the same place (faux bold, fill +
        // stroke passes) is one piece of text
        let mut items: Vec<TextElement> = Vec::with_capacity(self.items.len());
        for it in self.items.iter().filter(ok) {
            let dup = items.iter().rev().take(64).any(|o| {
                o.text == it.text
                    && (o.x - it.x).abs() < 0.5
                    && (o.y - it.y).abs() < 0.5
                    && (o.width - it.width).abs() < 0.5
                    && (o.height - it.height).abs() < 0.5
            });
            if !dup {
                items.push(it.clone());
            }
        }
        PageInput {
            page_num: self.page_num,
            page_bounds: self.page_bounds,
            items,
            bordered_boxes: self.bordered_boxes.iter().filter(|b| b.is_finite()).copied().collect(),
            images: self.images.iter().filter(|b| b.is_finite()).copied().collect(),
        }
    }
}

fn default_page_num() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualThresholds {
    pub threshold_x: f32,
    pub threshold_y: f32,
    pub min_width: f32,
    pub min_height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    /// `combined` | `delta-x` | `zero-run` | `dominant-font`
    #[serde(default = "default_strategy")]
    pub strategy: String,
    /// `Y` (rows first) | `X` (columns first) | `max-gap`
    #[serde(default = "default_priority")]
    pub priority: String,
    /// When set, these thresholds replace the automatic ones.
    #[serde(default)]
    pub manual: Option<ManualThresholds>,
    /// Use Tagged-PDF information (structure order, roles, artifacts) when present.
    #[serde(default = "default_true")]
    pub use_tags: bool,
    /// Stitch paragraphs across column / page / box interruptions.
    #[serde(default = "default_true")]
    pub stitch: bool,
}

fn default_strategy() -> String {
    "combined".into()
}
fn default_priority() -> String {
    "Y".into()
}
fn default_true() -> bool {
    true
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        AnalysisOptions {
            strategy: default_strategy(),
            priority: default_priority(),
            manual: None,
            use_tags: true,
            stitch: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatting {
    pub font_family: String,
    pub font_size: f32,
    pub avg_font_size: f32,
    pub font_weight: String,
    pub font_style: String,
    pub color: String,
    pub alignment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String, // "root" | "container" | "leaf"
    pub bounds: Bounds,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut_direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_bordered_box: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_table: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatting: Option<Formatting>,
    /// Block role (leaf only): body, heading, header, footer, page-number,
    /// caption, footnote, sidebar, table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Position of the leaf in the page reading order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading_order: Option<usize>,
    /// Logical paragraphs that have (part of) their text in this leaf.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LayoutNode>>,
    /// Why the XY-Cut did (or did not) cut this block: thresholds used,
    /// candidate gaps, decision. Used by snapshots to tune the heuristics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diag: Option<CutDiag>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CutDiag {
    /// `manual` or `auto:<strategy>`
    pub source: String,
    pub dominant_font: f32,
    pub threshold_x: f32,
    pub threshold_y: f32,
    pub min_width: f32,
    pub min_height: f32,
    /// Largest internal white-space gap on each axis, even when below threshold.
    pub largest_x_gap: f32,
    pub largest_y_gap: f32,
    /// Internal gaps at or above the threshold.
    pub x_gaps: Vec<Gap>,
    pub y_gaps: Vec<Gap>,
    /// How the column cut was found: `gaps`, `per-row`, `per-row-isolate`, `per-row-centre`, `none`.
    pub x_plan: String,
    /// Plans tried in order and their outcome, e.g. `Y gaps: 1 group after merge`.
    pub tried: Vec<String>,
    /// Final decision: `cut X`, `cut Y`, `leaf: …`.
    pub decision: String,
    pub lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gap {
    pub start: f32,
    pub end: f32,
    pub size: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projections {
    pub x_gaps: Vec<Gap>,
    pub y_gaps: Vec<Gap>,
    pub page_bounds: Bounds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOut {
    pub bounds: Bounds,
    pub text: String,
    pub font_size: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResult {
    pub page_num: u32,
    pub page_bounds: Bounds,
    pub root: LayoutNode,
    pub projections: Projections,
    pub lines: Vec<LineOut>,
    pub drop_caps: Vec<Bounds>,
    /// True when the reading order of this page came from the structure tree.
    pub tagged_order: bool,
}

/// A piece of a logical paragraph that lives inside one layout block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub page_num: u32,
    pub block_id: String,
    pub bounds: Bounds,
    pub lines: Vec<Bounds>,
    pub text: String,
    pub char_count: usize,
    pub font_size: f32,
    pub font_name: String,
    pub bold: bool,
    pub italic: bool,
    pub alignment: String,
    /// Reading direction of the segment in degrees, clockwise (0, 90, 180,
    /// 270): the prevailing direction of its lines, weighted by characters.
    /// GianoReader uses it to rotate the translation box like the original.
    #[serde(default)]
    pub rot: u16,
}

/// How two consecutive segments of the same paragraph are connected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    /// Index of the segment that starts after the break.
    pub at_segment: usize,
    /// `column` (same page, other block), `page` (next page) or `box`.
    pub kind: String,
    /// True if other content (caption, figure, footnote, box, header…) sits between.
    pub interrupted: bool,
    /// True if a hyphenated word was rejoined across the break.
    pub dehyphenated: bool,
}

/// The unit of translation: a paragraph reconstructed across blocks/pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalParagraph {
    pub id: String,
    pub role: String,
    pub text: String,
    pub translatable: bool,
    pub segments: Vec<Segment>,
    pub joins: Vec<Join>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStats {
    pub page_count: usize,
    pub paragraph_count: usize,
    pub stitched_joins: usize,
    pub body_font_size: f32,
    pub input_chars: usize,
    pub output_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub pages: Vec<PageResult>,
    pub paragraphs: Vec<LogicalParagraph>,
    pub stats: DocumentStats,
}
