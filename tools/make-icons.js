/* Regenerates the app icons from assets/icon.svg (large sizes) and assets/icon-small.svg (16-32 px).
   Writes assets/icon-<size>.png and assets/icon.ico (Windows, PNG-compressed entries).
   Needs Playwright (Chromium): node tools/make-icons.js */
const fs = require('fs');
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }

const DIR = path.join(__dirname, '..', 'assets');
const PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 180, 192, 256, 512];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); // palette
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

(async () => {
  const big = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
  const small = fs.readFileSync(path.join(DIR, 'icon-small.svg'), 'utf8');
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const pngs = {};
  for (const size of PNG_SIZES) {
    const svg = size <= 32 ? small : big;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForTimeout(30);
    pngs[size] = await page.screenshot({ omitBackground: true });
    fs.writeFileSync(path.join(DIR, `icon-${size}.png`), pngs[size]);
  }
  await browser.close();
  fs.writeFileSync(path.join(DIR, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, data: pngs[size] }))));
  console.log('wrote', PNG_SIZES.length, 'PNGs and icon.ico to', DIR);
})();
