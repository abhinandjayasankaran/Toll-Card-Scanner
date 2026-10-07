'use strict';
/*
 * Keeps the scanned cards on disk:
 *   data/images/<cardnumber>.jpg      full-size flattened card
 *   data/thumbs/<id>.jpg              small preview for the portal grid
 *   data/scans.json                   metadata (order, OCR results, flags)
 * Deleted scans go to data/trash/, archived batches to data/archive/<stamp>/.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sharp = require('sharp');

const NUMBER_RE = /^\d{16}$/;

class StoreError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.imagesDir = path.join(dataDir, 'images');
    this.thumbsDir = path.join(dataDir, 'thumbs');
    this.trashDir = path.join(dataDir, 'trash');
    this.archiveDir = path.join(dataDir, 'archive');
    this.metaFile = path.join(dataDir, 'scans.json');
    this.scans = [];
    this.nextSeq = 1;
    this.lock = Promise.resolve();
  }

  async init() {
    for (const d of [this.imagesDir, this.thumbsDir, this.trashDir, this.archiveDir]) await fsp.mkdir(d, { recursive: true });
    try {
      const meta = JSON.parse(await fsp.readFile(this.metaFile, 'utf8'));
      this.scans = Array.isArray(meta.scans) ? meta.scans : [];
      this.nextSeq = meta.nextSeq || this.scans.reduce((m, s) => Math.max(m, s.seq + 1), 1);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  /** Runs mutations one at a time so file renames and duplicate checks never race. */
  exclusive(fn) {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async persist() {
    const tmp = `${this.metaFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ nextSeq: this.nextSeq, scans: this.scans }, null, 1));
    await fsp.rename(tmp, this.metaFile);
  }

  list() {
    return this.scans;
  }

  get(id) {
    return this.scans.find((s) => s.id === id) || null;
  }

  findByNumber(number, exceptId) {
    return this.scans.find((s) => s.number === number && s.id !== exceptId) || null;
  }

  stats() {
    const total = this.scans.length;
    const unread = this.scans.filter((s) => !s.number).length;
    const review = this.scans.filter((s) => s.needsReview).length;
    return { total, unread, review, last: total ? this.scans[total - 1].createdAt : null };
  }

  imagePath(scan) {
    return path.join(this.imagesDir, scan.file);
  }

  thumbPath(scan) {
    return path.join(this.thumbsDir, scan.thumb);
  }

  fileNameFor(number, seq) {
    return number ? `${number}.jpg` : `UNREAD-${String(seq).padStart(4, '0')}.jpg`;
  }

  async writeImage(scan, buffer) {
    const img = sharp(buffer);
    const meta = await img.metadata();
    await fsp.writeFile(this.imagePath(scan), buffer);
    await img.resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(this.thumbPath(scan));
    scan.width = meta.width;
    scan.height = meta.height;
    scan.size = buffer.length;
  }

  /**
   * Adds a scan. `ocr` is the result of readCardNumber(); when the card was
   * upside down the image is turned the right way before saving.
   * Returns { result: 'saved' | 'review' | 'duplicate', scan }.
   */
  add({ buffer, ocr, captureId, device }) {
    return this.exclusive(async () => {
      if (captureId) {
        const again = this.scans.find((s) => s.captureId === captureId);
        if (again) return { result: again.number ? 'saved' : 'review', scan: again, repeated: true };
      }
      if (ocr.number) {
        const existing = this.findByNumber(ocr.number);
        if (existing) return { result: 'duplicate', scan: existing };
      }
      const image = ocr.rotated ? await sharp(buffer).rotate(180).jpeg({ quality: 92 }).toBuffer() : buffer;
      const seq = this.nextSeq++;
      const now = new Date().toISOString();
      const scan = {
        id: crypto.randomUUID(),
        seq,
        number: ocr.number || null,
        file: this.fileNameFor(ocr.number, seq),
        thumb: '',
        createdAt: now,
        updatedAt: now,
        needsReview: !ocr.number || !!ocr.needsReview,
        ocr: { text: ocr.text || '', confidence: ocr.confidence || 0, method: ocr.method || '' },
        captureId: captureId || null,
        device: device || null,
        version: 1,
      };
      scan.thumb = `${scan.id}.jpg`;
      await this.writeImage(scan, image);
      this.scans.push(scan);
      await this.persist();
      this.emit('add', scan);
      return { result: scan.number && !scan.needsReview ? 'saved' : 'review', scan };
    });
  }

  /** Sets (or corrects) the card number and renames the image file to match. */
  setNumber(id, rawNumber) {
    return this.exclusive(async () => {
      const scan = this.get(id);
      if (!scan) throw new StoreError(404, 'Scan not found');
      const number = String(rawNumber || '').replace(/\D/g, '');
      if (!NUMBER_RE.test(number)) throw new StoreError(400, 'A card number has exactly 16 digits');
      const clash = this.findByNumber(number, id);
      if (clash) throw new StoreError(409, `Card ${number} is already in the list (scan #${clash.seq})`, { clashId: clash.id });
      const file = this.fileNameFor(number, scan.seq);
      if (file !== scan.file) {
        await fsp.rename(this.imagePath(scan), path.join(this.imagesDir, file));
        scan.file = file;
      }
      scan.number = number;
      scan.needsReview = false;
      scan.updatedAt = new Date().toISOString();
      scan.version++;
      await this.persist();
      this.emit('update', scan);
      return scan;
    });
  }

  /** Turns the stored image 180 degrees (for the rare card OCR saw upside down). */
  rotate(id) {
    return this.exclusive(async () => {
      const scan = this.get(id);
      if (!scan) throw new StoreError(404, 'Scan not found');
      const buffer = await sharp(this.imagePath(scan)).rotate(180).jpeg({ quality: 92 }).toBuffer();
      await this.writeImage(scan, buffer);
      scan.updatedAt = new Date().toISOString();
      scan.version++;
      await this.persist();
      this.emit('update', scan);
      return scan;
    });
  }

  /** Applies a fresh OCR result to an existing scan. */
  applyOcr(id, ocr) {
    return this.exclusive(async () => {
      const scan = this.get(id);
      if (!scan) throw new StoreError(404, 'Scan not found');
      scan.ocr = { text: ocr.text || '', confidence: ocr.confidence || 0, method: ocr.method || '' };
      if (ocr.rotated) {
        const buffer = await sharp(this.imagePath(scan)).rotate(180).jpeg({ quality: 92 }).toBuffer();
        await this.writeImage(scan, buffer);
      }
      let note = null;
      if (ocr.number && ocr.number !== scan.number) {
        const clash = this.findByNumber(ocr.number, id);
        if (clash) note = `Read ${ocr.number}, but that card is already scan #${clash.seq}`;
        else {
          const file = this.fileNameFor(ocr.number, scan.seq);
          await fsp.rename(this.imagePath(scan), path.join(this.imagesDir, file));
          scan.file = file;
          scan.number = ocr.number;
        }
      }
      scan.needsReview = !scan.number || !!ocr.needsReview || !!note || !ocr.number;
      scan.updatedAt = new Date().toISOString();
      scan.version++;
      await this.persist();
      this.emit('update', scan);
      return { scan, note };
    });
  }

  remove(id) {
    return this.exclusive(async () => {
      const idx = this.scans.findIndex((s) => s.id === id);
      if (idx < 0) throw new StoreError(404, 'Scan not found');
      const [scan] = this.scans.splice(idx, 1);
      const dest = path.join(this.trashDir, `${stamp()}-${scan.file}`);
      await fsp.rename(this.imagePath(scan), dest).catch(() => {});
      await fsp.rm(this.thumbPath(scan), { force: true });
      await this.persist();
      this.emit('remove', scan);
      return scan;
    });
  }

  /** Moves the whole batch to data/archive/<timestamp>/ and starts empty. */
  archiveAll() {
    return this.exclusive(async () => {
      const count = this.scans.length;
      if (!count) return { count: 0, folder: null };
      const folder = path.join(this.archiveDir, stamp());
      await fsp.mkdir(folder, { recursive: true });
      await fsp.rename(this.imagesDir, path.join(folder, 'images'));
      await fsp.writeFile(path.join(folder, 'scans.json'), JSON.stringify({ scans: this.scans }, null, 1));
      await fsp.rm(this.thumbsDir, { recursive: true, force: true });
      await fsp.mkdir(this.imagesDir, { recursive: true });
      await fsp.mkdir(this.thumbsDir, { recursive: true });
      this.scans = [];
      this.nextSeq = 1;
      await this.persist();
      this.emit('reset');
      return { count, folder };
    });
  }
}

module.exports = { Store, StoreError, NUMBER_RE, stamp };
