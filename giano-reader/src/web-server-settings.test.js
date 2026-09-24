import { describe, it, expect, beforeEach } from 'vitest';

describe('Web Server Settings URL & QR Switching', () => {
  let webServerToggle;
  let webServerPort;
  let webServerError;
  let webServerInfo;
  let webServerUrlToggle;
  let webServerUrl;
  let webServerQr;
  let webServerWarning;

  let currentServerInfo = null;

  function renderServerUrlAndQr() {
    if (!currentServerInfo) return;
    const showIp = webServerUrlToggle ? webServerUrlToggle.checked : false;
    const hostnameUrl = currentServerInfo.hostname_url;
    const lanUrl = currentServerInfo.lan_url || `http://127.0.0.1:${currentServerInfo.port}`;

    const url = (showIp || !hostnameUrl) ? lanUrl : hostnameUrl;

    if (webServerUrl) {
      webServerUrl.textContent = url;
      webServerUrl.href = url;
    }
    if (webServerQr) {
      const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(url)}&size=150x150`;
      webServerQr.src = qrSrc;
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
      if (webServerUrlToggle) {
        webServerUrlToggle.checked = false; // default to PC name URL when enabled
        if (!info.hostname_url) {
          webServerUrlToggle.disabled = true;
          webServerUrlToggle.title = 'Hostname not available';
        } else {
          webServerUrlToggle.disabled = false;
          webServerUrlToggle.title = 'Switch between PC Name and IP';
        }
      }
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
    webServerError = document.createElement('p');
    webServerInfo = document.createElement('div');
    webServerUrlToggle = document.createElement('input');
    webServerUrlToggle.type = 'checkbox';
    webServerUrl = document.createElement('a');
    webServerQr = document.createElement('img');
    webServerWarning = document.createElement('p');
    webServerWarning.classList.add('hidden');

    webServerUrlToggle.addEventListener('change', () => {
      renderServerUrlAndQr();
    });
  });

  it('displays PC name URL, sets href, and matching QR code by default when server is enabled', () => {
    const info = {
      port: 8888,
      lan_url: 'http://192.168.1.190:8888',
      hostname_url: 'http://granfico.local:8888/',
      qr_url: 'http://granfico.local:8888/'
    };

    updateWebServerUI(true, info);

    expect(webServerUrlToggle.checked).toBe(false);
    expect(webServerUrl.textContent).toBe('http://granfico.local:8888/');
    expect(webServerUrl.href).toBe('http://granfico.local:8888/');
    expect(webServerQr.src).toContain(encodeURIComponent('http://granfico.local:8888/'));
    expect(webServerQr.alt).toBe('QR: http://granfico.local:8888/');
  });

  it('switches to IP URL and updates QR code when switch is toggled ON', () => {
    const info = {
      port: 8888,
      lan_url: 'http://192.168.1.190:8888',
      hostname_url: 'http://granfico.local:8888/',
      qr_url: 'http://granfico.local:8888/'
    };

    updateWebServerUI(true, info);

    // Toggle switch to IP
    webServerUrlToggle.checked = true;
    webServerUrlToggle.dispatchEvent(new Event('change'));

    expect(webServerUrl.textContent).toBe('http://192.168.1.190:8888');
    expect(webServerQr.src).toContain(encodeURIComponent('http://192.168.1.190:8888'));
    expect(webServerQr.alt).toBe('QR: http://192.168.1.190:8888');

    // Toggle switch back to PC name
    webServerUrlToggle.checked = false;
    webServerUrlToggle.dispatchEvent(new Event('change'));

    expect(webServerUrl.textContent).toBe('http://granfico.local:8888/');
    expect(webServerQr.src).toContain(encodeURIComponent('http://granfico.local:8888/'));
  });

  it('falls back to IP URL and disables switch when hostname_url is not available', () => {
    const info = {
      port: 8888,
      lan_url: 'http://192.168.1.190:8888',
      hostname_url: null,
      qr_url: 'http://192.168.1.190:8888'
    };

    updateWebServerUI(true, info);

    expect(webServerUrlToggle.disabled).toBe(true);
    expect(webServerUrl.textContent).toBe('http://192.168.1.190:8888');
    expect(webServerQr.src).toContain(encodeURIComponent('http://192.168.1.190:8888'));
  });
});
