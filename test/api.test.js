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
    for (const url of ['/api/archive', '/api/scans/bulk-delete', '/api/scans/order']) {
      const forged = await fetch(`http://localhost:${port}${url}`, { method: 'POST', body: 'ids=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      assert.equal(forged.status, 403, url);
    }
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

const json = (method, url, body) => req(method, url, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const C = '0005999988887777';
const idOf = (number) => store.list().find((s) => s.number === number).id;
const listNumbers = async () => (await req('GET', '/api/scans')).data.scans.map((s) => [s.position, s.number]);

test('rearranges the list and keeps the order', async () => {
  assert.deepEqual(await listNumbers(), [
    [1, A],
    [2, B],
    [3, C],
  ]);
  // partial list: the scans not mentioned keep their order at the end
  let r = await json('POST', '/api/scans/order', { ids: [idOf(C), idOf(A)] });
  assert.equal(r.status, 200);
  assert.equal(r.data.changed, true);
  assert.deepEqual((await listNumbers()).map((x) => x[1]), [C, A, B]);
  // unknown and repeated ids are ignored
  r = await json('POST', '/api/scans/order', { ids: ['nope', idOf(B), idOf(B), idOf(C)] });
  assert.deepEqual((await listNumbers()).map((x) => x[1]), [B, C, A]);
  r = await json('POST', '/api/scans/order', { ids: [idOf(B), idOf(C), idOf(A)] });
  assert.equal(r.data.changed, false);
  // survives a restart
  const reopened = await new Store(dir).init();
  assert.deepEqual(reopened.list().map((s) => s.number), [B, C, A]);
  // positions are reported with duplicates, e.g. on the phone
  const dup = await upload(800, 'cap-dup-order');
  assert.equal(dup.data.result, 'duplicate');
  assert.equal(dup.data.scan.position, 3);
  for (const bad of [{}, { ids: 'x' }, { ids: [1, 2] }]) assert.equal((await json('POST', '/api/scans/order', bad)).status, 400);
});

test('exports only the selected scans, in list order', async () => {
  const seq = (n) => store.list().find((s) => s.number === n).seq;
  const r = await req('GET', `/api/export.xlsx?seqs=${seq(A)},${seq(C)}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /toll-cards-2-selected-.*\.xlsx/);
  const strings = unzip(r.data)['xl/sharedStrings.xml'].toString();
  assert.ok(strings.includes(`<t>${A}</t>`) && strings.includes(`<t>${C}</t>`));
  assert.ok(!strings.includes(`<t>${B}</t>`), 'unselected card exported');
  assert.ok(strings.indexOf(C) < strings.indexOf(A), 'rows must follow the list order (C before A)');

  const z = await req('GET', '/api/export.zip?seqs=1-2');
  assert.equal(z.status, 200);
  assert.deepEqual(Object.keys(unzip(z.data)).sort(), [`${A}.jpg`, `${B}.jpg`].sort());

  assert.equal((await req('GET', '/api/export.xlsx?seqs=99')).status, 404);
  for (const bad of ['abc', '5-1', '1,,2', '0']) assert.equal((await req('GET', `/api/export.zip?seqs=${bad}`)).status, 400, bad);
});

test('hostile export selections are rejected or answered quickly (no server hang)', async () => {
  // numbers beyond 2^53 used to spin forever; huge ranges used to be expanded
  for (const bad of ['9007199254740992', '9007199254740992-9007199254740993', '99999999999999999999', '1-' + '9'.repeat(400)]) {
    assert.equal((await req('GET', `/api/export.xlsx?seqs=${bad}`)).status, 400, bad);
  }
  const huge = Array(1000).fill('1-999999999').join(','); // ~12 KB, under Node's header limit
  const t0 = Date.now();
  const r = await req('GET', `/api/export.zip?seqs=${huge}`);
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal((await req('GET', `/api/export.zip?seqs=${Array(5001).fill('1').join(',')}`)).status, 400);
  assert.equal((await req('GET', '/api/ping')).status, 200);
});

test('a number clash names the other card by its list position', async () => {
  const x = await upload(860, 'cap-clash');
  const at = store.positionOf(idOf(C));
  const r = await json('PATCH', `/api/scans/${x.data.scan.id}`, { number: C });
  assert.equal(r.status, 409);
  assert.match(r.data.error, new RegExp(`No\\. ${at}\\)`));
  assert.equal(r.data.clashId, idOf(C));
  await json('POST', '/api/scans/bulk-delete', { ids: [x.data.scan.id] });
});

test('deletes several scans at once', async () => {
  const x = await upload(860, 'cap-bulk-1');
  const y = await upload(880, 'cap-bulk-2');
  assert.equal(store.list().length, 5);
  const before = fs.readdirSync(path.join(dir, 'trash')).length;
  const r = await json('POST', '/api/scans/bulk-delete', { ids: [x.data.scan.id, y.data.scan.id, 'nope'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.deleted, 2);
  assert.deepEqual(r.data.missing, ['nope']);
  assert.equal(r.data.stats.total, 3);
  assert.equal(fs.readdirSync(path.join(dir, 'trash')).length, before + 2);
  assert.deepEqual((await listNumbers()).map((p) => p[0]), [1, 2, 3]);
  assert.equal((await json('POST', '/api/scans/bulk-delete', { ids: 'all' })).status, 400);
  assert.equal((await req('DELETE', '/api/scans/nope')).status, 404);
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
