//! Modulo per la conversione delle pagine PDF in immagini.
//!
//! Utilizza `pdfium-render` per renderizzare ogni pagina del PDF come immagine PNG,
//! che verrà poi inviata all'LLM multimodale per l'estrazione del testo in markdown.

use std::path::Path;
use anyhow::{Context, Result};
use pdfium_render::prelude::*;

/// Crea un'istanza di Pdfium cercando la libreria nella directory dell'eseguibile.
fn create_pdfium() -> Result<Pdfium> {
    // Cerca pdfium.dll nella directory dell'eseguibile
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    if let Some(dir) = exe_dir {
        let bindings = Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(dir.to_str().unwrap_or("."))
        );
        if let Ok(b) = bindings {
            return Ok(Pdfium::new(b));
        }
    }

    // Fallback: cerca nel PATH di sistema
    let bindings = Pdfium::bind_to_system_library()
        .context("pdfium.dll non trovata. Scaricala da https://github.com/bblanchon/pdfium-binaries/releases e copiala nella cartella dell'eseguibile.")?;
    Ok(Pdfium::new(bindings))
}

/// Rappresenta una pagina PDF renderizzata come immagine
pub struct RenderedPage {
    /// Numero della pagina (0-indexed)
    pub page_number: usize,
    /// Dati PNG dell'immagine della pagina
    pub png_data: Vec<u8>,
    /// Larghezza in pixel
    pub width: u32,
    /// Altezza in pixel
    pub height: u32,
}

/// Configurazione per il rendering delle pagine PDF
#[derive(Clone)]
pub struct RenderConfig {
    /// DPI per il rendering (default: 150 - buon compromesso qualità/dimensione)
    pub dpi: u32,
    /// Pagina iniziale (0-indexed, None = dalla prima)
    pub start_page: Option<usize>,
    /// Numero massimo di pagine da processare (None = tutte)
    pub max_pages: Option<usize>,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            dpi: 150,
            start_page: None,
            max_pages: None,
        }
    }
}

/// Renderizza le pagine di un PDF come immagini PNG.
///
/// # Arguments
/// * `pdf_path` - Percorso al file PDF
/// * `config` - Configurazione per il rendering
///
/// # Returns
/// Un vettore di `RenderedPage` con i dati PNG di ogni pagina
pub fn render_pdf_pages(pdf_path: &Path, config: &RenderConfig) -> Result<Vec<RenderedPage>> {
    render_pdf_pages_with_progress(pdf_path, config, None)
}

/// Renderizza le pagine di un PDF come immagini PNG, con callback di progresso opzionale.
///
/// # Arguments
/// * `pdf_path` - Percorso al file PDF
/// * `config` - Configurazione per il rendering
/// * `progress_cb` - Callback opzionale chiamata dopo ogni pagina con (current, total)
///
/// # Returns
/// Un vettore di `RenderedPage` con i dati PNG di ogni pagina
pub fn render_pdf_pages_with_progress(
    pdf_path: &Path,
    config: &RenderConfig,
    progress_cb: Option<&dyn Fn(usize, usize)>,
) -> Result<Vec<RenderedPage>> {
    let pdfium = create_pdfium()?;

    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .with_context(|| format!("Impossibile aprire il PDF: {}", pdf_path.display()))?;

    let total_pages = document.pages().len() as usize;
    let start = config.start_page.unwrap_or(0);
    let end = config
        .max_pages
        .map(|max| (start + max).min(total_pages))
        .unwrap_or(total_pages);

    let pages_count = end - start;
    let mut rendered_pages = Vec::with_capacity(pages_count);

    for page_index in start..end {
        let page = document
            .pages()
            .get(page_index as u16)
            .with_context(|| format!("Impossibile accedere alla pagina {}", page_index))?;

        // Calcola dimensioni in pixel basate sul DPI
        let scale = config.dpi as f32 / 72.0; // PDF usa 72 DPI come base
        let width = (page.width().value * scale) as u32;
        let height = (page.height().value * scale) as u32;

        // Renderizza la pagina come bitmap
        let bitmap = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(width as i32)
                    .set_target_height(height as i32)
                    .render_form_data(true)
                    .render_annotations(true),
            )
            .with_context(|| format!("Errore nel rendering della pagina {}", page_index))?;

        // Converti in PNG
        let image = bitmap.as_image();
        let mut png_data = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_data);
        image
            .write_to(&mut cursor, image::ImageFormat::Png)
            .with_context(|| format!("Errore nella codifica PNG della pagina {}", page_index))?;

        rendered_pages.push(RenderedPage {
            page_number: page_index,
            png_data,
            width,
            height,
        });

        // Notifica progresso
        if let Some(cb) = &progress_cb {
            cb(rendered_pages.len(), pages_count);
        }
    }

    Ok(rendered_pages)
}

/// Rappresenta un'immagine estratta da una pagina PDF
pub struct ExtractedImage {
    /// Nome del file (es. "figure_p1_1.png")
    pub filename: String,
    /// Dati PNG dell'immagine
    pub png_data: Vec<u8>,
    /// Media type (sempre "image/png" dopo conversione)
    pub media_type: String,
    /// Numero della pagina di provenienza (0-indexed)
    pub page_number: usize,
}

/// Estrae le immagini embedded da tutte le pagine del PDF.
///
/// Itera sugli oggetti di ogni pagina e identifica quelli di tipo immagine,
/// esportandoli come PNG. Il naming segue la convenzione `figure_p{page+1}_{index}.png`
/// per allinearsi con i placeholder generati dal LLM.
///
/// # Arguments
/// * `pdf_path` - Percorso al file PDF
/// * `start_page` - Pagina iniziale (0-indexed)
/// * `end_page` - Pagina finale (esclusiva)
///
/// # Returns
/// Un vettore di `ExtractedImage` con i dati PNG di ogni immagine trovata
pub fn extract_images_from_pdf(
    pdf_path: &Path,
    start_page: usize,
    end_page: usize,
) -> Result<Vec<ExtractedImage>> {
    let pdfium = create_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .with_context(|| format!("Impossibile aprire il PDF: {}", pdf_path.display()))?;

    let mut extracted_images = Vec::new();

    for page_index in start_page..end_page {
        let page = match document.pages().get(page_index as u16) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let mut image_index = 1usize;

        for object in page.objects().iter() {
            if let Some(image_object) = object.as_image_object() {
                // Tenta di ottenere l'immagine come DynamicImage
                if let Ok(dynamic_image) = image_object.get_raw_image() {
                    let mut png_data = Vec::new();
                    let mut cursor = std::io::Cursor::new(&mut png_data);
                    if dynamic_image
                        .write_to(&mut cursor, image::ImageFormat::Png)
                        .is_ok()
                    {
                        // Filtra immagini troppo piccole (probabilmente artefatti/decorazioni)
                        let (w, h) = (dynamic_image.width(), dynamic_image.height());
                        if w >= 50 && h >= 50 {
                            let filename =
                                format!("figure_p{}_{}.png", page_index + 1, image_index);
                            extracted_images.push(ExtractedImage {
                                filename,
                                png_data,
                                media_type: "image/png".to_string(),
                                page_number: page_index,
                            });
                            image_index += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(extracted_images)
}

/// Restituisce il numero totale di pagine nel PDF
pub fn get_page_count(pdf_path: &Path) -> Result<usize> {
    let pdfium = create_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .with_context(|| format!("Impossibile aprire il PDF: {}", pdf_path.display()))?;
    Ok(document.pages().len() as usize)
}
