//! Client per OpenRouter API - LLM multimodale per conversione immagini → Markdown.
//!
//! Invia le immagini delle pagine PDF a un modello multimodale (es. GPT-4o, Claude)
//! tramite OpenRouter e riceve il testo estratto in formato Markdown.

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const OPENROUTER_API_URL: &str = "https://openrouter.ai/api/v1/chat/completions";

/// Configurazione per il client OpenRouter
#[derive(Clone)]
pub struct OpenRouterConfig {
    /// API key per OpenRouter
    pub api_key: String,
    /// Modello da utilizzare (es. "google/gemini-2.0-flash-001", "openai/gpt-4o")
    pub model: String,
    /// Timeout per le richieste in secondi
    pub timeout_secs: u64,
    /// Numero massimo di retry per richiesta
    pub max_retries: u32,
    /// Temperatura per la generazione (0.0 = deterministico)
    pub temperature: f32,
}

impl Default for OpenRouterConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model: "google/gemini-2.0-flash-001".to_string(),
            timeout_secs: 120,
            max_retries: 3,
            temperature: 0.1,
        }
    }
}

/// Client per interagire con OpenRouter
pub struct OpenRouterClient {
    client: Client,
    config: OpenRouterConfig,
}

// --- Strutture per la richiesta API ---

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: Vec<ContentPart>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

#[derive(Serialize)]
struct ImageUrl {
    url: String,
    detail: String,
}

// --- Strutture per la risposta API ---

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

impl OpenRouterClient {
    /// Crea un nuovo client OpenRouter
    pub fn new(config: OpenRouterConfig) -> Result<Self> {
        if config.api_key.is_empty() {
            bail!("API key OpenRouter non configurata");
        }

        let client = Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .context("Errore nella creazione del client HTTP")?;

        Ok(Self { client, config })
    }

    /// Converte un'immagine di una pagina PDF in Markdown usando il LLM multimodale.
    ///
    /// # Arguments
    /// * `png_data` - Dati PNG dell'immagine della pagina
    /// * `page_number` - Numero della pagina (per contesto)
    /// * `total_pages` - Numero totale di pagine (per contesto)
    /// * `previous_context` - Ultime righe della pagina precedente (per continuità)
    ///
    /// # Returns
    /// Il testo Markdown estratto dalla pagina
    pub async fn image_to_markdown(
        &self,
        png_data: &[u8],
        page_number: usize,
        total_pages: usize,
        previous_context: Option<&str>,
    ) -> Result<String> {
        let base64_image = BASE64.encode(png_data);
        let image_data_url = format!("data:image/png;base64,{}", base64_image);

        let system_prompt = build_system_prompt(page_number, total_pages, previous_context);

        let messages = vec![Message {
            role: "user".to_string(),
            content: vec![
                ContentPart::Text {
                    text: system_prompt,
                },
                ContentPart::ImageUrl {
                    image_url: ImageUrl {
                        url: image_data_url,
                        detail: "high".to_string(),
                    },
                },
            ],
        }];

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: 4096,
        };

        let mut last_error = None;

        for attempt in 0..=self.config.max_retries {
            if attempt > 0 {
                // Backoff esponenziale
                let delay = Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            match self.send_request(&request).await {
                Ok(markdown) => return Ok(markdown),
                Err(e) => {
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Errore sconosciuto")))
    }

    async fn send_request(&self, request: &ChatRequest) -> Result<String> {
        let response = self
            .client
            .post(OPENROUTER_API_URL)
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "tauri://pdf2epub")
            .header("X-Title", "PDF2EPUB Converter")
            .json(request)
            .send()
            .await
            .context("Errore nella richiesta a OpenRouter")?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            if let Ok(error_resp) = serde_json::from_str::<ErrorResponse>(&body) {
                if let Some(error) = error_resp.error {
                    bail!(
                        "OpenRouter API errore ({}): {}",
                        status.as_u16(),
                        error.message
                    );
                }
            }
            bail!("OpenRouter API errore ({}): {}", status.as_u16(), body);
        }

        let chat_response: ChatResponse = response
            .json()
            .await
            .context("Errore nel parsing della risposta OpenRouter")?;

        let content = chat_response
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();

        // Rimuovi eventuali wrapper markdown (```markdown ... ```)
        Ok(clean_markdown_response(&content))
    }
}

/// Costruisce il prompt di sistema per l'estrazione del testo
fn build_system_prompt(
    page_number: usize,
    total_pages: usize,
    previous_context: Option<&str>,
) -> String {
    let mut prompt = format!(
        r#"Sei un sistema di estrazione testo da immagini di pagine PDF. Converti il contenuto visibile in questa immagine (pagina {} di {}) in formato Markdown ben strutturato.

REGOLE:
1. Estrai TUTTO il testo visibile nell'immagine, mantenendo la struttura del documento
2. Usa heading Markdown appropriati (# ## ### etc.) per i titoli e sottotitoli
3. Preserva la formattazione: grassetto, corsivo, elenchi puntati/numerati
4. Converti le tabelle in formato Markdown
5. Per le equazioni matematiche, usa la notazione LaTeX inline ($...$) o display ($$...$$)
6. Per le immagini/figure, inserisci un placeholder: ![Descrizione figura](images/figure_pN_X.png) dove N è il numero di pagina (1-indexed) e X è l'indice progressivo dell'immagine nella pagina (partendo da 1)
7. NON aggiungere commenti, spiegazioni o testo che non sia presente nell'immagine
8. NON includere header/footer ripetitivi (numeri di pagina, titoli di sezione ripetuti in alto/basso)
9. Se il testo continua dalla pagina precedente, NON ripetere il contesto precedente
10. Mantieni i paragrafi separati con una riga vuota
11. Per il codice sorgente, usa i blocchi di codice con il linguaggio appropriato

FORMATO OUTPUT: Restituisci SOLO il Markdown estratto, senza wrapper o delimitatori aggiuntivi."#,
        page_number + 1,
        total_pages
    );

    if let Some(context) = previous_context {
        prompt.push_str(&format!(
            "\n\nCONTESTO: Le ultime righe della pagina precedente erano:\n---\n{}\n---\nSe il testo di questa pagina continua dal precedente, prosegui senza ripetizioni.",
            context
        ));
    }

    prompt
}

/// Pulisce la risposta rimuovendo eventuali wrapper markdown
fn clean_markdown_response(content: &str) -> String {
    let trimmed = content.trim();

    // Rimuovi wrapper ```markdown ... ``` se presente
    if trimmed.starts_with("```markdown") || trimmed.starts_with("```md") {
        if let Some(end_idx) = trimmed.rfind("```") {
            let start_idx = trimmed.find('\n').unwrap_or(0) + 1;
            if end_idx > start_idx {
                return trimmed[start_idx..end_idx].trim().to_string();
            }
        }
    }

    // Rimuovi wrapper ``` generico
    if trimmed.starts_with("```") && trimmed.ends_with("```") {
        let inner = &trimmed[3..trimmed.len() - 3];
        let inner = if inner.starts_with('\n') {
            &inner[1..]
        } else {
            inner
        };
        return inner.trim().to_string();
    }

    trimmed.to_string()
}
