'use strict';
/*
 * iPhone Safari only gives web pages camera access over HTTPS, and only
 * installs a PWA with a working service worker when that certificate is
 * trusted. We therefore create a tiny local certificate authority (once) and a
 * server certificate for this Mac's current addresses (re-issued whenever they
 * change). The CA certificate is offered at /ca.crt so it can be installed and
 * trusted on the phone - the same approach as the popular `mkcert` tool.
 */
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
require('reflect-metadata'); // needed by @peculiar/x509
const x509 = require('@peculiar/x509');

x509.cryptoProvider.set(webcrypto);

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
const DAY = 24 * 60 * 60 * 1000;

function toPem(der, label) {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64.trim()}\n-----END ${label}-----\n`;
}

function fromPem(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

function serial() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  bytes[0] &= 0x7f; // keep it positive
  return Buffer.from(bytes).toString('hex');
}

async function exportKey(key) {
  return toPem(await webcrypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

async function importKey(pem) {
  return webcrypto.subtle.importKey('pkcs8', fromPem(pem), ALG, true, ['sign']);
}

function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

async function createCa(dir, label) {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=Toll Card Scanner Local CA (${label}), O=Toll Card Scanner`,
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + 3650 * DAY),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  writePrivate(path.join(dir, 'ca.key'), await exportKey(keys.privateKey));
  fs.writeFileSync(path.join(dir, 'ca.crt'), cert.toString('pem') + '\n');
}

async function createServerCert(dir, names, ips) {
  const ca = new x509.X509Certificate(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'));
  const caKey = await importKey(fs.readFileSync(path.join(dir, 'ca.key'), 'utf8'));
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const now = Date.now();
  const altNames = [...names.map((value) => ({ type: 'dns', value })), ...ips.map((value) => ({ type: 'ip', value }))];
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${names[0] || ips[0]}, O=Toll Card Scanner`,
    issuer: ca.subject,
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + 397 * DAY), // Apple rejects TLS certificates valid for longer
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(altNames),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca),
    ],
  });
  writePrivate(path.join(dir, 'server.key'), await exportKey(keys.privateKey));
  fs.writeFileSync(path.join(dir, 'server.crt'), cert.toString('pem') + '\n');
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ names, ips, notAfter: cert.notAfter }, null, 2));
}

/**
 * Makes sure a CA and a server certificate covering `names`/`ips` exist.
 * Returns { key, cert, caPem, caDer } ready for https.createServer.
 */
async function ensureCertificates(dir, { names, ips, label }) {
  fs.mkdirSync(dir, { recursive: true });
  const caFile = path.join(dir, 'ca.crt');
  if (!fs.existsSync(caFile) || !fs.existsSync(path.join(dir, 'ca.key'))) await createCa(dir, label);

  const wantNames = [...new Set(names.filter(Boolean))];
  const wantIps = [...new Set(ips.filter(Boolean))];
  let reissue = true;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
    const covers = wantNames.every((n) => meta.names.includes(n)) && wantIps.every((i) => meta.ips.includes(i));
    const fresh = new Date(meta.notAfter).getTime() - Date.now() > 30 * DAY;
    reissue = !(covers && fresh && fs.existsSync(path.join(dir, 'server.key')));
  } catch (e) {
    reissue = true;
  }
  if (reissue) await createServerCert(dir, wantNames, wantIps);

  const caPem = fs.readFileSync(caFile, 'utf8');
  return {
    key: fs.readFileSync(path.join(dir, 'server.key'), 'utf8'),
    cert: fs.readFileSync(path.join(dir, 'server.crt'), 'utf8') + caPem,
    caPem,
    caDer: fromPem(caPem),
  };
}

module.exports = { ensureCertificates };
