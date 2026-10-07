'use strict';
/*
 * Reads the 16 digit card number from a flattened (deskewed) card image.
 *
 *  1. Find the printed number line: dark, bold glyphs of the same height sitting
 *     in a row (connected components on an adaptive threshold). This also tells
 *     us whether the card is upside down.
 *  2. Crop just that line and push the light wavy background artwork to white
 *     with a levels adjustment, then OCR it as a single line of digits.
 *  3. Cross-check with a second binarisation; disagreement => flag for review.
 *  4. Fall back to wider OCR passes when the line cannot be located.
 */
const path = require('path');
const sharp = require('sharp');
const { createWorker, PSM } = require('tesseract.js');

const NUMBER_LENGTH = 16;
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

let cvPromise = null;
function getCv() {
  if (!cvPromise) cvPromise = Promise.resolve(require('@techstark/opencv-js'));
  return cvPromise;
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, cacheMethod: 'none', gzip: true }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// tesseract.js runs one job at a time per worker and we change parameters per
// job, so serialise access.
let queue = Promise.resolve();
function withWorker(fn) {
  const run = queue.then(async () => fn(await getWorker()));
  queue = run.catch(() => {});
  return run;
}

async function recognize(png, psm, whitelist) {
  return withWorker(async (worker) => {
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: whitelist,
      user_defined_dpi: '300',
    });
    const { data } = await worker.recognize(png);
    return { text: (data.text || '').trim(), confidence: data.confidence || 0 };
  });
}

/** Extracts a 16 digit number from OCR text (tolerates spaces between groups). */
function parseNumber(text) {
  if (!text) return null;
  for (const line of text.split(/\n+/)) {
    const digits = line.replace(/\D/g, '');
    if (digits.length === NUMBER_LENGTH) return digits;
  }
  const m = text.match(/(\d{4})\D{0,2}(\d{4})\D{0,2}(\d{4})\D{0,2}(\d{4})(?!\d)/);
  return m ? m.slice(1).join('') : null;
}

function matToPng(cv, mat) {
  return sharp(Buffer.from(mat.data), { raw: { width: mat.cols, height: mat.rows, channels: mat.channels() } })
    .png()
    .toBuffer();
}

function copyRoi(cv, mat, rect) {
  const view = mat.roi(rect);
  const out = new cv.Mat();
  view.copyTo(out); // ROI views are not continuous; copy before touching .data
  view.delete();
  return out;
}

/**
 * Finds the row of digit-like glyphs in the lower half of a grey card image.
 * Returns { rect, count, glyphHeight } or null.
 */
function locateNumberLine(cv, gray) {
  const W = gray.cols;
  const H = gray.rows;
  const top = Math.round(H * 0.45);
  const band = copyRoi(cv, gray, new cv.Rect(0, top, W, H - top));
  const bin = new cv.Mat();
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const cents = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  try {
    const block = Math.round(H * 0.08) | 1;
    cv.adaptiveThreshold(band, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 15);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel); // drops hairline artwork
    const n = cv.connectedComponentsWithStats(bin, labels, stats, cents, 8, cv.CV_32S);
    const S = stats.data32S;
    const glyphs = [];
    for (let i = 1; i < n; i++) {
      const x = S[i * 5];
      const y = S[i * 5 + 1];
      const w = S[i * 5 + 2];
      const h = S[i * 5 + 3];
      const area = S[i * 5 + 4];
      if (h < H * 0.028 || h > H * 0.085) continue;
      if (w < h * 0.12 || w > h * 1.1) continue;
      if (area < w * h * 0.15) continue;
      glyphs.push({ x, y: y + top, w, h, cy: y + top + h / 2 });
    }
    glyphs.sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const g of glyphs) {
      let row = rows.find((r) => Math.abs(r.cy - g.cy) < r.h * 0.35 && Math.abs(r.h - g.h) < r.h * 0.3);
      if (!row) {
        row = { cy: g.cy, h: g.h, items: [] };
        rows.push(row);
      }
      row.items.push(g);
      row.cy = row.items.reduce((s, i) => s + i.cy, 0) / row.items.length;
      row.h = row.items.reduce((s, i) => s + i.h, 0) / row.items.length;
    }
    const score = (r) => Math.min(r.items.length, NUMBER_LENGTH) - Math.max(0, r.items.length - NUMBER_LENGTH) * 0.5;
    rows.sort((a, b) => score(b) - score(a));
    const best = rows[0];
    if (!best || best.items.length < 6) return null;
    const x0 = Math.min(...best.items.map((i) => i.x));
    const x1 = Math.max(...best.items.map((i) => i.x + i.w));
    const y0 = Math.min(...best.items.map((i) => i.y));
    const y1 = Math.max(...best.items.map((i) => i.y + i.h));
    const padY = Math.round(best.h * 0.3);
    // glyphs overlapping artwork can be missed, so widen generously sideways
    const ex0 = Math.max(0, Math.round(x0 - best.h * 2));
    const ex1 = Math.min(W - Math.round(W * 0.01), Math.round(x1 + best.h * 3));
    const ey0 = Math.max(0, y0 - padY);
    const ey1 = Math.min(H, y1 + padY);
    return { rect: new cv.Rect(ex0, ey0, ex1 - ex0, ey1 - ey0), count: best.items.length, glyphHeight: best.h };
  } finally {
    [band, bin, labels, stats, cents, kernel].forEach((m) => m.delete());
  }
}

/**
 * Builds two OCR-ready versions of the number line:
 *  - "soft": levels stretched so the dark print stays and lighter artwork goes white
 *  - "hard": the same, binarised
 */
async function lineImages(cv, gray, rect) {
  const line = copyRoi(cv, gray, rect);
  const soft = new cv.Mat(line.rows, line.cols, cv.CV_8UC1);
  const hard = new cv.Mat();
  const padSoft = new cv.Mat();
  const padHard = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
  try {
    const vals = Uint8Array.from(line.data).sort();
    const lo = vals[Math.floor(vals.length * 0.03)];
    const mid = vals[Math.floor(vals.length * 0.5)];
    const cut = lo + 0.45 * Math.max(10, mid - lo);
    const src = line.data;
    const dst = soft.data;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      dst[i] = v >= cut ? 255 : Math.max(0, Math.round(((v - lo) / (cut - lo)) * 200));
    }
    cv.threshold(soft, hard, 254, 255, cv.THRESH_BINARY);
    cv.morphologyEx(hard, hard, cv.MORPH_CLOSE, kernel);
    const pad = Math.round(rect.height * 0.4);
    const white = new cv.Scalar(255);
    cv.copyMakeBorder(soft, padSoft, pad, pad, pad, pad, cv.BORDER_CONSTANT, white);
    cv.copyMakeBorder(hard, padHard, pad, pad, pad, pad, cv.BORDER_CONSTANT, white);
    return { soft: await matToPng(cv, padSoft), hard: await matToPng(cv, padHard) };
  } finally {
    [line, soft, hard, padSoft, padHard, kernel].forEach((m) => m.delete());
  }
}

async function readLine(cv, gray, located) {
  const imgs = await lineImages(cv, gray, located.rect);
  const a = await recognize(imgs.soft, PSM.SINGLE_LINE, '0123456789 ');
  const b = await recognize(imgs.hard, PSM.SINGLE_LINE, '0123456789 ');
  const na = parseNumber(a.text);
  const nb = parseNumber(b.text);
  if (na && nb && na === nb) {
    return { number: na, confidence: Math.max(a.confidence, b.confidence), agree: true, text: a.text };
  }
  const options = [
    { number: na, confidence: a.confidence, text: a.text },
    { number: nb, confidence: b.confidence, text: b.text },
  ].filter((o) => o.number);
  if (options.length) {
    options.sort((x, y) => y.confidence - x.confidence);
    return { ...options[0], agree: false };
  }
  return { number: null, confidence: Math.max(a.confidence, b.confidence), agree: false, text: a.text || b.text };
}

/**
 * @param {Buffer} image JPEG/PNG of the flattened card (landscape)
 * @returns {Promise<{number:string|null, confidence:number, rotated:boolean, needsReview:boolean, method:string, text:string}>}
 */
async function readCardNumber(image) {
  const cv = await getCv();
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = new cv.Mat(info.height, info.width, cv.CV_8UC3);
  rgb.data.set(data);
  const gray = new cv.Mat();
  const flipped = new cv.Mat();
  try {
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.rotate(gray, flipped, cv.ROTATE_180);
    const orientations = [
      { rotated: false, img: gray, located: locateNumberLine(cv, gray) },
      { rotated: true, img: flipped, located: locateNumberLine(cv, flipped) },
    ]
      .filter((o) => o.located)
      .sort((a, b) => b.located.count - a.located.count);

    let partial = null;
    for (const o of orientations) {
      const r = await readLine(cv, o.img, o.located);
      if (r.number) {
        const needsReview = !r.agree && r.confidence < 85;
        return { number: r.number, confidence: Math.round(r.confidence), rotated: o.rotated, needsReview, method: 'line', text: r.text };
      }
      if (!partial) partial = { text: r.text, rotated: o.rotated };
    }

    // Fallbacks: the lower part of the card, then the whole card.
    for (const rotated of [false, true]) {
      const img = rotated ? flipped : gray;
      const strip = copyRoi(cv, img, new cv.Rect(Math.round(img.cols * 0.35), Math.round(img.rows * 0.68), Math.round(img.cols * 0.64), Math.round(img.rows * 0.3)));
      const png = await matToPng(cv, strip);
      strip.delete();
      const r = await recognize(png, PSM.SINGLE_BLOCK, '0123456789 ');
      const number = parseNumber(r.text);
      if (number) return { number, confidence: Math.round(r.confidence), rotated, needsReview: true, method: 'strip', text: r.text };
    }
    for (const rotated of [false, true]) {
      const png = await matToPng(cv, rotated ? flipped : gray);
      const r = await recognize(png, PSM.SPARSE_TEXT, '');
      const number = parseNumber(r.text);
      if (number) return { number, confidence: Math.round(r.confidence), rotated, needsReview: true, method: 'full', text: r.text };
    }
    return {
      number: null,
      confidence: 0,
      rotated: partial ? partial.rotated : false,
      needsReview: true,
      method: 'none',
      text: partial ? partial.text : '',
    };
  } finally {
    [rgb, gray, flipped].forEach((m) => m.delete());
  }
}

/** Starts OpenCV + Tesseract in the background so the first scan is fast. */
function warmUp() {
  return Promise.all([getCv(), getWorker()]);
}

async function shutdown() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }
}

module.exports = { readCardNumber, parseNumber, warmUp, shutdown, NUMBER_LENGTH };
