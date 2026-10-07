'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const D = require('../public/scan/lib/card-detector.js');
const ocr = require('../server/ocr');
const { FIXTURE, FIXTURE_NUMBER, loadCv, readRgba, matToJpeg } = require('./helpers');

let flatCard; // JPEG of the deskewed reference card, as the phone would upload it

test.before(async () => {
  const cv = await loadCv();
  const photo = await readRgba(cv, FIXTURE);
  const found = D.detectCard(cv, photo);
  const warped = D.warpCard(cv, photo, found.corners, 1600);
  flatCard = await matToJpeg(cv, warped);
  warped.delete();
  photo.delete();
});

test.after(() => ocr.shutdown());

test('parseNumber accepts grouped and ungrouped numbers', () => {
  assert.equal(ocr.parseNumber('0005 9364 7035 4275'), FIXTURE_NUMBER);
  assert.equal(ocr.parseNumber('0005 9364 70354275\n'), FIXTURE_NUMBER);
  assert.equal(ocr.parseNumber('junk\n0005936470354275'), FIXTURE_NUMBER);
  assert.equal(ocr.parseNumber('0005 9364 7035'), null);
  assert.equal(ocr.parseNumber(''), null);
});

test('reads the card number from the flattened reference card', async () => {
  const r = await ocr.readCardNumber(flatCard);
  assert.equal(r.number, FIXTURE_NUMBER);
  assert.equal(r.rotated, false);
  assert.equal(r.needsReview, false);
});

test('detects an upside-down card and still reads the number', async () => {
  const upsideDown = await sharp(flatCard).rotate(180).jpeg().toBuffer();
  const r = await ocr.readCardNumber(upsideDown);
  assert.equal(r.number, FIXTURE_NUMBER);
  assert.equal(r.rotated, true);
});

test('reads the number from a lower resolution capture', async () => {
  const small = await sharp(flatCard).resize(1000).jpeg({ quality: 85 }).toBuffer();
  const r = await ocr.readCardNumber(small);
  assert.equal(r.number, FIXTURE_NUMBER);
});

test('returns null (needs review) when there is no number', async () => {
  const blank = await sharp({ create: { width: 1600, height: 1009, channels: 3, background: '#f4f4f8' } }).jpeg().toBuffer();
  const r = await ocr.readCardNumber(blank);
  assert.equal(r.number, null);
  assert.equal(r.needsReview, true);
});
