# Installing TTS Voices for Giano Reader

Giano Reader's FREE TTS mode uses your operating system's built-in speech synthesis voices. If you see the message **"No voice available"**, it means your system doesn't have a voice installed for the requested language.

Follow the instructions below for your operating system.

---

## Windows 10 / 11

1. Open **Settings** (Win + I)
2. Go to **Time & Language** → **Speech**
3. Under **Manage voices**, click **Add voices**
4. Find the language you need (e.g., Italian, French, Japanese)
5. Click **Add** and wait for the download to complete
6. Restart Giano Reader

### Alternative: via Language Packs

1. Open **Settings** → **Time & Language** → **Language & region**
2. Click **Add a language**
3. Search for the language and install it (make sure "Text-to-speech" is checked)
4. Restart Giano Reader

> **Note:** Windows voices are provided by Microsoft and vary in quality. Some languages have multiple voices (male/female). After installation, the new voices will appear in Giano Reader's voice selector.

---

## macOS

1. Open **System Settings** (or System Preferences on older versions)
2. Go to **Accessibility** → **Spoken Content**
3. Click the dropdown next to **System Voice** and select **Manage Voices...**
4. Find the language you need and download the desired voice(s)
5. Wait for the download to complete
6. Restart Giano Reader

### Quick access via Terminal

```bash
# List currently installed voices
say -v '?'
```

> **Note:** macOS offers high-quality "Enhanced" and "Premium" voices for many languages. These sound significantly better than the default compact voices.

---

## Linux

Linux TTS voice availability depends on your distribution and installed speech synthesis engine.

### Using espeak-ng (most common)

```bash
# Debian/Ubuntu
sudo apt install espeak-ng

# Fedora
sudo dnf install espeak-ng

# Arch
sudo pacman -S espeak-ng
```

espeak-ng supports 100+ languages out of the box. Voices are lightweight but robotic-sounding.

### Using speech-dispatcher + festival/flite

```bash
# Debian/Ubuntu
sudo apt install speech-dispatcher festival festvox-us-slt-hts

# For additional languages
sudo apt install festvox-italp16k festvox-kallpc16k
```

### Using piper (high-quality neural voices)

[Piper](https://github.com/rhasspy/piper) provides high-quality neural TTS voices for many languages. It integrates with speech-dispatcher:

```bash
# Install piper
pip install piper-tts

# Download a voice (example: Italian)
piper --model it_IT-riccardo-x_low --download-dir ~/.local/share/piper
```

> **Note:** Linux WebView (WebKitGTK) may have limited speechSynthesis support. If voices don't appear, ensure `speech-dispatcher` is running and configured.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No voices appear after installation | Restart Giano Reader (or your browser). Some systems require a reboot. |
| Voice sounds wrong for the language | Check that the correct voice is selected in the Voice dropdown. |
| Only English voices available | Install the language pack for your target language (see OS-specific instructions above). |
| Voices load slowly on first use | This is normal on Chrome/Edge — voices are loaded asynchronously. Wait a few seconds and try again. |

---

## Supported Languages

Giano Reader supports TTS for all languages with available system voices:

| Language | BCP-47 Code | Windows | macOS | Linux (espeak) |
|----------|-------------|---------|-------|----------------|
| Italian | it-IT | ✅ | ✅ | ✅ |
| English | en-US | ✅ | ✅ | ✅ |
| French | fr-FR | ✅ | ✅ | ✅ |
| German | de-DE | ✅ | ✅ | ✅ |
| Spanish | es-ES | ✅ | ✅ | ✅ |
| Portuguese | pt-PT | ✅ | ✅ | ✅ |
| Russian | ru-RU | ✅ | ✅ | ✅ |
| Chinese | zh-CN | ✅ | ✅ | ✅ |
| Japanese | ja-JP | ✅ | ✅ | ✅ |
| Arabic | ar-SA | ✅ | ✅ | ✅ |
| Filipino | fil-PH | ⚠️ | ⚠️ | ✅ |
| Albanian | sq-AL | ⚠️ | ⚠️ | ✅ |
| Hindi | hi-IN | ✅ | ✅ | ✅ |
| Korean | ko-KR | ✅ | ✅ | ✅ |
| Thai | th-TH | ✅ | ✅ | ✅ |
| Bengali | bn-BD | ⚠️ | ⚠️ | ✅ |
| Indonesian | id-ID | ✅ | ✅ | ✅ |

✅ = Available by default or easily installable  
⚠️ = May require additional language pack installation

---

## Still having issues?

If you've installed voices but they still don't appear in Giano Reader, try using **PRO mode** instead. PRO mode uses cloud-based TTS (via OpenRouter) and doesn't depend on system voices — it works with any language regardless of your OS configuration.
