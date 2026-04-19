// One-off scrape of 10 MakerWorld model pages into ./mw-scrape/
// and packaged at ./mw-scrape.zip. Produced for a design pass.
//
// Usage:
//   node scrape.mjs
//
// Requirements: playwright, sharp, adm-zip (installed at repo root).

import { chromium } from 'playwright';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';

const URLS = [
  'https://makerworld.com/en/models/1274205-h2-series-top-drawers-ams-side-drawers-h2s-h2d-h2c',
  'https://makerworld.com/en/models/1815860-h2-simple-ams-flipper',
  'https://makerworld.com/en/models/1393014-h2d-h2s-h2c-toolbox',
  'https://makerworld.com/en/models/1519084-h2c-h2d-maintenance-drawer-toolbox-nozzle-vortek',
  'https://makerworld.com/en/models/1726458-h2d-h2s-h2c-cutting-module-box',
  'https://makerworld.com/en/models/2184290-bambulab-ams-stackable-drawer-with-plateholder-h2c',
  'https://makerworld.com/en/models/1966291-ams-2-pro-stackable-gridfinity-storage-unit',
  'https://makerworld.com/en/models/1360489-bambu-lab-h2d-h2s-h2c-magnetic-ar-qr-code',
  'https://makerworld.com/en/models/1758168-h2d-h2s-h2c-laser-module-box',
  'https://makerworld.com/en/models/1519437-hkr-h2d-h2s-h2c-build-plate-storage-ams2-ht-mount',
];

const OUT_DIR = path.resolve('mw-scrape');
const THUMB_DIR = path.join(OUT_DIR, 'thumbs');
const ZIP_PATH = path.resolve('mw-scrape.zip');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const errors = [];

function numericIdFromUrl(url) {
  const m = /\/models\/(\d+)-/.exec(url);
  return m ? m[1] : null;
}

function parseIntFlexible(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, '').trim();
  // Handle "1.2k", "3.4m" shorthand
  const shortMatch = /^([\d.]+)\s*([km])$/i.exec(cleaned);
  if (shortMatch) {
    const n = parseFloat(shortMatch[1]);
    const mult = shortMatch[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    return Math.round(n * mult);
  }
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

async function dismissBanners(page) {
  const candidates = [
    'button:has-text("Reject All")',
    'button:has-text("Reject all")',
    'button:has-text("I agree")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Got it")',
    '[aria-label="Close"]',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1500 }).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }
}

async function extractRecord(page, url) {
  const modelId = numericIdFromUrl(url);
  // Extract DOM facts inside the page context for robustness.
  const dom = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const qa = (sel) => [...document.querySelectorAll(sel)];
    const txt = (el) => (el?.textContent || '').trim();

    // Title
    const title = txt(q('h1'));

    // Author — anchor to /en/@handle, typically sits next to the title
    const authorLink =
      q('a[href^="/en/@"]:not([href="/en/@"])') ||
      qa('a[href*="/en/@"]').find((a) => /\/en\/@[^/]+$/.test(a.getAttribute('href') || ''));
    const author = txt(authorLink) || null;
    const handleMatch = authorLink
      ? /\/en\/@([^/?#]+)/.exec(authorLink.getAttribute('href') || '')
      : null;
    const authorHandle = handleMatch ? handleMatch[1] : null;

    // Tags — look for small chip-like links referencing search?tag=
    const tagNodes = qa('a[href*="/en/search/models?keyword=tag:"]');
    const tagTexts = tagNodes.map((n) => txt(n)).filter(Boolean);
    // Dedup, keep order
    const tags = [...new Set(tagTexts)];

    // Description — first <p> in a region that looks like model description
    // Fallback: first paragraph inside main
    let description = '';
    const main = q('main') || document.body;
    const paragraphs = [...main.querySelectorAll('p')].map((p) => txt(p)).filter(Boolean);
    for (const p of paragraphs) {
      if (p.length > 20) {
        description = p;
        break;
      }
    }
    if (!description && paragraphs[0]) description = paragraphs[0];
    if (description.length > 300) description = description.slice(0, 297) + '…';

    // Stats — MakerWorld uses icons next to counts. Use labels + regex on nearby DOM.
    // Best-effort: look for elements with aria-label or title mentioning the metric,
    // otherwise scan for patterns in visible text.
    function pickStat(...keywords) {
      // Look for elements with aria-label or data attributes referencing the stat
      for (const kw of keywords) {
        const re = new RegExp(kw, 'i');
        const labeled = qa(`[aria-label*="${kw}" i], [title*="${kw}" i]`);
        for (const el of labeled) {
          const maybe = txt(el).match(/[\d,.]+[km]?/i);
          if (maybe) return maybe[0];
        }
      }
      return null;
    }

    const stats = {
      downloads: pickStat('download'),
      likes: pickStat('like'),
      collects: pickStat('collect', 'save'),
      prints: pickStat('print'),
    };

    // Print time / filament
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
    const printTimeMatch = /(\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:in)?|\d+:\d{2}:\d{2})/i.exec(
      bodyText,
    );
    const printTime = printTimeMatch ? printTimeMatch[1] : null;

    const filamentMatch = /(\d{1,5}(?:\.\d+)?)\s*g(?:rams?)?\b/i.exec(bodyText);
    const filamentUsed = filamentMatch ? parseFloat(filamentMatch[1]) : null;

    // Upload date — look for <time> element or patterns like "Published on 2024-03-15"
    let uploadedAt = null;
    const timeEl = q('time[datetime]');
    if (timeEl) uploadedAt = timeEl.getAttribute('datetime');
    if (!uploadedAt) {
      const dateMatch = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(bodyText);
      if (dateMatch) uploadedAt = dateMatch[0];
    }

    // Category — breadcrumb links, not tag links
    const crumbLinks = qa('a[href^="/en/3d-models/"]');
    const categories = crumbLinks.map((a) => txt(a)).filter(Boolean);
    const category = categories.join(' / ') || null;

    // Cover image — __NEXT_DATA__ has it reliably; else largest visible img
    let coverUrl = null;
    try {
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) {
        const data = JSON.parse(nd.textContent || '{}');
        coverUrl = data?.props?.pageProps?.design?.coverUrl || null;
      }
    } catch {
      /* ignore */
    }
    if (!coverUrl) {
      const imgs = qa('img').filter((img) => /^https?:/.test(img.src || ''));
      imgs.sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
      coverUrl = imgs[0]?.src || null;
    }

    return {
      title,
      author,
      authorHandle,
      tags,
      description,
      stats,
      printTime,
      filamentUsed,
      uploadedAt,
      category,
      coverUrl,
    };
  });

  // Clean up stats: parse to ints
  const stats = {
    downloads: parseIntFlexible(dom.stats.downloads),
    likes: parseIntFlexible(dom.stats.likes),
    collects: parseIntFlexible(dom.stats.collects),
    prints: parseIntFlexible(dom.stats.prints),
  };

  const uploadedAt = dom.uploadedAt || new Date().toISOString().slice(0, 10);

  return {
    modelId,
    url,
    title: dom.title,
    author: dom.author,
    authorHandle: dom.authorHandle,
    tags: dom.tags,
    description: dom.description,
    stats,
    printTime: dom.printTime,
    filamentUsed: dom.filamentUsed,
    uploadedAt,
    category: dom.category,
    coverUrl: dom.coverUrl,
  };
}

async function saveThumbs(modelId, coverUrl) {
  if (!coverUrl || !modelId) return { thumb: null, thumbSquare: null };
  const res = await fetch(coverUrl);
  if (!res.ok) throw new Error(`thumb fetch ${coverUrl} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wide = path.join(THUMB_DIR, `${modelId}.jpg`);
  const sq = path.join(THUMB_DIR, `${modelId}-sq.jpg`);
  await sharp(buf).resize({ width: 800 }).jpeg({ quality: 85 }).toFile(wide);
  await sharp(buf)
    .resize({ width: 400, height: 400, fit: 'cover' })
    .jpeg({ quality: 85 })
    .toFile(sq);
  return {
    thumb: path.relative(OUT_DIR, wide),
    thumbSquare: path.relative(OUT_DIR, sq),
  };
}

async function scrapeOne(context, url, attempt = 1) {
  const page = await context.newPage();
  try {
    // networkidle never fires on MakerWorld (constant analytics chatter), so
    // wait for the DOM instead and gate the real extraction on the h1.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissBanners(page);
    await page.waitForSelector('h1', { timeout: 30_000 });
    // Let late-loaded imagery + __NEXT_DATA__ settle.
    await page.waitForTimeout(2500);
    const record = await extractRecord(page, url);
    // Thumbs are best-effort — sharp may reject some MakerWorld CDN formats
    // (AVIF, etc.). Failure here must NOT trigger a URL-level retry of the
    // (already-successful) metadata extraction.
    let thumb = null;
    let thumbSquare = null;
    try {
      const saved = await saveThumbs(record.modelId, record.coverUrl);
      thumb = saved.thumb;
      thumbSquare = saved.thumbSquare;
    } catch (thumbErr) {
      console.warn(
        `   thumb failed for ${record.modelId}: ${(thumbErr).message}`,
      );
    }
    return { ...record, thumb, thumbSquare };
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[retry ${attempt}] ${url}: ${err.message}`);
      await page.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return scrapeOne(context, url, attempt + 1);
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  await fs.mkdir(THUMB_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Pacific/Auckland',
  });

  const records = [];
  for (const url of URLS) {
    try {
      console.log(`→ ${url}`);
      const rec = await scrapeOne(context, url);
      console.log(
        `   ${rec.modelId} · ${rec.title || '(no title)'} · ${rec.tags?.length ?? 0} tags · thumb=${!!rec.thumb}`,
      );
      records.push(rec);
    } catch (err) {
      console.error(`✗ ${url}: ${err.message}`);
      errors.push({ url, error: err.message });
    }
  }

  await browser.close();

  // Write manifest
  await fs.writeFile(path.join(OUT_DIR, 'models.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(`\nwrote ${records.length} records to mw-scrape/models.json`);

  // Zip the folder
  const zip = new AdmZip();
  zip.addLocalFolder(OUT_DIR, 'mw-scrape');
  zip.writeZip(ZIP_PATH);
  console.log(`wrote ${ZIP_PATH} (${(await fs.stat(ZIP_PATH)).size} bytes)`);

  if (errors.length > 0) {
    console.error('\nerrors:');
    for (const e of errors) console.error(`  ✗ ${e.url} — ${e.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
