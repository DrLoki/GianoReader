import { describe, it, expect, beforeEach } from 'vitest';
import { qrCodeDataUrl } from './qr-code.js';

// Mirror of renderServerUrlAndQr / updateWebServerUI in main.js (the UI code
// there cannot be imported in tests). The server address is always the LAN IP:
// the "<pc-name>.local" address is no longer offered because Android does not
// resolve it.
describe('Web Server Settings URL & QR', () => {
  let webServerToggle;
  let webServerPort;
  let webServerInfo;
  let webServerUrl;
  let webServerQr;
  let webServerWarning;

  let currentServerInfo = null;

  function renderServerUrlAndQr() {
    if (!currentServerInfo) return;
    const lanUrl = currentServerInfo.lan_url || `http://127.0.0.1:${currentServerInfo.port}`;
    const url = lanUrl;

    if (webServerUrl) {
      webServerUrl.textContent = url;
      webServerUrl.href = url;
    }
    if (webServerQr) {
      webServerQr.src = qrCodeDataUrl(url);
      webServerQr.alt = `QR: ${url}`;
    }

    if (webServerWarning) {
      if (lanUrl.includes('127.0.0.1')) {
        webServerWarning.classList.remove('hidden');
      } else {
        webServerWarning.classList.add('hidden');
      }
    }
  }

  function updateWebServerUI(active, info) {
    if (!webServerToggle) return;
    webServerToggle.checked = active;
    webServerPort.disabled = active;
    currentServerInfo = active ? info : null;

    if (active && info) {
      renderServerUrlAndQr();
      if (webServerInfo) webServerInfo.classList.remove('hidden');
    } else {
      if (webServerInfo) webServerInfo.classList.add('hidden');
      if (webServerWarning) webServerWarning.classList.add('hidden');
    }
  }

  beforeEach(() => {
    webServerToggle = document.createElement('input');
    webServerToggle.type = 'checkbox';
    webServerPort = document.createElement('input');
    webServerInfo = document.createElement('div');
    webServerInfo.classList.add('hidden');
    webServerUrl = document.createElement('a');
    webServerQr = document.createElement('img');
    webServerWarning = document.createElement('p');
    webServerWarning.classList.add('hidden');
  });

  it('shows the LAN IP address as link and QR code when the server is enabled', () => {
    updateWebServerUI(true, {
      port: 8888,
      lan_url: 'http://192.168.1.190:8888',
      qr_url: 'http://192.168.1.190:8888',
    });

    expect(webServerUrl.textContent).toBe('http://192.168.1.190:8888');
    expect(webServerUrl.getAttribute('href')).toBe('http://192.168.1.190:8888');
    // Generated locally: an image data URL, not a request to an external service
    expect(webServerQr.src).toBe(qrCodeDataUrl('http://192.168.1.190:8888'));
    expect(webServerQr.src.startsWith('data:image/')).toBe(true);
    expect(webServerQr.alt).toBe('QR: http://192.168.1.190:8888');
    expect(webServerInfo.classList.contains('hidden')).toBe(false);
    expect(webServerWarning.classList.contains('hidden')).toBe(true);
  });

  it('never shows a .local address', () => {
    updateWebServerUI(true, {
      port: 8888,
      lan_url: 'http://192.168.1.190:8888',
      qr_url: 'http://192.168.1.190:8888',
    });

    expect(webServerUrl.textContent).not.toContain('.local');
    expect(webServerQr.alt).not.toContain('.local');
  });

  it('warns when no LAN address was found', () => {
    updateWebServerUI(true, {
      port: 8888,
      lan_url: 'http://127.0.0.1:8888',
      qr_url: 'http://127.0.0.1:8888',
    });

    expect(webServerWarning.classList.contains('hidden')).toBe(false);
  });

  it('hides the address when the server is stopped', () => {
    updateWebServerUI(true, { port: 8888, lan_url: 'http://192.168.1.190:8888', qr_url: 'http://192.168.1.190:8888' });
    updateWebServerUI(false, null);

    expect(webServerInfo.classList.contains('hidden')).toBe(true);
    expect(webServerToggle.checked).toBe(false);
  });
});
