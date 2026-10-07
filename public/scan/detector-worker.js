/* Runs OpenCV off the main thread so the camera preview stays smooth. */
/* global CardDetector */
'use strict';

self.importScripts('vendor/opencv.js', 'lib/card-detector.js');

let cv = null;
const ready = (async () => {
  let mod = self.cv;
  if (mod && typeof mod.then === 'function') mod = await mod;
  else if (mod && !mod.Mat) await new Promise((resolve) => (mod.onRuntimeInitialized = resolve));
  cv = mod;
  self.postMessage({ type: 'ready' });
})().catch((err) => self.postMessage({ type: 'fatal', message: String((err && err.message) || err) }));

function toMat(width, height, buffer) {
  const mat = new cv.Mat(height, width, cv.CV_8UC4);
  mat.data.set(new Uint8Array(buffer));
  return mat;
}

function detect(msg) {
  const src = toMat(msg.width, msg.height, msg.buffer);
  try {
    const r = CardDetector.detectCard(cv, src);
    return r ? { corners: r.corners, score: r.score, support: r.support } : null;
  } finally {
    src.delete();
  }
}

/**
 * Capture: re-detect on the full-resolution crop around the card for precise corners
 * (falling back to the live-preview corners), then flatten the card.
 */
function capture(msg) {
  const src = toMat(msg.width, msg.height, msg.buffer);
  let warped = null;
  try {
    let corners = msg.hint;
    let refined = false;
    const r = CardDetector.detectCard(cv, src, { minAreaFrac: 0.2 });
    if (r && (!msg.trustHint || CardDetector.quadDelta(CardDetector.orderCorners(msg.hint), r.corners) < 0.12)) {
      corners = r.corners;
      refined = true;
    }
    const found = refined || msg.trustHint;
    warped = CardDetector.warpCard(cv, src, corners, msg.outWidth || 1600);
    const out = new Uint8ClampedArray(warped.data); // copy out of the wasm heap
    return { width: warped.cols, height: warped.rows, buffer: out.buffer, found };
  } finally {
    src.delete();
    if (warped) warped.delete();
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (!cv) return;
    if (msg.type === 'detect') {
      const result = detect(msg);
      self.postMessage({ type: 'detected', id: msg.id, result, width: msg.width, height: msg.height });
    } else if (msg.type === 'capture') {
      const out = capture(msg);
      self.postMessage({ type: 'captured', id: msg.id, ...out }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, kind: msg.type, message: String((err && err.message) || err) });
  }
};
