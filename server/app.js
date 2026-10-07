'use strict';
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { StoreError, stamp } = require('./store');
const { buildWorkbook, streamZip } = require('./exporter');
const { isLoopback } = require('./network');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OPENCV_JS = require.resolve('@techstark/opencv-js/dist/opencv.js');
const COOKIE = 'tcs_token';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_FILE = /^[A-Za-z0-9-]+\.jpg$/;

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * @param {object} deps
 * @param {import('./store').Store} deps.store
 * @param {{readCardNumber: Function}} deps.ocr
 * @param {string} deps.token        pairing secret (the Mac itself never needs it)
 * @param {Buffer} [deps.caDer]      local CA certificate offered to the phone
 * @param {() => object} [deps.info] URLs shown on the portal
 * @param {boolean} [deps.trustLoopback] requests from this computer need no token
 */
function createApp({ store, ocr, token, caDer, info = () => ({}), trustLoopback = true }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // ---------------------------------------------------------------- auth
  const tokenFrom = (req) => req.get('x-access-token') || req.query.k || parseCookies(req.headers.cookie)[COOKIE];
  // The Mac itself needs no token - but only when the page really is
  // http://localhost (a Host check stops DNS-rebinding tricks).
  const hostName = (req) => (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const fromThisMac = (req) => trustLoopback && isLoopback(req.socket.remoteAddress) && LOCAL_HOSTS.has(hostName(req));
  const authorised = (req) => fromThisMac(req) || sameToken(tokenFrom(req), token);

  // Changes must carry a custom header. Browsers refuse to send one cross-site
  // without CORS approval, so other websites cannot forge requests (CSRF).
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.get('x-access-token') || req.get('x-requested-with') === 'toll-card-scanner') return next();
    res.status(403).json({ error: 'Missing request header' });
  });

  // Remember a valid token in a cookie so <img> tags and EventSource work too.
  app.use((req, res, next) => {
    const t = req.get('x-access-token') || req.query.k;
    if (t && sameToken(t, token) && parseCookies(req.headers.cookie)[COOKIE] !== token) {
      const secure = req.secure ? '; Secure' : '';
      res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`);
    }
    next();
  });

  const requireAuth = (req, res, next) => {
    if (authorised(req)) return next();
    res.status(401).json({ error: 'This device is not paired. Scan the QR code shown on the portal again.' });
  };

  // ----------------------------------------------------------- live events
  const clients = new Set();
  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event, data) {
    for (const c of clients) send(c.res, event, data);
  }
  function presence() {
    const scanners = [...clients].filter((c) => c.role === 'scanner').map((c) => c.device || 'Phone');
    return { scanners: scanners.length, devices: scanners };
  }
  const publicScan = (s) => ({
    ...s,
    imageUrl: `/images/${encodeURIComponent(s.file)}?v=${s.version}`,
    thumbUrl: `/thumbs/${encodeURIComponent(s.thumb)}?v=${s.version}`,
  });
  store.on('add', (s) => broadcast('add', { scan: publicScan(s), stats: store.stats() }));
  store.on('update', (s) => broadcast('update', { scan: publicScan(s), stats: store.stats() }));
  store.on('remove', (s) => broadcast('remove', { id: s.id, stats: store.stats() }));
  store.on('reset', () => broadcast('reset', { stats: store.stats() }));
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, 20000);
  heartbeat.unref();

  // ---------------------------------------------------------- public bits
  app.get('/api/ping', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, paired: authorised(req) });
  });

  app.get('/ca.crt', (req, res) => {
    if (!caDer) return res.status(404).end();
    // served inline so iOS Safari offers to install it as a profile
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.send(caDer);
  });

  app.get('/phone', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'phone.html')));

  // The home-screen app keeps its own cookies, so bake the pairing token into
  // its start URL when (and only when) the request proves it knows it.
  app.get('/scan/manifest.webmanifest', (req, res) => {
    const k = sameToken(req.query.k, token) ? `?k=${encodeURIComponent(token)}` : '';
    res.type('application/manifest+json').send(
      JSON.stringify({
        name: 'Toll Card Scanner',
        short_name: 'Card Scan',
        description: 'Scan eToll cards straight into the portal on your Mac.',
        start_url: `/scan/${k}`,
        scope: '/scan/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [
          { src: '/scan/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/scan/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/scan/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      })
    );
  });

  app.get('/scan/vendor/opencv.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    res.sendFile(OPENCV_JS);
  });
  app.use('/scan', express.static(path.join(PUBLIC_DIR, 'scan'), { index: 'index.html', maxAge: 0 }));

  // The portal is for the Mac (or anyone holding the token).
  app.get(['/', '/index.html'], (req, res) => {
    if (!authorised(req)) {
      return res
        .status(401)
        .type('html')
        .send(`<p style="font:16px system-ui;margin:40px">Open the portal on the Mac that runs the scanner: <b>${info().portalUrl || 'http://localhost'}</b>. Scanning on a phone? Use the QR code shown there.</p>`);
    }
    res.sendFile(path.join(PUBLIC_DIR, 'portal', 'index.html'));
  });
  app.use('/portal', express.static(path.join(PUBLIC_DIR, 'portal')));

  // ------------------------------------------------------- authorised API
  app.get('/api/pair', requireAuth, (req, res) => res.json({ ok: true }));

  app.get('/api/info', requireAuth, async (req, res, next) => {
    try {
      const i = info();
      const qrSvg = i.phoneUrl ? await QRCode.toString(i.phoneUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
      res.json({ ...i, qrSvg, stats: store.stats() });
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/events', requireAuth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const client = { res, role: req.query.role === 'scanner' ? 'scanner' : 'portal', device: String(req.query.device || '').slice(0, 40) };
    clients.add(client);
    send(res, 'hello', { stats: store.stats(), presence: presence() });
    if (client.role === 'scanner') broadcast('presence', presence());
    req.on('close', () => {
      clients.delete(client);
      if (client.role === 'scanner') broadcast('presence', presence());
    });
  });

  app.get('/api/scans', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ scans: store.list().map(publicScan), stats: store.stats(), presence: presence() });
  });

  app.post('/api/scans', requireAuth, express.raw({ type: () => true, limit: '20mb' }), async (req, res, next) => {
    try {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length < 1000) throw new StoreError(400, 'No image received');
      const meta = await sharp(buffer)
        .metadata()
        .catch(() => null);
      if (!meta || meta.format !== 'jpeg') throw new StoreError(400, 'Expected a JPEG image');
      const captureId = String(req.get('x-capture-id') || '').slice(0, 80) || null;
      const device = String(req.get('x-device') || '').slice(0, 40) || null;

      const known = captureId && store.list().find((s) => s.captureId === captureId);
      if (known) {
        return res.json({ result: known.number && !known.needsReview ? 'saved' : 'review', scan: publicScan(known), stats: store.stats(), repeated: true });
      }

      let result;
      try {
        result = await ocr.readCardNumber(buffer);
      } catch (err) {
        console.error('OCR failed:', err);
        result = { number: null, confidence: 0, rotated: false, needsReview: true, method: 'error', text: '' };
      }
      const added = await store.add({ buffer, ocr: result, captureId, device });
      if (added.result === 'duplicate') broadcast('duplicate', { number: result.number, scan: publicScan(added.scan), device });
      res.json({ result: added.result, scan: publicScan(added.scan), stats: store.stats() });
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/scans/:id', requireAuth, express.json(), async (req, res, next) => {
    try {
      const scan = await store.setNumber(req.params.id, req.body && req.body.number);
      res.json({ scan: publicScan(scan) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/scans/:id/rotate', requireAuth, async (req, res, next) => {
    try {
      res.json({ scan: publicScan(await store.rotate(req.params.id)) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/scans/:id/reocr', requireAuth, async (req, res, next) => {
    try {
      const scan = store.get(req.params.id);
      if (!scan) throw new StoreError(404, 'Scan not found');
      const result = await ocr.readCardNumber(await fsp.readFile(store.imagePath(scan)));
      const out = await store.applyOcr(scan.id, result);
      res.json({ scan: publicScan(out.scan), note: out.note, read: result.number });
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/scans/:id', requireAuth, async (req, res, next) => {
    try {
      await store.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/archive', requireAuth, async (req, res, next) => {
    try {
      res.json(await store.archiveAll());
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/scans/:id/download', requireAuth, (req, res, next) => {
    const scan = store.get(req.params.id);
    if (!scan) return next(new StoreError(404, 'Scan not found'));
    res.download(store.imagePath(scan), scan.file);
  });

  app.get('/api/export.xlsx', requireAuth, async (req, res, next) => {
    try {
      const buf = await buildWorkbook(store.list());
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="toll-cards-${stamp()}.xlsx"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/export.zip', requireAuth, (req, res) => {
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="toll-card-images-${stamp()}.zip"`);
    streamZip(store.list(), (s) => store.imagePath(s), res, (err) => {
      console.error('ZIP failed:', err);
      res.destroy(err);
    });
  });

  const sendImage = (dirOf) => (req, res, next) => {
    const file = req.params.file;
    if (!SAFE_FILE.test(file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=31536000, immutable'); // URLs carry ?v=version
    res.sendFile(path.join(dirOf(), file), (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 404).end();
    });
  };
  app.get('/images/:file', requireAuth, sendImage(() => store.imagesDir));
  app.get('/thumbs/:file', requireAuth, sendImage(() => store.thumbsDir));

  // ---------------------------------------------------------------- errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the Mac. Check the terminal window.' : err.message, clashId: err.clashId });
  });

  app.locals.closeEvents = () => {
    clearInterval(heartbeat);
    for (const c of clients) c.res.end();
    clients.clear();
  };
  return app;
}

module.exports = { createApp };
