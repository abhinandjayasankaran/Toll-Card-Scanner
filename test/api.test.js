'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const sharp = require('sharp');
const { Store } = require('../server/store');
const { createApp } = require('../server/app');

const TOKEN = 'test-token-0123456789abcdef';
const A = '0005111122223333';
const B = '0005123456789012';

// OCR stub: the width of the uploaded test image selects a canned OCR result.
const results = new Map();
const fakeOcr = {
  async readCardNumber(buf) {
    const { width } = await sharp(buf).metadata();
    return results.get(width) || { number: null, confidence: 0, rotated: false, needsReview: true, method: 'none', text: '' };
  },
};

async function card(width) {
  return sharp({ create: { width, height: Math.round(width / 1.586), channels: 3, background: '#e8eaf2' } })
    .jpeg()
    .toBuffer();
}

/** Minimal ZIP reader (central directory) - enough to inspect our exports. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

let dir;
let store;
let server;
let base;

async function req(method, url, { body, headers, token = TOKEN } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['X-Access-Token'] = token;
  const res = await fetch(base + url, { method, body, headers: h });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

const upload = async (width, captureId) =>
  req('POST', '/api/scans', { body: await card(width), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Id': captureId || String(Math.random()) } });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcs-test-'));
  store = await new Store(dir).init();
  const app = createApp({ store, ocr: fakeOcr, token: TOKEN, caDer: Buffer.from('CA'), trustLoopback: false });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  results.set(800, { number: A, confidence: 92, rotated: false, needsReview: false, method: 'line', text: '0005 1111 2222 3333' });
  results.set(820, { number: B, confidence: 90, rotated: true, needsReview: false, method: 'line', text: '0005 1234 5678 9012' });
});

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API requires the pairing token (except ping and the certificate)', async () => {
  assert.equal((await req('GET', '/api/scans', { token: null })).status, 401);
  assert.equal((await req('GET', '/api/scans', { token: 'wrong' })).status, 401);
  assert.equal((await req('GET', '/api/scans')).status, 200);
  assert.equal((await req('GET', '/api/ping', { token: null })).status, 200);
  const ca = await req('GET', '/ca.crt', { token: null });
  assert.equal(ca.status, 200);
  assert.equal(ca.headers.get('content-type'), 'application/x-x509-ca-cert');
});

test('the Mac itself needs no token, but forged cross-site requests are refused', async () => {
  const local = http.createServer(createApp({ store, ocr: fakeOcr, token: TOKEN }));
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const port = local.address().port;
  try {
    assert.equal((await fetch(`http://localhost:${port}/api/scans`)).status, 200);
    // DNS rebinding: right address, foreign host name
    const rebound = await new Promise((resolve) =>
      http.get({ host: '127.0.0.1', port, path: '/api/scans', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode))
    );
    assert.equal(rebound, 401);
    // a plain form-style POST (no custom header) is rejected
    assert.equal((await fetch(`http://localhost:${port}/api/archive`, { method: 'POST' })).status, 403);
  } finally {
    local.closeAllConnections();
    local.close();
  }
});

test('a valid token in the URL sets a cookie for images and live events', async () => {
  const res = await fetch(`${base}/api/pair?k=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /tcs_token=.*HttpOnly/);
});

test('saves a scan as <card number>.jpg with a thumbnail', async () => {
  const r = await upload(800, 'cap-1');
  assert.equal(r.status, 200);
  assert.equal(r.data.result, 'saved');
  assert.equal(r.data.scan.number, A);
  assert.equal(r.data.scan.file, `${A}.jpg`);
  assert.ok(fs.existsSync(path.join(dir, 'images', `${A}.jpg`)));
  assert.ok(fs.existsSync(path.join(dir, 'thumbs', r.data.scan.thumb)));
  const img = await req('GET', r.data.scan.imageUrl);
  assert.equal(img.status, 200);
});

test('retrying the same capture does not create a second scan', async () => {
  const r = await upload(800, 'cap-1');
  assert.equal(r.data.result, 'saved');
  assert.equal(store.list().length, 1);
});

test('skips a card that was already scanned', async () => {
  const r = await upload(800, 'cap-2');
  assert.equal(r.data.result, 'duplicate');
  assert.equal(r.data.scan.seq, 1);
  assert.equal(store.list().length, 1);
});

test('turns an upside-down card the right way before saving', async () => {
  const r = await upload(820, 'cap-3');
  assert.equal(r.data.result, 'saved');
  assert.equal(r.data.scan.file, `${B}.jpg`);
});

test('keeps unreadable cards for review and renames them once the number is typed in', async () => {
  const r = await upload(840, 'cap-4');
  assert.equal(r.data.result, 'review');
  assert.equal(r.data.scan.number, null);
  assert.equal(r.data.scan.file, 'UNREAD-0003.jpg');
  const id = r.data.scan.id;

  const bad = await req('PATCH', `/api/scans/${id}`, { body: JSON.stringify({ number: '1234' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  const clash = await req('PATCH', `/api/scans/${id}`, { body: JSON.stringify({ number: A }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(clash.status, 409);

  const ok = await req('PATCH', `/api/scans/${id}`, { body: JSON.stringify({ number: '0005 9999 8888 7777' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.scan.file, '0005999988887777.jpg');
  assert.equal(ok.data.scan.needsReview, false);
  assert.ok(fs.existsSync(path.join(dir, 'images', '0005999988887777.jpg')));
  assert.ok(!fs.existsSync(path.join(dir, 'images', 'UNREAD-0003.jpg')));
});

test('exports an Excel file with the card numbers as text', async () => {
  const r = await req('GET', '/api/export.xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /toll-cards-.*\.xlsx/);
  const files = unzip(r.data);
  const strings = files['xl/sharedStrings.xml'].toString();
  for (const n of [A, B, '0005999988887777']) {
    assert.ok(strings.includes(`<t>${n}</t>`), `${n} missing from workbook`);
  }
  assert.ok(strings.includes('<t>Card Number</t>'));
});

test('downloads all images as a ZIP named by card number', async () => {
  const r = await req('GET', '/api/export.zip');
  assert.equal(r.status, 200);
  const names = Object.keys(unzip(r.data)).sort();
  assert.deepEqual(names, [`${A}.jpg`, `${B}.jpg`, '0005999988887777.jpg'].sort());
});

test('deletes to the trash folder and archives a batch', async () => {
  const victim = store.list().find((s) => s.number === B);
  assert.equal((await req('DELETE', `/api/scans/${victim.id}`)).status, 200);
  assert.ok(fs.readdirSync(path.join(dir, 'trash')).some((f) => f.endsWith(`${B}.jpg`)));
  assert.equal(store.list().length, 2);

  const arch = await req('POST', '/api/archive');
  assert.equal(arch.data.count, 2);
  assert.equal(store.list().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(arch.data.folder, 'images')).sort(), [`${A}.jpg`, '0005999988887777.jpg']);
  const after = await upload(800, 'cap-5');
  assert.equal(after.data.result, 'saved');
  assert.equal(after.data.scan.seq, 1);
});
