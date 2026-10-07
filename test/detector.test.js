'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/scan/lib/card-detector.js');
const { FIXTURE, FIXTURE_CORNERS, loadCv, readRgba, applyHomography, maxCornerError } = require('./helpers');

let cv;
let photo;

test.before(async () => {
  cv = await loadCv();
  photo = await readRgba(cv, FIXTURE);
});

function cardDiag(q) {
  return Math.hypot(q[2].x - q[0].x, q[2].y - q[0].y);
}

function expectCorners(result, expected, label) {
  assert.ok(result, `${label}: card not detected`);
  const err = maxCornerError(result.corners, D.orderCorners(expected));
  const tol = cardDiag(D.orderCorners(expected)) * 0.015;
  assert.ok(err <= tol, `${label}: corner error ${err.toFixed(1)}px > ${tol.toFixed(1)}px`);
}

function warpPhoto(H, w, h, border = cv.BORDER_REPLICATE) {
  const out = new cv.Mat();
  cv.warpPerspective(photo, out, H, new cv.Size(w, h), cv.INTER_LINEAR, border, new cv.Scalar(0, 0, 0, 255));
  return out;
}

function homography(from, to) {
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, from.flatMap((p) => [p.x, p.y]));
  const b = cv.matFromArray(4, 1, cv.CV_32FC2, to.flatMap((p) => [p.x, p.y]));
  const H = cv.getPerspectiveTransform(a, b);
  a.delete();
  b.delete();
  return H;
}

test('finds a white card on a white marble surface (reference photo)', () => {
  expectCorners(D.detectCard(cv, photo), FIXTURE_CORNERS, 'reference');
});

test('works from a small live-preview sized frame', () => {
  const small = new cv.Mat();
  cv.resize(photo, small, new cv.Size(360, 480), 0, 0, cv.INTER_AREA);
  const s = 360 / photo.cols;
  const r = D.detectCard(cv, small);
  expectCorners(r, FIXTURE_CORNERS.map((p) => ({ x: p.x * s, y: p.y * s })), 'preview');
  small.delete();
});

test('finds the card when it fills most of the frame (phone held close)', () => {
  const cardW = FIXTURE_CORNERS[1].x - FIXTURE_CORNERS[0].x;
  for (const margin of [0.04, 0.08, 0.15, 0.3]) {
    const x0 = Math.max(0, Math.round(FIXTURE_CORNERS[0].x - cardW * margin));
    const y0 = Math.max(0, Math.round(FIXTURE_CORNERS[1].y - cardW * margin));
    const x1 = Math.min(photo.cols, Math.round(FIXTURE_CORNERS[2].x + cardW * margin));
    const y1 = Math.min(photo.rows, Math.round(FIXTURE_CORNERS[3].y + cardW * margin));
    const view = photo.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const crop = new cv.Mat();
    view.copyTo(crop);
    const expected = FIXTURE_CORNERS.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
    expectCorners(D.detectCard(cv, crop), expected, `margin ${margin}`);
    view.delete();
    crop.delete();
  }
});

test('handles rotation and perspective (tilted phone)', () => {
  const W = photo.cols;
  const Hh = photo.rows;
  const src = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: Hh },
    { x: 0, y: Hh },
  ];
  const cases = {
    rotated: (() => {
      const c = { x: W / 2, y: Hh / 2 };
      const a = (9 * Math.PI) / 180;
      return src.map((p) => ({
        x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
        y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
      }));
    })(),
    keystone: [
      { x: W * 0.08, y: 0 },
      { x: W * 0.92, y: 0 },
      { x: W, y: Hh },
      { x: 0, y: Hh },
    ],
    skewed: [
      { x: 0, y: Hh * 0.05 },
      { x: W, y: 0 },
      { x: W * 0.95, y: Hh },
      { x: W * 0.03, y: Hh * 0.97 },
    ],
  };
  for (const [name, dst] of Object.entries(cases)) {
    const H = homography(src, dst);
    const img = warpPhoto(H, W, Hh);
    const expected = FIXTURE_CORNERS.map((p) => applyHomography(H, p));
    expectCorners(D.detectCard(cv, img), expected, name);
    img.delete();
    H.delete();
  }
});

test('handles a card lying sideways in the frame and warps it to landscape', () => {
  const rotated = new cv.Mat();
  cv.rotate(photo, rotated, cv.ROTATE_90_CLOCKWISE);
  const r = D.detectCard(cv, rotated);
  const H = photo.rows;
  expectCorners(r, FIXTURE_CORNERS.map((p) => ({ x: H - 1 - p.y, y: p.x })), 'sideways');
  const warped = D.warpCard(cv, rotated, r.corners, 1000);
  assert.equal(warped.cols, 1000);
  assert.equal(warped.rows, Math.round(1000 / D.CARD_RATIO));
  warped.delete();
  rotated.delete();
});

test('finds the card on a dark surface', () => {
  // paste the flattened card onto a dark, slightly noisy background
  const card = D.warpCard(cv, photo, FIXTURE_CORNERS, 1200);
  const bg = new cv.Mat(1440, 1080, cv.CV_8UC4);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 12 - 6;
  for (let i = 0; i < bg.data.length; i += 4) {
    const n = rand();
    bg.data[i] = 38 + n;
    bg.data[i + 1] = 36 + n;
    bg.data[i + 2] = 40 + n;
    bg.data[i + 3] = 255;
  }
  const dst = [
    { x: 160, y: 520 },
    { x: 930, y: 470 },
    { x: 960, y: 960 },
    { x: 140, y: 990 },
  ];
  const H = homography(
    [
      { x: 0, y: 0 },
      { x: card.cols, y: 0 },
      { x: card.cols, y: card.rows },
      { x: 0, y: card.rows },
    ],
    dst
  );
  cv.warpPerspective(card, bg, H, new cv.Size(1080, 1440), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT, new cv.Scalar());
  expectCorners(D.detectCard(cv, bg), dst, 'dark surface');
  [card, bg, H].forEach((m) => m.delete());
});

test('reports nothing when no card is in view', () => {
  const empty = photo.roi(new cv.Rect(0, 0, photo.cols, 640));
  const copy = new cv.Mat();
  empty.copyTo(copy);
  assert.equal(D.detectCard(cv, copy), null);
  const blank = new cv.Mat(640, 480, cv.CV_8UC4, new cv.Scalar(200, 200, 200, 255));
  assert.equal(D.detectCard(cv, blank), null);
  [empty, copy, blank].forEach((m) => m.delete());
});

test('rejects a card that is cut off by the frame edge', () => {
  const crop = photo.roi(new cv.Rect(0, 600, 1000, 1000)); // right side of the card is missing
  const copy = new cv.Mat();
  crop.copyTo(copy);
  assert.equal(D.detectCard(cv, copy), null);
  [crop, copy].forEach((m) => m.delete());
});

test('orderCorners returns TL, TR, BR, BL', () => {
  const q = D.orderCorners([
    { x: 10, y: 90 },
    { x: 100, y: 5 },
    { x: 5, y: 8 },
    { x: 95, y: 95 },
  ]);
  assert.deepEqual(q, [
    { x: 5, y: 8 },
    { x: 100, y: 5 },
    { x: 95, y: 95 },
    { x: 10, y: 90 },
  ]);
});
