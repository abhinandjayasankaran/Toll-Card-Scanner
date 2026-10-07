/*
 * Card detector: finds an ID-1 sized card (85.6 x 53.98 mm, e.g. an eToll card)
 * in a camera frame, returns its four corners and can warp it into a flat,
 * deskewed, landscape image.
 *
 * Runs in the browser (window.CardDetector) and in Node (module.exports) so the
 * exact same code is used by the phone scanner and by the automated tests.
 *
 * Detection strategy (all on a downscaled copy of the frame):
 *   1. Build an edge map that also works for white cards on light surfaces:
 *      Canny on a contrast-boosted (CLAHE) grey image OR-ed with Canny on the
 *      Lab "b" (blue/yellow) channel, where a cool-white card separates well
 *      from warm backgrounds.
 *   2. Generate candidate quadrilaterals from three independent sources:
 *        - contours of the edge map,
 *        - Otsu threshold segmentation (great on dark / coloured surfaces),
 *        - pairs of roughly parallel Hough lines (survives gaps in the outline).
 *   3. Score every candidate by how much of each side is backed by edges, how
 *      close its proportions are to a real card and how large it is.
 *   4. Refine the winner by least-squares fitting a line to the edge pixels
 *      along each side and intersecting them (ignores the rounded corners).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardDetector = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CARD_RATIO = 85.6 / 53.98; // ISO/IEC 7810 ID-1

  const DEFAULTS = {
    // Analysis resolutions (longest side, px), tried in order. Faint edges (a
    // white card on a white table) are crisp at these sizes but get lost when
    // the card is analysed at higher resolution, so stay small.
    scales: [400, 320],
    minAreaFrac: 0.06, // card must cover at least this much of the frame
    maxAreaFrac: 0.97,
    ratio: CARD_RATIO,
    ratioTolerance: 0.18, // accepted aspect ratio window (perspective, rounding)
    borderMargin: 0.008, // reject quads touching the frame edge (card cut off)
    minSideSupport: 0.4,
    minMeanSupport: 0.6,
    maxCornerOverrun: 0.55, // reject quads whose sides run on past a corner
  };

  // ---------------------------------------------------------------- geometry

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function polygonArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /** Orders 4 points clockwise (image coords, y down) starting top-left. */
  function orderCorners(pts) {
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const sorted = pts
      .map((p) => ({ x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }))
      .sort((p, q) => p.a - q.a); // clockwise on screen because y points down
    let start = 0;
    let best = Infinity;
    sorted.forEach((p, i) => {
      if (p.x + p.y < best) {
        best = p.x + p.y;
        start = i;
      }
    });
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = sorted[(start + i) % 4];
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-9) return false;
      const s = Math.sign(z);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  function interiorAnglesOk(q, minDeg, maxDeg) {
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4];
      const c = q[i];
      const n = q[(i + 1) % 4];
      const v1x = p.x - c.x;
      const v1y = p.y - c.y;
      const v2x = n.x - c.x;
      const v2y = n.y - c.y;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
      const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      if (deg < minDeg || deg > maxDeg) return false;
    }
    return true;
  }

  /** Long side / short side using the mean of opposite sides. */
  function quadAspect(q) {
    const top = dist(q[0], q[1]);
    const bottom = dist(q[3], q[2]);
    const left = dist(q[0], q[3]);
    const right = dist(q[1], q[2]);
    const w = (top + bottom) / 2;
    const h = (left + right) / 2;
    return { w, h, ratio: Math.max(w, h) / Math.max(1e-6, Math.min(w, h)) };
  }

  /** Line through two points as {px,py,dx,dy} (unit direction). */
  function lineFromPoints(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { px: a.x, py: a.y, dx: dx / len, dy: dy / len };
  }

  function intersect(l1, l2) {
    const det = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(det) < 1e-9) return null;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
    return { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy };
  }

  // ------------------------------------------------------------- edge tools

  /**
   * Fraction of sample points on the segment a->b (t from t0 to t1, may extend
   * beyond the segment) that sit on an edge pixel whose gradient runs across
   * the segment. Requiring the gradient direction to match makes busy card
   * artwork (wavy lines, text) count far less than a genuine straight border.
   */
  function segmentSupport(ctx, a, b, t0, t1) {
    const { edge, grads, w, h } = ctx;
    const len = dist(a, b);
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    const nx = -dy;
    const ny = dx;
    const span = (t1 - t0) * len;
    const n = Math.max(8, Math.round(span / 2));
    let hits = 0;
    for (let k = 0; k <= n; k++) {
      const t = t0 + ((t1 - t0) * k) / n;
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      let hit = false;
      for (let o = -2; o <= 2 && !hit; o++) {
        const x = Math.round(cx + nx * o);
        const y = Math.round(cy + ny * o);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        if (!edge[idx]) continue;
        for (let g = 0; g < grads.length && !hit; g += 2) {
          const gx = grads[g][idx];
          const gy = grads[g + 1][idx];
          const mag = Math.hypot(gx, gy);
          if (mag > 0 && Math.abs(gx * nx + gy * ny) / mag > 0.8) hit = true;
        }
      }
      if (hit) hits++;
    }
    return hits / (n + 1);
  }

  /** Support of each side, skipping the rounded corners. */
  function sideSupport(ctx, q) {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(segmentSupport(ctx, q[i], q[(i + 1) % 4], 0.08, 0.92));
    return out;
  }

  /**
   * A real card border stops at the corners. When a side's edge keeps going
   * straight past a corner, the quad is a rectangle drawn *inside* something
   * bigger (e.g. the flag artwork inside the card) - return the strongest
   * such continuation (0 = all sides stop at the corners).
   */
  function cornerOverrun(ctx, q) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      worst = Math.max(worst, segmentSupport(ctx, a, b, 1.04, 1.16), segmentSupport(ctx, a, b, -0.16, -0.04));
    }
    return worst;
  }

  /**
   * Snap each side onto the actual edge pixels: gather edge pixels within a
   * narrow band around the side, robustly fit a line, then intersect the four
   * lines. Rounded corners are excluded so the result is the true corner.
   */
  function refineQuad(ctx, q, band) {
    const { edge, grads, w, h } = ctx;
    const aligned = (idx, nx, ny) => {
      for (let g = 0; g < grads.length; g += 2) {
        const gx = grads[g][idx];
        const gy = grads[g + 1][idx];
        const mag = Math.hypot(gx, gy);
        if (mag > 0 && Math.abs(gx * nx + gy * ny) / mag > 0.8) return true;
      }
      return false;
    };
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const base = lineFromPoints(a, b);
      const nx = -base.dy;
      const ny = base.dx;
      const len = dist(a, b);
      let pts = [];
      for (let s = len * 0.08; s <= len * 0.92; s += 1) {
        const cx = a.x + base.dx * s;
        const cy = a.y + base.dy * s;
        // closest edge pixel along the normal within the band
        let found = null;
        for (let o = 0; o <= band && !found; o++) {
          for (const sgn of o === 0 ? [1] : [1, -1]) {
            const x = Math.round(cx + nx * o * sgn);
            const y = Math.round(cy + ny * o * sgn);
            if (x >= 0 && y >= 0 && x < w && y < h && edge[y * w + x] && aligned(y * w + x, nx, ny)) {
              found = { x, y };
              break;
            }
          }
        }
        if (found) pts.push(found);
      }
      let line = base;
      if (pts.length >= Math.max(12, len * 0.25)) {
        for (let iter = 0; iter < 3; iter++) {
          const fit = fitLine(pts);
          if (!fit) break;
          line = fit;
          const keep = pts.filter((p) => Math.abs((p.x - fit.px) * -fit.dy + (p.y - fit.py) * fit.dx) <= 1.5);
          if (keep.length < 12 || keep.length === pts.length) break;
          pts = keep;
        }
      }
      lines.push(line);
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4], lines[i]);
      if (!p) return q;
      out.push(p);
    }
    // sanity: refinement must not move corners wildly
    const diag = Math.hypot(w, h);
    for (let i = 0; i < 4; i++) if (dist(out[i], q[i]) > diag * 0.05) return q;
    return isConvex(out) ? out : q;
  }

  /** Total least squares line fit. */
  function fitLine(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x;
      my += p.y;
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
  }

  // ------------------------------------------------------ candidate sources

  function quadsFromContours(cv, binary, minArea, mode, track, out) {
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(binary, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);
    const n = contours.size();
    for (let i = 0; i < n; i++) {
      const c = contours.get(i);
      try {
        if (cv.contourArea(c) < minArea) continue;
        const hull = new cv.Mat();
        try {
          cv.convexHull(c, hull, false, true);
          const peri = cv.arcLength(hull, true);
          for (const eps of [0.02, 0.035, 0.05]) {
            const approx = new cv.Mat();
            try {
              cv.approxPolyDP(hull, approx, eps * peri, true);
              if (approx.rows === 4) {
                const d = approx.data32S;
                out.push([
                  { x: d[0], y: d[1] },
                  { x: d[2], y: d[3] },
                  { x: d[4], y: d[5] },
                  { x: d[6], y: d[7] },
                ]);
                break;
              }
            } finally {
              approx.delete();
            }
          }
        } finally {
          hull.delete();
        }
      } finally {
        c.delete();
      }
    }
  }

  function quadsFromHough(cv, edges, w, h, track, out) {
    const minDim = Math.min(w, h);
    const linesMat = track(new cv.Mat());
    cv.HoughLinesP(edges, linesMat, 1, Math.PI / 180, 28, minDim * 0.12, minDim * 0.04);
    const raw = linesMat.data32S;
    // merge collinear segments into infinite lines (angle, offset)
    const merged = [];
    const segs = [];
    for (let i = 0; i + 3 < raw.length; i += 4) {
      const x1 = raw[i];
      const y1 = raw[i + 1];
      const x2 = raw[i + 2];
      const y2 = raw[i + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      let ang = Math.atan2(y2 - y1, x2 - x1);
      if (ang < 0) ang += Math.PI;
      if (ang >= Math.PI) ang -= Math.PI;
      segs.push({ x1, y1, x2, y2, len, ang });
    }
    segs.sort((a, b) => b.len - a.len);
    const angTol = (4 * Math.PI) / 180;
    for (const s of segs) {
      const nx = -Math.sin(s.ang);
      const ny = Math.cos(s.ang);
      const rho = ((s.x1 + s.x2) / 2) * nx + ((s.y1 + s.y2) / 2) * ny;
      let target = null;
      for (const m of merged) {
        let da = Math.abs(m.ang - s.ang);
        da = Math.min(da, Math.PI - da);
        if (da > angTol) continue;
        // compare offsets in the merged line's frame (handles angle wrap)
        const mrho = ((s.x1 + s.x2) / 2) * m.nx + ((s.y1 + s.y2) / 2) * m.ny;
        if (Math.abs(mrho - m.rho) < 4) {
          target = m;
          break;
        }
      }
      if (target) target.len += s.len;
      else merged.push({ ang: s.ang, nx, ny, rho, len: s.len, px: (s.x1 + s.x2) / 2, py: (s.y1 + s.y2) / 2 });
    }
    merged.sort((a, b) => b.len - a.len);
    const lines = merged.slice(0, 30).map((m) => ({
      ang: m.ang,
      len: m.len,
      line: { px: m.px, py: m.py, dx: Math.cos(m.ang), dy: Math.sin(m.ang) },
      nx: m.nx,
      ny: m.ny,
      rho: m.rho,
    }));
    // pairs of roughly parallel, well separated lines
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i];
        const b = lines[j];
        let da = Math.abs(a.ang - b.ang);
        da = Math.min(da, Math.PI - da);
        if (da > (18 * Math.PI) / 180) continue;
        const sep = Math.abs(b.line.px * a.nx + b.line.py * a.ny - a.rho);
        if (sep < minDim * 0.15) continue;
        let a1 = a.ang;
        let b1 = b.ang;
        if (Math.abs(a1 - b1) > Math.PI / 2) {
          if (a1 < b1) a1 += Math.PI;
          else b1 += Math.PI;
        }
        pairs.push({ a, b, ang: ((a1 + b1) / 2) % Math.PI });
      }
    }
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const p = pairs[i];
        const r = pairs[j];
        let da = Math.abs(p.ang - r.ang);
        da = Math.min(da, Math.PI - da);
        if (da < (62 * Math.PI) / 180) continue; // must be roughly perpendicular
        const c1 = intersect(p.a.line, r.a.line);
        const c2 = intersect(p.a.line, r.b.line);
        const c3 = intersect(p.b.line, r.b.line);
        const c4 = intersect(p.b.line, r.a.line);
        if (!c1 || !c2 || !c3 || !c4) continue;
        out.push([c1, c2, c3, c4]);
      }
    }
  }

  // ------------------------------------------------------------- main entry

  /**
   * Detects the card in an RGBA cv.Mat.
   * Returns { corners:[TL,TR,BR,BL] in source pixels, score, support, areaFrac }
   * or null when no convincing card is visible.
   */
  function detectCard(cv, src, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    for (const maxDim of opts.scales) {
      const r = detectAtScale(cv, src, opts, maxDim);
      if (r) return Object.assign(r, { scale: maxDim });
    }
    return null;
  }

  function detectAtScale(cv, src, opts, maxDim) {
    const mats = [];
    const track = (m) => {
      mats.push(m);
      return m;
    };
    try {
      const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
      const w = Math.round(src.cols * scale);
      const h = Math.round(src.rows * scale);
      const small = track(new cv.Mat());
      if (scale < 1) cv.resize(src, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      else src.copyTo(small);

      const rgb = track(new cv.Mat());
      cv.cvtColor(small, rgb, src.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_RGB2RGB);
      const gray = track(new cv.Mat());
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      const lab = track(new cv.Mat());
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const labCh = track(new cv.MatVector());
      cv.split(lab, labCh);
      const bChan = track(labCh.get(2));

      const ksize = new cv.Size(5, 5);
      // contrast boosted grey edges
      const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
      const grayEq = track(new cv.Mat());
      clahe.apply(gray, grayEq);
      clahe.delete();
      const grayBlur = track(new cv.Mat());
      cv.GaussianBlur(grayEq, grayBlur, ksize, 0);
      const edges = track(new cv.Mat());
      cv.Canny(grayBlur, edges, 30, 90);
      // colour (blue/yellow) edges
      const bBlur = track(new cv.Mat());
      cv.GaussianBlur(bChan, bBlur, ksize, 0);
      const bEdges = track(new cv.Mat());
      cv.Canny(bBlur, bEdges, 8, 24);
      cv.bitwise_or(edges, bEdges, edges);

      const k3 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      const edgesDil = track(new cv.Mat());
      cv.dilate(edges, edgesDil, k3);

      const imgArea = w * h;
      const minArea = imgArea * opts.minAreaFrac;
      const candidates = [];

      // 1) contours of the (closed) edge map
      quadsFromContours(cv, edgesDil, minArea, cv.RETR_LIST, track, candidates);

      // 2) Otsu segmentation of grey and of the colour channel
      const plainBlur = track(new cv.Mat());
      cv.GaussianBlur(gray, plainBlur, ksize, 0);
      const k5 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      for (const chan of [plainBlur, bBlur]) {
        for (const type of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
          const bin = new cv.Mat();
          try {
            cv.threshold(chan, bin, 0, 255, type + cv.THRESH_OTSU);
            cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k5);
            cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k5);
            quadsFromContours(cv, bin, minArea, cv.RETR_EXTERNAL, track, candidates);
          } finally {
            bin.delete();
          }
        }
      }

      // 3) Hough line rectangles
      quadsFromHough(cv, edges, w, h, track, candidates);

      // ---- score candidates
      const gradMats = [];
      for (const img of [grayBlur, bBlur]) {
        const gx = track(new cv.Mat());
        const gy = track(new cv.Mat());
        cv.Sobel(img, gx, cv.CV_16S, 1, 0, 3);
        cv.Sobel(img, gy, cv.CV_16S, 0, 1, 3);
        gradMats.push(gx.data16S, gy.data16S);
      }
      const ctx = { edge: edges.data, grads: gradMats, w, h };
      const margin = Math.max(2, Math.min(w, h) * opts.borderMargin);
      const minRatio = opts.ratio * (1 - opts.ratioTolerance);
      const maxRatio = opts.ratio * (1 + opts.ratioTolerance);
      const evaluate = (q) => {
        if (!isConvex(q)) return null;
        if (q.some((p) => p.x < margin || p.y < margin || p.x > w - 1 - margin || p.y > h - 1 - margin)) return null;
        const areaFrac = polygonArea(q) / imgArea;
        if (areaFrac < opts.minAreaFrac || areaFrac > opts.maxAreaFrac) return null;
        if (!interiorAnglesOk(q, 62, 118)) return null;
        const { ratio } = quadAspect(q);
        if (ratio < minRatio || ratio > maxRatio) return null;
        const sup = sideSupport(ctx, q);
        const minSup = Math.min.apply(null, sup);
        const meanSup = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
        if (minSup < opts.minSideSupport || meanSup < opts.minMeanSupport) return null;
        const ratioFit = 1 - Math.abs(Math.log(ratio / opts.ratio)) / Math.log(1 + opts.ratioTolerance);
        const score = Math.pow(areaFrac, 0.75) * meanSup * meanSup * (0.6 + 0.4 * minSup) * (0.6 + 0.4 * ratioFit);
        return { q, score, support: sup, areaFrac, ratio };
      };

      // cheap pass over every candidate, then refine and re-check the best few
      const seen = new Set();
      const ranked = [];
      for (const raw of candidates) {
        const q = orderCorners(raw);
        const key = q.map((p) => Math.round(p.x / 3) + ',' + Math.round(p.y / 3)).join(';');
        if (seen.has(key)) continue;
        seen.add(key);
        const r = evaluate(q);
        if (r) ranked.push(r);
      }
      ranked.sort((a, b) => b.score - a.score);
      let best = null;
      for (const cand of ranked.slice(0, 6)) {
        const refinedQ = orderCorners(refineQuad(ctx, cand.q, 4));
        const r = evaluate(refinedQ) || cand;
        const overrun = cornerOverrun(ctx, r.q);
        if (overrun > opts.maxCornerOverrun) continue;
        r.score *= 1 - overrun;
        r.overrun = overrun;
        if (!best || r.score > best.score) best = r;
      }
      if (!best) return null;

      const inv = 1 / scale;
      const corners = best.q.map((p) => ({ x: (p.x + 0.5) * inv - 0.5, y: (p.y + 0.5) * inv - 0.5 }));
      return {
        corners,
        score: best.score,
        support: best.support,
        overrun: best.overrun,
        areaFrac: best.areaFrac,
        ratio: quadAspect(corners).ratio,
        candidates: candidates.length,
      };
    } finally {
      for (const m of mats) {
        try {
          m.delete();
        } catch (e) {
          /* already freed */
        }
      }
    }
  }

  /**
   * Perspective-corrects the card into a landscape RGBA cv.Mat of
   * outWidth x outWidth/CARD_RATIO. The caller owns (and must delete) it.
   */
  function warpCard(cv, src, corners, outWidth) {
    const W = Math.round(outWidth || 1600);
    const H = Math.round(W / CARD_RATIO);
    let q = orderCorners(corners);
    const { w, h } = quadAspect(q);
    // card is standing upright in the frame: rotate so its long side is horizontal
    if (h > w) q = [q[3], q[0], q[1], q[2]];
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    srcPts.delete();
    dstPts.delete();
    M.delete();
    return out;
  }

  /** Mean corner movement between two quads, relative to the quad size. */
  function quadDelta(a, b) {
    if (!a || !b) return Infinity;
    const size = Math.max(dist(a[0], a[2]), 1);
    let s = 0;
    for (let i = 0; i < 4; i++) s += dist(a[i], b[i]);
    return s / 4 / size;
  }

  return { CARD_RATIO, detectCard, warpCard, orderCorners, quadDelta, polygonArea };
});
