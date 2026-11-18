//! Test di integrazione della pipeline (portati da PDF X-Ray).
use super::model::{AnalysisOptions, Bounds, DocumentResult, LogicalParagraph, PageInput, TextElement};
use super::pipeline::analyze_document;

fn fixture(name: &str) -> PageInput {
    let path = format!("{}/src/pdf_layout/fixtures/{}.json", env!("CARGO_MANIFEST_DIR"), name);
    let json = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&json).unwrap()
}

fn analyze(pages: &[PageInput]) -> DocumentResult {
    analyze_document(pages, &AnalysisOptions::default())
}

fn find<'a>(r: &'a DocumentResult, prefix: &str) -> &'a LogicalParagraph {
    r.paragraphs
        .iter()
        .find(|p| p.text.starts_with(prefix))
        .unwrap_or_else(|| panic!("no paragraph starting with {prefix:?}:\n{:#?}", r.paragraphs.iter().map(|p| &p.text).collect::<Vec<_>>()))
}

// ---------------------------------------------------------------------------
// Conservation: no character may be lost, whatever the parameters.
// ---------------------------------------------------------------------------

#[test]
fn no_text_is_lost_on_fixtures() {
    for name in ["page2", "page5", "page6"] {
        let page = fixture(name);
        for priority in ["Y", "X", "max-gap"] {
            for strategy in ["combined", "delta-x", "zero-run", "dominant-font"] {
                let opts = AnalysisOptions { priority: priority.into(), strategy: strategy.into(), ..Default::default() };
                let r = analyze_document(std::slice::from_ref(&page), &opts);
                assert_eq!(
                    r.stats.input_chars, r.stats.output_chars,
                    "{name} priority={priority} strategy={strategy}: characters lost"
                );
                // every line must be in exactly one paragraph segment
                let seg_lines: usize = r.paragraphs.iter().flat_map(|p| &p.segments).map(|s| s.lines.len()).sum();
                assert!(seg_lines >= 1);
            }
        }
    }
}

#[test]
fn page5_drop_cap_title_and_footer() {
    let r = analyze(&[fixture("page5")]);
    let first = find(&r, "The Cosmere Roleplaying Game is a tabletop roleplaying game");
    assert_eq!(first.role, "body");
    assert!(!r.paragraphs.iter().any(|p| p.text.contains("T he") || p.text.contains("\nhe Cosmere")));
    assert_eq!(find(&r, "Introduction").role, "heading");
    let footer = r.paragraphs.iter().find(|p| p.text.trim() == "Introduction 1").expect("footer");
    assert_eq!(footer.role, "footer");
    assert_eq!(r.pages[0].drop_caps.len(), 1);
}

#[test]
fn page6_run_in_heads_hanging_indent_and_hyphens() {
    let r = analyze(&[fixture("page6")]);
    // bold run-in heads stay with their paragraph
    assert_eq!(find(&r, "Chapter 1: Character Creation. This walks you through creating").role, "body");
    assert!(find(&r, "Chapter 10: Combat. This describes how to engage in a combat scene").text.ends_with("battlefield."));
    // hanging indent splits entries
    find(&r, "Chapter 8: Goals and Rewards.");
    find(&r, "Appendix: Animal Companions.");
    // U+00AD is removed, real compounds keep their hyphen
    let all: String = r.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n");
    assert!(all.contains("tabletop roleplaying game"), "soft hyphen not removed");
    assert!(all.contains("storm-blasted"));
    assert!(all.contains("high-stakes"));
    assert!(!all.contains('\u{00AD}'));
}

// ---------------------------------------------------------------------------
// Synthetic two-page, two-column document
// ---------------------------------------------------------------------------

fn line(text: &str, x: f32, y: f32, w: f32, fs: f32) -> TextElement {
    TextElement { text: text.into(), x, y, width: w, height: fs * 1.15, font_size: fs, font_name: Some("Serif-Regular".into()), ..Default::default() }
}

fn page(num: u32, items: Vec<TextElement>, images: Vec<Bounds>) -> PageInput {
    PageInput { page_num: num, page_bounds: Bounds { x: 0.0, y: 0.0, w: 612.0, h: 792.0 }, items, bordered_boxes: vec![], images }
}

fn synthetic_doc() -> Vec<PageInput> {
    let (c1, c2, w) = (50.0, 320.0, 220.0);
    let mut p1 = vec![
        line("Running Head of the Book", 50.0, 30.0, 150.0, 9.0),
        line("1", 300.0, 760.0, 6.0, 9.0),
    ];
    let col1 = [
        "This is the first paragraph of the document and",
        "it is long enough to fill the whole column with",
        "text that keeps going until the very last word,",
        "which happens to be broken across columns: tradu-",
    ];
    for (k, t) in col1.iter().enumerate() {
        p1.push(line(t, c1, 100.0 + 14.0 * k as f32, w, 10.0));
    }
    let col2 = [
        ("zione is the rest of that word, it ends.", 150.0),
        ("Second paragraph begins in the right column and", w),
        ("continues for a while with ordinary sentences so", w),
        ("that it reaches the bottom of the page where the", w),
        ("sentence is interrupted and continues on the", w),
    ];
    for (k, (t, ww)) in col2.iter().enumerate() {
        p1.push(line(t, c2, 100.0 + 14.0 * k as f32, *ww, 10.0));
    }

    let mut p2 = vec![
        line("Running Head of the Book", 50.0, 30.0, 150.0, 9.0),
        line("2", 300.0, 760.0, 6.0, 9.0),
        line("Figure 1: A caption under the picture", c1, 210.0, 180.0, 8.0),
        line("next page, where it finally comes to an end.", c1, 240.0, 190.0, 10.0),
        line("A third paragraph starts after the end of the", c1, 268.0, w, 10.0),
        line("previous one and stays in its own column.", c1, 282.0, 170.0, 10.0),
    ];
    let right = ["Right column text on the second page is a new", "paragraph that does not continue anything else", "and it ends normally with a period."];
    for (k, t) in right.iter().enumerate() {
        let ww = if k == 2 { 160.0 } else { w };
        p2.push(line(t, c2, 100.0 + 14.0 * k as f32, ww, 10.0));
    }
    vec![page(1, p1, vec![]), page(2, p2, vec![Bounds { x: 50.0, y: 90.0, w: 220.0, h: 110.0 }])]
}

#[test]
fn stitches_across_columns_and_pages() {
    let r = analyze(&synthetic_doc());
    assert_eq!(r.stats.input_chars, r.stats.output_chars);

    let p1 = find(&r, "This is the first paragraph");
    assert!(p1.text.contains("broken across columns: traduzione is the rest"), "{}", p1.text);
    assert_eq!(p1.segments.len(), 2, "{:#?}", p1.segments.iter().map(|s| (&s.block_id, &s.text)).collect::<Vec<_>>());
    assert_eq!(p1.joins[0].kind, "column");
    assert!(p1.joins[0].dehyphenated);

    let p2 = find(&r, "Second paragraph begins");
    assert!(p2.text.contains("continues on the next page, where it finally comes to an end."), "{}", p2.text);
    assert_eq!(p2.joins.len(), 1);
    assert_eq!(p2.joins[0].kind, "page");
    assert!(p2.joins[0].interrupted, "the caption sits between the two pieces");
    assert_eq!(p2.segments[0].page_num, 1);
    assert_eq!(p2.segments[1].page_num, 2);

    assert_eq!(find(&r, "Figure 1").role, "caption");
    assert!(find(&r, "A third paragraph").joins.is_empty());
    assert!(find(&r, "Right column text").joins.is_empty());

    for p in r.paragraphs.iter().filter(|p| p.text == "Running Head of the Book") {
        assert_eq!(p.role, "header");
    }
    let folios: Vec<_> = r.paragraphs.iter().filter(|p| p.text == "1" || p.text == "2").collect();
    assert_eq!(folios.len(), 2);
    assert!(folios.iter().all(|p| p.role == "page-number" && !p.translatable));
}

#[test]
fn stitching_can_be_disabled() {
    let opts = AnalysisOptions { stitch: false, ..Default::default() };
    let r = analyze_document(&synthetic_doc(), &opts);
    assert!(r.paragraphs.iter().all(|p| p.joins.is_empty()));
    assert_eq!(r.stats.input_chars, r.stats.output_chars);
}

// ---------------------------------------------------------------------------
// Tagged PDF: structure order and artifacts win over geometry
// ---------------------------------------------------------------------------

#[test]
fn tagged_pdf_uses_structure_order_and_artifacts() {
    let tag = |mut e: TextElement, sid: u32, role: &str| {
        e.struct_id = Some(sid);
        e.struct_role = Some(role.into());
        e
    };
    let mut header = line("Chapter Title", 250.0, 30.0, 100.0, 9.0);
    header.artifact = true;
    let items = vec![
        header,
        // struct 0 (a P) lives in the RIGHT column and continues in the left one:
        tag(line("Structure order says this comes first and it", 320.0, 100.0, 220.0, 10.0), 0, "P"),
        tag(line("continues here in the left column, ending.", 50.0, 300.0, 200.0, 10.0), 0, "P"),
        tag(line("Left column paragraph, second in structure.", 50.0, 100.0, 220.0, 10.0), 1, "P"),
        tag(line("A tagged caption", 320.0, 300.0, 120.0, 8.0), 2, "Caption"),
    ];
    let r = analyze(&[page(1, items, vec![])]);
    assert!(r.pages[0].tagged_order);
    let body: Vec<&LogicalParagraph> = r.paragraphs.iter().filter(|p| p.role == "body").collect();
    assert!(body[0].text.starts_with("Structure order says this comes first and it continues here"), "{:?}", body[0].text);
    assert_eq!(body[0].segments.len(), 2);
    assert!(body[1].text.starts_with("Left column paragraph"));
    assert_eq!(find(&r, "A tagged caption").role, "caption");
    assert_eq!(find(&r, "Chapter Title").role, "header");
}

// ---------------------------------------------------------------------------
// Page decoration (snapshots of an illustrated RPG book): an ornamental page
// edge drawn as box + image across the right column, and a column of glyphs
// set in a decorative font in the left margin.
// ---------------------------------------------------------------------------

fn decorated_page() -> PageInput {
    let words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
    let mut items = Vec::new();
    for (k, w) in words.iter().enumerate() {
        let y = 100.0 + 12.0 * k as f32;
        let end = if k == words.len() - 1 { "." } else { "" };
        for (x, col) in [(66.0, "left"), (306.0, "right")] {
            items.push(TextElement {
                text: format!("{col} column line {w} with some running text{end}"),
                x,
                y,
                width: 216.0,
                height: 15.0,
                font_size: 9.0,
                font_name: Some("ABCDEF+Caslon-Regular".into()),
                ..Default::default()
            });
        }
    }
    for (k, g) in ["s", "h", "o", "o", "t", "i"].iter().enumerate() {
        items.push(TextElement {
            text: (*g).into(),
            x: 27.0,
            y: 60.0 + 24.0 * k as f32,
            width: 22.0,
            height: 22.0,
            font_size: 24.0,
            font_name: Some("GHIJKL+Ornaments".into()),
            ..Default::default()
        });
    }
    let edge = Bounds { x: 411.0, y: 60.0, w: 190.0, h: 700.0 };
    PageInput {
        page_num: 1,
        page_bounds: Bounds { x: 0.0, y: 0.0, w: 594.0, h: 774.0 },
        items,
        bordered_boxes: vec![edge],
        images: vec![edge, Bounds { x: 418.0, y: 66.0, w: 175.0, h: 690.0 }],
    }
}

#[test]
fn page_edge_ornament_is_not_a_sidebar() {
    let r = analyze(&[decorated_page()]);
    assert!(r.paragraphs.iter().all(|p| p.role != "sidebar"), "{:#?}", r.paragraphs.iter().map(|p| (&p.role, &p.text)).collect::<Vec<_>>());
    let right = find(&r, "right column line alpha");
    assert!(right.text.contains("right column line mu"), "right column split: {:?}", right.text);
    assert_eq!(r.stats.input_chars, r.stats.output_chars);
}

#[test]
fn decorative_glyphs_stay_out_of_the_text() {
    let r = analyze(&[decorated_page()]);
    let left = find(&r, "left column line alpha");
    assert!(left.text.contains("left column line mu"));
    assert!(r.paragraphs.iter().filter(|p| p.role != "decoration").all(|p| !p.text.split_whitespace().any(|w| w.len() == 1)));
    let deco = r.paragraphs.iter().find(|p| p.role == "decoration").expect("decoration paragraph");
    assert!(!deco.translatable);
    assert_eq!(r.stats.input_chars, r.stats.output_chars);
}
