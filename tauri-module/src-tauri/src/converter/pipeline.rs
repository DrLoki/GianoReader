//! Pipeline completa PDF → Markdown → EPUB.
//!
//! Orchestratore che coordina i vari step della conversione:
//! 1. Rendering pagine PDF come immagini
//! 2. Invio immagini all'LLM multimodale via OpenRouter
//! 3. Assemblaggio del Markdown
//! 4. Generazione EPUB

use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::epub::{Chapter, CoverImage, EpubImage, EpubMetadata, generate_epub};
use super::openrouter::{OpenRouterClient, OpenRouterConfig};
use super::pdf_to_images::{RenderConfig, extract_images_from_pdf, get_page_count, render_pdf_pages_with_progress};

/// Stato di avanzamento della conversione
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "stage")]
pub enum ConversionProgress {
    /// Rendering delle pagine PDF
    RenderingPages { current: usize, total: usize },
    /// Estrazione testo tramite LLM
    ExtractingText { current: usize, total: usize },
    /// Generazione EPUB
    GeneratingEpub,
    /// Conversione completata
    Completed { output_path: String },
    /// Errore durante la conversione
    Error { message: String },
}

/// Configurazione completa per la pipeline di conversione
#[derive(Clone, Serialize, Deserialize)]
pub struct ConversionConfig {
    /// Percorso al file PDF di input
    pub input_path: String,
    /// Percorso di output per l'EPUB (opzionale, derivato dal nome PDF se assente)
    pub output_path: Option<String>,
    /// API key OpenRouter
    pub api_key: String,
    /// Modello LLM da usare
    pub model: String,
    /// DPI per il rendering (default: 150)
    pub dpi: Option<u32>,
    /// Pagina iniziale (0-indexed)
    pub start_page: Option<usize>,
    /// Numero massimo di pagine
    pub max_pages: Option<usize>,
    /// Metadati EPUB
    pub metadata: ConversionMetadata,
    /// CSS personalizzato (opzionale)
    pub custom_css: Option<String>,
    /// Numero di richieste parallele all'LLM (default: 3)
    pub concurrency: Option<usize>,
}

/// Metadati forniti dall'utente per l'EPUB
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ConversionMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
}

/// Risultato della conversione
#[derive(Serialize, Deserialize)]
pub struct ConversionResult {
    /// Percorso al file EPUB generato
    pub epub_path: String,
    /// Percorso al file Markdown intermedio
    pub markdown_path: String,
    /// Numero di pagine processate
    pub pages_processed: usize,
}

/// Esegue la pipeline completa di conversione PDF → Markdown → EPUB.
///
/// Invia aggiornamenti di progresso tramite il canale `progress_tx`.
pub async fn convert_pdf_to_epub(
    config: ConversionConfig,
    progress_tx: mpsc::Sender<ConversionProgress>,
) -> Result<ConversionResult> {
    let input_path = PathBuf::from(&config.input_path);
    let pdf_stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Determina percorso di output
    let output_dir = if let Some(ref out) = config.output_path {
        PathBuf::from(out)
    } else {
        input_path.parent().unwrap_or(Path::new(".")).join(&pdf_stem)
    };
    std::fs::create_dir_all(&output_dir)
        .with_context(|| format!("Impossibile creare la directory: {}", output_dir.display()))?;

    let epub_path = output_dir.join(format!("{}.epub", pdf_stem));
    let markdown_path = output_dir.join(format!("{}.md", pdf_stem));

    // --- STEP 1: Rendering pagine PDF ---
    let total_pages = get_page_count(&input_path)?;
    let _ = progress_tx
        .send(ConversionProgress::RenderingPages {
            current: 0,
            total: total_pages,
        })
        .await;

    let render_config = RenderConfig {
        dpi: config.dpi.unwrap_or(150),
        start_page: config.start_page,
        max_pages: config.max_pages,
    };

    // Usa un canale sync per ricevere progress dal thread di rendering
    let (render_progress_tx, mut render_progress_rx) = tokio::sync::mpsc::channel::<(usize, usize)>(16);
    let progress_tx_render = progress_tx.clone();

    // Task che inoltra i progress dal rendering al canale principale
    let progress_forwarder = tokio::spawn(async move {
        while let Some((current, total)) = render_progress_rx.recv().await {
            let _ = progress_tx_render
                .send(ConversionProgress::RenderingPages { current, total })
                .await;
        }
    });

    let rendered_pages = tokio::task::spawn_blocking({
        let input_path = input_path.clone();
        let render_config = render_config.clone();
        move || {
            let rt = tokio::runtime::Handle::current();
            render_pdf_pages_with_progress(&input_path, &render_config, Some(&|current, total| {
                let _ = rt.block_on(render_progress_tx.send((current, total)));
            }))
        }
    })
    .await
    .context("Task di rendering fallito")??;

    // Attendi che tutti i progress siano stati inoltrati
    let _ = progress_forwarder.await;

    let pages_to_process = rendered_pages.len();

    // Salva i dati della prima pagina per la copertina (prima che vengano consumati)
    let cover_png_data: Option<Vec<u8>> = rendered_pages.first().map(|p| p.png_data.clone());

    // --- STEP 2: Estrazione testo tramite LLM ---
    let openrouter_config = OpenRouterConfig {
        api_key: config.api_key.clone(),
        model: config.model.clone(),
        temperature: 0.1,
        ..Default::default()
    };

    let client = OpenRouterClient::new(openrouter_config)?;
    let concurrency = config.concurrency.unwrap_or(3).min(5); // Max 5 parallele

    let mut page_markdowns: Vec<(usize, String)> = Vec::with_capacity(pages_to_process);

    // Processa le pagine con concorrenza limitata
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let client = std::sync::Arc::new(client);
    let progress_tx_clone = progress_tx.clone();

    let mut handles = Vec::new();
    let completed_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

    for page in rendered_pages {
        let sem = semaphore.clone();
        let client = client.clone();
        let progress_tx = progress_tx_clone.clone();
        let completed = completed_count.clone();
        let total = pages_to_process;

        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();

            // Contesto dalla pagina precedente (semplificato: non disponibile in parallelo)
            let result = client
                .image_to_markdown(&page.png_data, page.page_number, total, None)
                .await;

            let count = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let _ = progress_tx
                .send(ConversionProgress::ExtractingText {
                    current: count,
                    total,
                })
                .await;

            result.map(|md| (page.page_number, md))
        });

        handles.push(handle);
    }

    // Raccogli risultati
    for handle in handles {
        let result = handle.await.context("Task LLM fallito")??;
        page_markdowns.push(result);
    }

    // Ordina per numero di pagina
    page_markdowns.sort_by_key(|(page_num, _)| *page_num);

    // Assembla il Markdown completo
    let full_markdown: String = page_markdowns
        .iter()
        .map(|(_, md)| md.as_str())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    // Salva il Markdown intermedio
    std::fs::write(&markdown_path, &full_markdown)
        .with_context(|| format!("Impossibile salvare il Markdown: {}", markdown_path.display()))?;

    // --- STEP 3: Generazione EPUB ---
    let _ = progress_tx.send(ConversionProgress::GeneratingEpub).await;

    let metadata = EpubMetadata {
        title: config
            .metadata
            .title
            .unwrap_or_else(|| pdf_stem.clone()),
        author: config
            .metadata
            .author
            .unwrap_or_else(|| "Unknown".to_string()),
        language: config
            .metadata
            .language
            .unwrap_or_else(|| "en".to_string()),
        identifier: format!("pdf2epub-{}-{}", pdf_stem, Utc::now().timestamp()),
        publisher: config
            .metadata
            .publisher
            .unwrap_or_else(|| "PDF2EPUB".to_string()),
        rights: "All rights reserved".to_string(),
        date: Utc::now().format("%Y-%m-%d").to_string(),
    };

    // Dividi il markdown in capitoli (per heading H1/H2 o per separatore di pagina)
    let chapters = split_into_chapters(&full_markdown, &pdf_stem);

    // Estrai immagini embedded dal PDF
    let start = config.start_page.unwrap_or(0);
    let end = config
        .max_pages
        .map(|max| (start + max).min(total_pages))
        .unwrap_or(total_pages);

    let extracted_images = {
        let input_path = input_path.clone();
        tokio::task::spawn_blocking(move || {
            extract_images_from_pdf(&input_path, start, end)
        })
        .await
        .context("Task estrazione immagini fallito")?
        .unwrap_or_else(|_| Vec::new())
    };

    // Converti ExtractedImage → EpubImage
    let images: Vec<EpubImage> = extracted_images
        .into_iter()
        .map(|img| EpubImage {
            filename: img.filename,
            data: img.png_data,
            media_type: img.media_type,
        })
        .collect();

    // Cover: usa il render della prima pagina come copertina
    let cover = cover_png_data.map(|png_data| CoverImage { png_data });

    let css = config.custom_css.as_deref();

    generate_epub(&epub_path, &metadata, &chapters, &images, css, cover.as_ref())?;

    let _ = progress_tx
        .send(ConversionProgress::Completed {
            output_path: epub_path.display().to_string(),
        })
        .await;

    Ok(ConversionResult {
        epub_path: epub_path.display().to_string(),
        markdown_path: markdown_path.display().to_string(),
        pages_processed: pages_to_process,
    })
}

/// Divide il Markdown in capitoli basandosi sugli heading H1 o H2.
/// Se non ci sono heading, crea un singolo capitolo.
fn split_into_chapters(markdown: &str, default_title: &str) -> Vec<Chapter> {
    let mut chapters: Vec<Chapter> = Vec::new();
    let mut current_title = String::new();
    let mut current_content = String::new();

    for line in markdown.lines() {
        // Rileva heading H1 o H2
        if line.starts_with("# ") || line.starts_with("## ") {
            // Salva il capitolo precedente se ha contenuto
            if !current_content.trim().is_empty() {
                let title = if current_title.is_empty() {
                    format!("{} - Part {}", default_title, chapters.len() + 1)
                } else {
                    current_title.clone()
                };
                chapters.push(Chapter {
                    title,
                    markdown_content: current_content.trim().to_string(),
                });
            }

            // Inizia nuovo capitolo
            current_title = line
                .trim_start_matches('#')
                .trim()
                .to_string();
            current_content = format!("{}\n", line);
        } else {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }

    // Ultimo capitolo
    if !current_content.trim().is_empty() {
        let title = if current_title.is_empty() {
            default_title.to_string()
        } else {
            current_title
        };
        chapters.push(Chapter {
            title,
            markdown_content: current_content.trim().to_string(),
        });
    }

    // Se non ci sono capitoli, crea uno singolo
    if chapters.is_empty() {
        chapters.push(Chapter {
            title: default_title.to_string(),
            markdown_content: markdown.to_string(),
        });
    }

    chapters
}

/// Restituisce il numero di pagine di un PDF (utility per il frontend)
pub fn get_pdf_page_count(pdf_path: &str) -> Result<usize> {
    get_page_count(Path::new(pdf_path))
}
