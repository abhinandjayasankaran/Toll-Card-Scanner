#!/usr/bin/env node
'use strict';
/*
 * Starts the Toll Card Scanner on this Mac:
 *   - portal for the Mac:     http://localhost:8080
 *   - scanner for the iPhone: https://<this-mac>:8443/scan/  (via the QR code)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const QRCode = require('qrcode');
const { Store } = require('./store');
const { createApp } = require('./app');
const { ensureCertificates } = require('./certs');
const { lanAddresses, localHostname } = require('./network');
const ocr = require('./ocr');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const OPEN_BROWSER = process.argv.includes('--open');

function loadToken() {
  const file = path.join(DATA_DIR, 'access-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return t;
  } catch (e) {
    /* create below */
  }
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

/** Listens on `port`, or the next free port if it is taken. */
function listen(server, port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p); // all interfaces, IPv4 + IPv6
    };
    tryPort(port, attempts);
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = await new Store(DATA_DIR).init();
  const token = loadToken();
  const ips = lanAddresses();
  const host = localHostname();
  const tls = await ensureCertificates(path.join(DATA_DIR, 'certs'), {
    names: [host, 'localhost'].filter(Boolean),
    ips: ['127.0.0.1', ...ips],
    label: host || 'this computer',
  });

  const ports = { http: HTTP_PORT, https: HTTPS_PORT };
  const urls = () => {
    const phoneHost = ips[0] || host || 'localhost';
    return {
      portalUrl: `http://localhost:${ports.http}`,
      phoneUrl: `http://${phoneHost}:${ports.http}/phone?k=${token}&s=${ports.https}`,
      scannerUrl: `https://${phoneHost}:${ports.https}/scan/?k=${token}`,
      scannerUrlLocalName: host ? `https://${host}:${ports.https}/scan/?k=${token}` : null,
      certUrl: `http://${phoneHost}:${ports.http}/ca.crt`,
      addresses: ips,
      hostname: host,
      dataDir: DATA_DIR,
    };
  };

  const app = createApp({ store, ocr, token, caDer: tls.caDer, info: urls });
  const httpServer = http.createServer(app);
  const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
  ports.http = await listen(httpServer, HTTP_PORT);
  ports.https = await listen(httpsServer, HTTPS_PORT);

  const u = urls();
  const qr = await QRCode.toString(u.phoneUrl, { type: 'terminal', small: true });
  const line = '─'.repeat(64);
  console.log(`\n${line}\n  Toll Card Scanner is running\n${line}`);
  console.log(`  Portal (open on this Mac):   ${u.portalUrl}`);
  if (ips.length) {
    console.log(`  iPhone: scan this QR code with the Camera app (same Wi-Fi):\n`);
    console.log(qr.replace(/^/gm, '    '));
    console.log(`  or open ${u.phoneUrl}`);
  } else {
    console.log('  ⚠  No Wi-Fi/LAN address found - connect this Mac to the same Wi-Fi as the iPhone and restart.');
  }
  console.log(`\n  Images are saved in: ${path.join(DATA_DIR, 'images')}`);
  console.log(`  Press Ctrl+C to stop.\n${line}\n`);

  ocr.warmUp().catch((err) => console.error('Could not start the OCR engine:', err));

  if (OPEN_BROWSER && process.platform === 'darwin') execFile('open', [u.portalUrl], () => {});

  const stop = () => {
    console.log('\nStopping…');
    app.locals.closeEvents();
    for (const srv of [httpServer, httpsServer]) {
      srv.close();
      srv.closeIdleConnections();
    }
    ocr.shutdown().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
