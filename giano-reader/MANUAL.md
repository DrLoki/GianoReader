# Giano Reader — Manuale Utente

## Indice

1. [Introduzione](#introduzione)
2. [Installazione](#installazione)
3. [Apertura di un libro](#apertura-di-un-libro)
4. [Interfaccia principale](#interfaccia-principale)
5. [Lettura e navigazione](#lettura-e-navigazione)
6. [Traduzione](#traduzione)
7. [Libreria](#libreria)
8. [Segnalibri](#segnalibri)
9. [Impostazioni](#impostazioni)
10. [Domande frequenti](#domande-frequenti)

---

## Introduzione

**Giano Reader** è un lettore EPUB desktop con traduzione affiancata integrata tramite Google Translate. Mostra il testo originale e la traduzione in due pannelli sincronizzati, traducendo in modo lazy a partire dalla posizione di lettura corrente.

Funziona come applicazione desktop (Windows, macOS, Linux) tramite Tauri, e in modalità ridotta anche nel browser.

---

## Installazione

### Windows

1. Scarica il file `.msi` o `.exe` dalla pagina delle release.
2. Esegui il file e segui la procedura guidata.
3. Al termine, avvia **Giano Reader** dal menu Start o dal desktop.

> **Requisito:** WebView2 Runtime. È incluso in Windows 11; su Windows 10 viene installato automaticamente se non presente.

### macOS

1. Scarica il file `.dmg`.
2. Apri il `.dmg` e trascina l'app nella cartella **Applicazioni**.
3. Al primo avvio, se macOS blocca l'app (sviluppatore non verificato), vai in **Impostazioni di sistema → Privacy e sicurezza** e clicca **Apri comunque**.

### Linux

1. Scarica il pacchetto `.deb` (Debian/Ubuntu) o `.AppImage`.
2. Per il `.deb`: `sudo dpkg -i giano-reader_*.deb`
3. Per l'`.AppImage`: rendi il file eseguibile (`chmod +x`) e avvialo direttamente.

---

## Apertura di un libro

Clicca il pulsante **+ Apri libro** nella barra laterale sinistra. Si apre una finestra di dialogo nativa per selezionare un file `.epub`.

Una volta caricato il libro:
- Il titolo e l'autore appaiono in cima alla barra laterale.
- L'indice (TOC) viene popolato automaticamente.
- Il primo capitolo con contenuto reale viene visualizzato.
- Il libro viene aggiunto automaticamente alla Libreria (solo app desktop).

> **Nota browser:** nel browser non è disponibile il dialogo nativo. Viene usato un `<input type="file">` standard. La Libreria e i segnalibri con riapertura automatica richiedono l'app desktop.

---

## Interfaccia principale

```
┌──────────────────┬───────────────────────┬──────────────────────┐
│   Barra laterale │   Pannello originale  │  Pannello traduzione │
│                  │                       │                      │
│  + Apri libro    │  Testo originale      │  Testo tradotto      │
│  ─────────────   │  del capitolo         │  (lazy, dal punto    │
│  Indice (TOC)    │                       │   di lettura)        │
│                  │                       │                      │
│  [Segnalibri]    │                       │                      │
│  [Libreria]      │                       │                      │
│  [Impostazioni]  │                       │                      │
└──────────────────┴───────────────────────┴──────────────────────┘
         Barra di progresso con tacche per capitolo
```

### Barra di progresso

La barra in fondo mostra la posizione nel libro. Ogni tacca corrisponde a un capitolo dello spine EPUB. Passando il mouse su una tacca appare il titolo del capitolo; cliccando si naviga direttamente a quel capitolo.

### Pulsanti nella barra laterale

| Pulsante | Funzione |
|---|---|
| **+ Apri libro** | Apre un file EPUB |
| Icona segnalibro | Apre la modale dei segnalibri |
| Icona stella | Aggiunge un segnalibro alla posizione corrente |
| Icona libreria | Apre la Libreria |
| Icona ingranaggio | Apre le Impostazioni |
| Icona frecce | Nasconde/mostra il pannello di traduzione |
| Icona immagine | Commuta tra vista testo e vista originale EPUB |

---

## Lettura e navigazione

### Navigazione tra capitoli

- Usa i pulsanti **‹** e **›** ai lati della barra di progresso.
- Clicca una voce nell'**indice** nella barra laterale.
- Clicca una **tacca** sulla barra di progresso.

### Scorrimento

I due pannelli (originale e traduzione) scorrono in modo sincronizzato: muovendo uno, l'altro segue proporzionalmente.

**Scorciatoie da tastiera:**

| Tasto | Azione |
|---|---|
| `↓` / `↑` | Scorre di 3 righe |
| `Spazio` | Scorre di una pagina in avanti |
| `Shift + Spazio` | Scorre di una pagina indietro |

### Vista originale EPUB

Clicca l'icona **immagine** (file-image) per passare alla vista originale: il capitolo viene renderizzato in un iframe con il CSS dell'EPUB originale. In questa modalità lo scroll sincronizzato è disattivato. I link interni al libro funzionano normalmente.

---

## Traduzione

### Come funziona

La traduzione usa l'endpoint pubblico non ufficiale di Google Translate (`translate.googleapis.com`) — non richiede chiave API. Il testo viene suddiviso in blocchi da ~4500 caratteri e tradotto in modo **lazy**:

1. Al caricamento del capitolo viene tradotto subito il blocco visibile.
2. Man mano che scorri verso il basso, i blocchi successivi vengono tradotti automaticamente.
3. I blocchi precedenti (sopra la posizione iniziale) vengono tradotti in background.

I paragrafi in attesa di traduzione appaiono in grigio attenuato; diventano normali una volta tradotti.

### Cambiare lingua di traduzione

Usa il menu a tendina con le bandiere nella barra laterale. Cambiando lingua, la traduzione del capitolo corrente riparte automaticamente.

### Nascondere il pannello di traduzione

Clicca l'icona **frecce** (arrows-left-right-to-line) per nascondere o mostrare il pannello di traduzione. Utile per leggere solo il testo originale a schermo intero.

> **Nota:** L'endpoint non ufficiale è adatto solo a uso personale. Per uso commerciale o ad alto volume si raccomanda l'[API ufficiale Google Cloud Translation](https://cloud.google.com/translate).

---

## Libreria

La Libreria raccoglie i tuoi file EPUB in un'unica vista con copertine, metadati e stato di lettura. È disponibile solo nell'app desktop (Tauri).

### Aprire la Libreria

Clicca l'icona **libreria** nella barra laterale. Si apre la modale con la griglia dei libri.

---

### Aggiungere libri alla Libreria

Ci sono due modi per popolare la Libreria:

#### 1. Aggiunta automatica all'apertura

Ogni volta che apri un file EPUB tramite **+ Apri libro**, il libro viene aggiunto automaticamente alla Libreria (se non è già presente). La copertina viene estratta in background e aggiornata non appena disponibile.

#### 2. Scansione di una cartella

Questo è il metodo principale per importare una collezione esistente:

1. Apri la Libreria cliccando l'icona libreria.
2. Clicca il pulsante **Seleziona cartella** (icona upload).
3. Scegli la cartella radice che contiene i tuoi file EPUB.
4. Giano Reader scansiona la cartella e le sottocartelle fino alla profondità configurata (default: 3 livelli).
5. Per ogni file `.epub` trovato vengono estratti automaticamente: titolo, autore, editore, anno, lingua, descrizione, copertina e stima del numero di pagine.
6. Al termine viene mostrato un riepilogo: *"Scansione completata: X aggiunti, Y già in libreria."*

> **Profondità di scansione:** puoi modificare il numero di livelli di sottocartelle esplorati nelle **Impostazioni** (campo *Profondità di ricerca*, valore da 1 a 10). Aumenta il valore se hai una struttura di cartelle molto annidata.

#### 3. Importazione da file JSON

Se hai esportato la Libreria in precedenza (o vuoi trasferirla da un altro dispositivo):

1. Apri la Libreria.
2. Clicca l'icona **importa** (freccia su).
3. Seleziona il file `.json` esportato in precedenza.
4. I libri vengono aggiunti a quelli esistenti; i duplicati (stesso percorso file) vengono ignorati.

---

### Navigare nella Libreria

- **Cerca** per titolo o autore usando il campo di ricerca in cima alla modale.
- **Filtra per stato** usando il menu a tendina (Tutti / Da leggere / In corso / Letto).
- Clicca una **card** per aprire direttamente il libro nel reader.

---

### Scheda libro (dettagli e note)

Ogni card ha un pulsante **ⓘ** che apre la scheda dettaglio del libro. Da qui puoi:

- Modificare titolo, autore, editore, anno, lingua.
- Impostare lo **stato di lettura**: Da leggere / In corso / Letto.
- Aggiungere **note personali** libere.
- Vedere le informazioni sul file (nome, dimensione, stima pagine).
- **Eliminare** il libro dalla Libreria (non cancella il file dal disco).

Clicca **Salva** per confermare le modifiche.

> Quando apri un libro dalla Libreria, lo stato passa automaticamente da *Da leggere* a *In corso* (se non era già *In corso* o *Letto*).

---

### Esportare la Libreria

1. Apri la Libreria.
2. Clicca l'icona **esporta** (freccia giù).
3. Scegli dove salvare il file `giano-library.json`.

Il file JSON contiene tutti i metadati e le copertine (come data URL). Può essere reimportato su un altro dispositivo o usato come backup.

---

### Svuotare la Libreria

Clicca l'icona **cestino** (lib-clear) nella barra degli strumenti della Libreria. Viene chiesta conferma prima di procedere. L'operazione rimuove tutti i record dalla Libreria ma **non cancella i file EPUB dal disco**.

---

## Segnalibri

### Aggiungere un segnalibro

1. Naviga al capitolo e alla posizione che vuoi salvare.
2. Clicca l'icona **stella** nella barra laterale.

Il segnalibro salva: percorso del file, capitolo corrente, posizione di scroll (percentuale).

> Il pulsante stella è attivo solo quando un libro è aperto nell'app desktop (richiede un percorso file assoluto).

### Aprire un segnalibro

1. Clicca l'icona **segnalibro** per aprire la modale.
2. Clicca il titolo o l'icona del segnalibro desiderato.
3. Il file viene aperto e la lettura riprende dal capitolo e dalla posizione salvati.

Se il file è stato spostato o rinominato, appare una finestra di dialogo che ti chiede di localizzarlo manualmente. Il percorso viene aggiornato automaticamente per le aperture future.

### Importare / Esportare segnalibri

Usa i pulsanti **importa** ed **esporta** nella modale dei segnalibri per salvare o caricare i segnalibri come file `giano-bookmarks.json`.

---

## Impostazioni

Apri le impostazioni cliccando l'icona **ingranaggio** nella barra laterale.

| Impostazione | Descrizione |
|---|---|
| **Lingua interfaccia** | Lingua dei testi dell'UI (12 lingue disponibili) |
| **Tema** | Dark (default), Light, Monokai, Solarized Dark, Nord, Sepia |
| **Carattere** | Font del testo di lettura |
| **Dimensione testo** | Slider da 12 a 32 px |
| **Profondità di ricerca** | Livelli di sottocartelle esplorati dalla scansione libreria (1–10, default 3) |

Tutte le impostazioni vengono salvate automaticamente in `localStorage`.

---

## Domande frequenti

**Il libro non si apre / rimane bloccato sul caricamento.**
Alcuni EPUB generati da Calibre possono impiegare più tempo del solito. Attendi fino a 20 secondi. Se il problema persiste, prova a riesportare il file da Calibre in formato EPUB 2.

**La traduzione non parte o mostra errori.**
Verifica la connessione internet. L'endpoint di Google Translate è non ufficiale e può essere temporaneamente non disponibile. Riprova dopo qualche secondo o cambia lingua e ritorna a quella originale per forzare un nuovo tentativo.

**I segnalibri non si aprono automaticamente.**
La riapertura automatica dei segnalibri richiede l'app desktop (Tauri). Nel browser è necessario aprire il file manualmente e navigare al capitolo indicato.

**La Libreria non trova i miei EPUB.**
Controlla la **Profondità di ricerca** nelle Impostazioni: se i tuoi file sono in sottocartelle molto annidate, aumenta il valore (es. da 3 a 5 o più). Poi ripeti la scansione della cartella.

**La copertina non appare nella Libreria.**
Alcuni EPUB non includono una copertina nel manifest. In questo caso la card mostra uno sfondo neutro. Non è un errore.

**Come faccio a rimuovere un libro dalla Libreria senza cancellarlo dal disco?**
Apri la scheda dettaglio del libro (pulsante **ⓘ**) e clicca **Rimuovi dalla libreria**. Il file EPUB rimane intatto sul disco.
