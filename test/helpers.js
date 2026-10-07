'use strict';
const path = require('path');
const sharp = require('sharp');

const FIXTURE = path.join(__dirname, 'fixtures', 'etoll-card-white-bg.jpg');
// Card corners in the fixture photo (TL, TR, BR, BL), measured by hand.
const FIXTURE_CORNERS = [
  { x: 191, y: 746 },
  { x: 1300, y: 744 },
  { x: 1302, y: 1442 },
  { x: 195, y: 1443 },
];
const FIXTURE_NUMBER = '0005936470354275'; // digits edited - not a real card

let cvPromise = null;
function loadCv() {
  if (!cvPromise) cvPromise = Promise.resolve(require('@techstark/opencv-js'));
  return cvPromise;
}

async function readRgba(cv, file) {
  const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC4);
  mat.data.set(data);
  return mat;
}

function matToJpeg(cv, mat, quality = 92) {
  const ch = mat.channels();
  return sharp(Buffer.from(mat.data), { raw: { width: mat.cols, height: mat.rows, channels: ch } })
    .jpeg({ quality })
    .toBuffer();
}

function applyHomography(H, p) {
  const d = H.data64F;
  const w = d[6] * p.x + d[7] * p.y + d[8];
  return { x: (d[0] * p.x + d[1] * p.y + d[2]) / w, y: (d[3] * p.x + d[4] * p.y + d[5]) / w };
}

function maxCornerError(found, expected) {
  // corners are both ordered TL,TR,BR,BL
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(found[i].x - expected[i].x, found[i].y - expected[i].y));
  return worst;
}

module.exports = { FIXTURE, FIXTURE_CORNERS, FIXTURE_NUMBER, loadCv, readRgba, matToJpeg, applyHomography, maxCornerError };
