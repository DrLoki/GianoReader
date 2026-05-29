//! Generatore EPUB 3.0 da contenuto Markdown.
//!
//! Porta in Rust la logica di `mark2epub.py`: prende il Markdown generato dall'LLM,
//! lo converte in XHTML e lo impacchetta in un file EPUB valido.

use anyhow::{Context, Result};
use chrono::Utc;
use pulldown_cmark::{html, Options, Parser};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Metadati per l'EPUB
#[derive(Clone, Default)]
pub struct EpubMetadata {
    pub title: String,
    pub author: String,
    pub language: String,
    pub identifier: String,
    pub publisher: String,
    pub rights: String,
    pub date: String,
}

/// Rappresenta un capitolo dell'EPUB
pub struct Chapter {
    /// Nome del capitolo (usato per il filename e la TOC)
    pub title: String,
    /// Contenuto Markdown del capitolo
    pub markdown_content: String,
}

/// Rappresenta un'immagine da includere nell'EPUB
pub struct EpubImage {
    /// Nome del file (es. "figure_p1_1.png")
    pub filename: String,
    /// Dati binari dell'immagine
    pub data: Vec<u8>,
    /// Media type (es. "image/png")
    pub media_type: String,
}

/// Immagine di copertina per l'EPUB
pub struct CoverImage {
    /// Dati PNG dell'immagine di copertina
    pub png_data: Vec<u8>,
}

/// Genera un file EPUB da capitoli Markdown.
///
/// # Arguments
/// * `output_path` - Percorso dove salvare il file .epub
/// * `metadata` - Metadati del libro
/// * `chapters` - Capitoli con contenuto Markdown
/// * `images` - Immagini da includere
/// * `css_content` - CSS personalizzato (opzionale, usa default se None)
/// * `cover` - Immagine di copertina (opzionale)
pub fn generate_epub(
    output_path: &Path,
    metadata: &EpubMetadata,
    chapters: &[Chapter],
    images: &[EpubImage],
    css_content: Option<&str>,
    cover: Option<&CoverImage>,
) -> Result<()> {
    let file = std::fs::File::create(output_path)
        .with_context(|| format!("Impossibile creare il file: {}", output_path.display()))?;

    let mut zip = ZipWriter::new(file);

    // 1. mimetype (DEVE essere il primo file, non compresso)
    let options_stored = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", options_stored)?;
    zip.write_all(b"application/epub+zip")?;

    let options_deflated = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 2. META-INF/container.xml
    zip.start_file("META-INF/container.xml", options_deflated)?;
    zip.write_all(generate_container_xml().as_bytes())?;

    // 3. CSS
    let css = css_content.unwrap_or(DEFAULT_CSS);
    zip.start_file("OPS/css/style.css", options_deflated)?;
    zip.write_all(css.as_bytes())?;

    // 3b. Cover image (se presente)
    let has_cover = cover.is_some();
    if let Some(cover_img) = cover {
        zip.start_file("OPS/images/cover.png", options_deflated)?;
        zip.write_all(&cover_img.png_data)?;
    }

    // 4. Converti capitoli in XHTML
    let mut chapter_filenames: Vec<String> = Vec::new();
    let mut chapter_xhtml_map: HashMap<String, String> = HashMap::new();

    for (i, chapter) in chapters.iter().enumerate() {
        let filename = format!("chapter_{:04}.xhtml", i);
        let xhtml = markdown_to_xhtml(&chapter.markdown_content, &["css/style.css"]);
        chapter_filenames.push(filename.clone());
        chapter_xhtml_map.insert(filename, xhtml);
    }

    // 5. Titlepage (o cover page se c'è la copertina)
    if has_cover {
        let cover_xhtml = generate_cover_page(&metadata.title);
        zip.start_file("OPS/cover.xhtml", options_deflated)?;
        zip.write_all(cover_xhtml.as_bytes())?;
    }
    let titlepage_xhtml = generate_titlepage(&metadata.title, &metadata.author);
    zip.start_file("OPS/titlepage.xhtml", options_deflated)?;
    zip.write_all(titlepage_xhtml.as_bytes())?;

    // 6. Scrivi capitoli
    for filename in &chapter_filenames {
        let path = format!("OPS/{}", filename);
        zip.start_file(&path, options_deflated)?;
        zip.write_all(chapter_xhtml_map[filename].as_bytes())?;
    }

    // 7. Scrivi immagini
    for image in images {
        let path = format!("OPS/images/{}", image.filename);
        zip.start_file(&path, options_deflated)?;
        zip.write_all(&image.data)?;
    }

    // 8. package.opf
    let package_opf = generate_package_opf(metadata, &chapter_filenames, images, chapters, has_cover);
    zip.start_file("OPS/package.opf", options_deflated)?;
    zip.write_all(package_opf.as_bytes())?;

    // 9. TOC (nav) XHTML - EPUB 3
    let toc_xhtml = generate_toc_xhtml(chapters, &chapter_filenames);
    zip.start_file("OPS/toc.xhtml", options_deflated)?;
    zip.write_all(toc_xhtml.as_bytes())?;

    // 10. toc.ncx - retrocompatibilità EPUB 2
    let toc_ncx = generate_toc_ncx(metadata, chapters, &chapter_filenames);
    zip.start_file("OPS/toc.ncx", options_deflated)?;
    zip.write_all(toc_ncx.as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Converte Markdown in XHTML valido per EPUB
fn markdown_to_xhtml(markdown: &str, css_files: &[&str]) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_MATH);

    let parser = Parser::new_ext(markdown, options);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);

    let css_links: String = css_files
        .iter()
        .map(|css| format!(r#"<link rel="stylesheet" href="{}" type="text/css"/>"#, css))
        .collect::<Vec<_>>()
        .join("\n    ");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
    <meta charset="utf-8"/>
    {css_links}
</head>
<body>
{html_output}
</body>
</html>"#
    )
}

fn generate_container_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#
        .to_string()
}

fn generate_cover_page(title: &str) -> String {
    let title_escaped = html_escape(title);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
    <title>{title_escaped}</title>
    <style type="text/css">
        body {{
            margin: 0;
            padding: 0;
            text-align: center;
        }}
        img {{
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }}
    </style>
</head>
<body>
    <img src="images/cover.png" alt="{title_escaped}"/>
</body>
</html>"#
    )
}

fn generate_titlepage(title: &str, author: &str) -> String {
    let title_escaped = html_escape(title);
    let author_escaped = html_escape(author);

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
    <title>Cover Page</title>
    <style type="text/css">
        body {{
            margin: 0; padding: 0; height: 100vh;
            display: flex; justify-content: center; align-items: center;
            font-family: serif;
        }}
        .cover {{
            padding: 3em; text-align: center;
            border: 1px solid #ccc; max-width: 80%;
        }}
        h1 {{
            font-size: 2em; margin-bottom: 1em;
            line-height: 1.2; color: #333;
        }}
        p {{
            font-size: 1.2em; font-style: italic;
            color: #666; line-height: 1.4;
        }}
    </style>
</head>
<body>
    <div class="cover">
        <h1>{title_escaped}</h1>
        <p>{author_escaped}</p>
    </div>
</body>
</html>"#
    )
}

fn generate_package_opf(
    metadata: &EpubMetadata,
    chapter_filenames: &[String],
    images: &[EpubImage],
    _chapters: &[Chapter],
    has_cover: bool,
) -> String {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let mut manifest_items = String::new();
    let mut spine_items = String::new();

    // TOC nav
    manifest_items.push_str(
        r#"    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
"#,
    );
    // TOC ncx
    manifest_items.push_str(
        r#"    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
"#,
    );

    // Cover image e cover page (se presente)
    if has_cover {
        manifest_items.push_str(
            r#"    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
"#,
        );
        manifest_items.push_str(
            r#"    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
"#,
        );
        spine_items.push_str(r#"    <itemref idref="cover" linear="yes"/>"#);
        spine_items.push('\n');
    }

    // Titlepage
    manifest_items.push_str(
        r#"    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
"#,
    );
    spine_items.push_str(r#"    <itemref idref="titlepage" linear="yes"/>"#);
    spine_items.push('\n');

    // CSS
    manifest_items.push_str(
        r#"    <item id="css-style" href="css/style.css" media-type="text/css"/>
"#,
    );

    // Capitoli
    for (i, filename) in chapter_filenames.iter().enumerate() {
        manifest_items.push_str(&format!(
            r#"    <item id="ch{:04}" href="{}" media-type="application/xhtml+xml"/>
"#,
            i, filename
        ));
        spine_items.push_str(&format!(
            r#"    <itemref idref="ch{:04}" linear="yes"/>
"#,
            i
        ));
    }

    // Immagini
    for (i, image) in images.iter().enumerate() {
        manifest_items.push_str(&format!(
            r#"    <item id="img{:04}" href="images/{}" media-type="{}"/>
"#,
            i, image.filename, image.media_type
        ));
    }

    let title_escaped = html_escape(&metadata.title);
    let author_escaped = html_escape(&metadata.author);
    let identifier_escaped = html_escape(&metadata.identifier);
    let language = if metadata.language.is_empty() {
        "en"
    } else {
        &metadata.language
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="{language}" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title id="title">{title_escaped}</dc:title>
    <dc:creator id="creator">{author_escaped}</dc:creator>
    <dc:identifier id="pub-id">{identifier_escaped}</dc:identifier>
    <dc:language>{language}</dc:language>
    <dc:publisher>{publisher}</dc:publisher>
    <dc:rights>{rights}</dc:rights>
    <dc:date>{date}</dc:date>
    <meta property="dcterms:modified">{now}</meta>
  </metadata>
  <manifest>
{manifest_items}  </manifest>
  <spine toc="ncx">
{spine_items}  </spine>
</package>"#,
        publisher = html_escape(&metadata.publisher),
        rights = html_escape(&metadata.rights),
        date = html_escape(&metadata.date),
    )
}

fn generate_toc_xhtml(chapters: &[Chapter], chapter_filenames: &[String]) -> String {
    let mut items = String::new();
    for (i, chapter) in chapters.iter().enumerate() {
        let title_escaped = html_escape(&chapter.title);
        items.push_str(&format!(
            r#"      <li><a href="{}">{}</a></li>
"#,
            chapter_filenames[i], title_escaped
        ));
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
    <meta charset="utf-8"/>
    <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" role="doc-toc" id="toc">
    <h2>Contents</h2>
    <ol epub:type="list">
{items}    </ol>
  </nav>
</body>
</html>"#
    )
}

fn generate_toc_ncx(
    metadata: &EpubMetadata,
    chapters: &[Chapter],
    chapter_filenames: &[String],
) -> String {
    let mut nav_points = String::new();
    for (i, chapter) in chapters.iter().enumerate() {
        let title_escaped = html_escape(&chapter.title);
        nav_points.push_str(&format!(
            r#"    <navPoint id="navpoint-{i}" playOrder="{order}">
      <navLabel><text>{title_escaped}</text></navLabel>
      <content src="{src}"/>
    </navPoint>
"#,
            i = i,
            order = i + 1,
            src = chapter_filenames[i],
        ));
    }

    let uid_escaped = html_escape(&metadata.identifier);
    let title_escaped = html_escape(&metadata.title);

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" xml:lang="en" version="2005-1">
  <head>
    <meta name="dtb:uid" content="{uid_escaped}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{title_escaped}</text></docTitle>
  <navMap>
{nav_points}  </navMap>
</ncx>"#
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const DEFAULT_CSS: &str = r#"body {
    font-family: Georgia, serif;
    line-height: 1.6;
    margin: 5%;
    text-align: justify;
}

h1, h2, h3, h4, h5, h6 {
    font-family: "Helvetica Neue", Arial, sans-serif;
    text-align: left;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
}

h1 { font-size: 1.8em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.3em; }

p {
    margin: 0.8em 0;
    text-indent: 0;
}

img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1em auto;
}

pre, code {
    font-family: "Courier New", monospace;
    font-size: 0.85em;
    background-color: #f5f5f5;
    border-radius: 3px;
}

pre {
    padding: 1em;
    overflow-x: auto;
    border: 1px solid #ddd;
}

code {
    padding: 0.2em 0.4em;
}

table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
}

th, td {
    border: 1px solid #ddd;
    padding: 0.5em;
    text-align: left;
}

th {
    background-color: #f0f0f0;
    font-weight: bold;
}

blockquote {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 3px solid #ccc;
    color: #555;
}

ul, ol {
    margin: 0.8em 0;
    padding-left: 2em;
}

li {
    margin: 0.3em 0;
}

.math-display {
    text-align: center;
    margin: 1em 0;
    overflow-x: auto;
}

.math-inline {
    display: inline;
}
"#;
