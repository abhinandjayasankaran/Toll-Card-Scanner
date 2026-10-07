'use strict';
const { ZipArchive } = require('archiver');
const writeExcelFile = require('write-excel-file/node').default || require('write-excel-file/node');

/** Excel has no time zones: shift so the sheet shows this computer's local time. */
function localWallClock(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

/**
 * Excel workbook with one row per card. Card numbers are written as text
 * (format "@") so Excel keeps the leading zeros and all 16 digits - stored as
 * a number it would show 5.0774E+12 and lose precision after 15 digits.
 */
async function buildWorkbook(scans) {
  const header = ['No.', 'Card Number', 'Image File', 'Scanned At'].map((value) => ({ value, fontWeight: 'bold', type: String }));
  const rows = scans
    .filter((s) => s.number)
    .map((s, i) => [
      { value: i + 1, type: Number },
      { value: s.number, type: String, format: '@' },
      { value: s.file, type: String },
      { value: localWallClock(s.createdAt), type: Date, format: 'yyyy-mm-dd hh:mm:ss' },
    ]);
  const columns = [{ width: 6 }, { width: 22 }, { width: 24 }, { width: 20 }];
  return writeExcelFile([header, ...rows], { columns, sheet: 'Toll Cards', stickyRowsCount: 1 }).toBuffer();
}

/** Streams a .zip of the card images (already JPEG, so stored uncompressed). */
function streamZip(scans, imagePath, output, onError) {
  const zip = new ZipArchive({ store: true });
  zip.on('warning', (err) => {
    if (err.code !== 'ENOENT') onError(err);
  });
  zip.on('error', onError);
  zip.pipe(output);
  for (const s of scans) zip.file(imagePath(s), { name: s.file, date: new Date(s.createdAt) });
  return zip.finalize();
}

module.exports = { buildWorkbook, streamZip };
