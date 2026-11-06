// Dev-only: re-render the PNG icons and social card from the SVG sources in assets/icons/ (needs Playwright + Chromium).
// The PNGs are committed and shipped with the CLI, so building a site never needs a rasterizer.
//   node scripts/render-brand.cjs
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(__dirname, "..", "assets", "icons");
const jobs = [
  ["icon.svg", "icon-32.png", 32, 32],
  ["icon.svg", "icon-192.png", 192, 192],
  ["icon.svg", "icon-512.png", 512, 512],
  ["icon-maskable.svg", "icon-maskable-512.png", 512, 512],
  ["icon-maskable.svg", "apple-touch-icon.png", 180, 180],
  ["og.svg", "og.png", 1200, 630],
];
(async () => {
  const browser = await chromium.launch();
  for (const [svg, png, w, h] of jobs) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const src = fs.readFileSync(path.join(dir, svg), "utf8");
    await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace("<svg ", `<svg width="${w}" height="${h}" `)}</body></html>`);
    await page.screenshot({ path: path.join(dir, png), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
    console.log(png);
  }
  await browser.close();
})();
