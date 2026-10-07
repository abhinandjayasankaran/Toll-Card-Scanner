#!/usr/bin/env node
// Regenerates the app icons in public/scan/icons from the SVG below.
'use strict';
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'scan', 'icons');

function svg({ padded }) {
  // padded: extra safe area for "maskable" icons (Android crops to a circle)
  const s = padded ? 0.58 : 0.7;
  const w = 512 * s;
  const h = w / 1.586;
  const x = (512 - w) / 2;
  const y = (512 - h) / 2;
  const b = 34; // bracket length
  const g = 16; // bracket gap from card
  const br = (cx, cy, dx, dy) => `M${cx + dx * b},${cy} H${cx} V${cy + dy * b}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${padded ? 0 : 112}" fill="#0b0f14"/>
  <g transform="rotate(-6 256 256)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#f4f6fb"/>
    <path d="M${x + w * 0.28},${y} L${x + w * 0.4},${y} L${x + w * 0.5},${y + h} L${x + w * 0.2},${y + h} Z" fill="#1f8a3b"/>
    <rect x="${x + w * 0.56}" y="${y + h * 0.16}" width="${w * 0.36}" height="${h * 0.13}" rx="6" fill="#f07c22"/>
    <rect x="${x + w * 0.56}" y="${y + h * 0.74}" width="${w * 0.38}" height="${h * 0.09}" rx="5" fill="#1c232c"/>
  </g>
  <g fill="none" stroke="#22c55e" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
    <path d="${br(x - g, y - g - 8, 1, 1)}"/>
    <path d="${br(x + w + g, y - g - 8, -1, 1)}"/>
    <path d="${br(x + w + g, y + h + g + 8, -1, -1)}"/>
    <path d="${br(x - g, y + h + g + 8, 1, -1)}"/>
  </g>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const normal = Buffer.from(svg({ padded: false }));
  const maskable = Buffer.from(svg({ padded: true }));
  await sharp(normal).resize(192).png().toFile(path.join(OUT, 'icon-192.png'));
  await sharp(normal).resize(512).png().toFile(path.join(OUT, 'icon-512.png'));
  await sharp(maskable).resize(512).png().toFile(path.join(OUT, 'icon-maskable-512.png'));
  // iOS adds its own rounded corners: use the full-bleed variant
  await sharp(Buffer.from(svg({ padded: false }).replace('rx="112"', 'rx="0"')))
    .resize(180)
    .png()
    .toFile(path.join(OUT, 'apple-touch-icon.png'));
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'portal', 'favicon.svg'), svg({ padded: false }));
  console.log('icons written to', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
