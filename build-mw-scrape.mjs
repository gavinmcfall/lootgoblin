// Reads mw-scrape/designs.json (produced by the Playwright MCP browser dump),
// fetches cover images, normalizes to models.json, packages mw-scrape.zip.

import sharp from 'sharp';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('mw-scrape');
const THUMB_DIR = path.join(OUT_DIR, 'thumbs');
const ZIP_PATH = path.resolve('mw-scrape.zip');

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      Referer: 'https://makerworld.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function saveThumbs(modelId, coverUrl) {
  const buf = await fetchBuffer(coverUrl);
  const wide = path.join(THUMB_DIR, `${modelId}.jpg`);
  const sq = path.join(THUMB_DIR, `${modelId}-sq.jpg`);
  await sharp(buf, { failOn: 'none' }).resize({ width: 800 }).jpeg({ quality: 85 }).toFile(wide);
  await sharp(buf, { failOn: 'none' })
    .resize({ width: 400, height: 400, fit: 'cover' })
    .jpeg({ quality: 85 })
    .toFile(sq);
  return { thumb: path.relative(OUT_DIR, wide), thumbSquare: path.relative(OUT_DIR, sq) };
}

async function main() {
  await fs.mkdir(THUMB_DIR, { recursive: true });

  const rawFile = await fs.readFile(path.join(OUT_DIR, 'designs.json'), 'utf8');
  const rawParsed = JSON.parse(rawFile);
  // The browser_evaluate filename-output shape varies; handle both forms.
  const designs = Array.isArray(rawParsed)
    ? rawParsed
    : rawParsed.result ?? rawParsed;
  if (!Array.isArray(designs)) {
    throw new Error('designs.json did not parse to an array; saw: ' + typeof designs);
  }

  const records = [];
  for (const d of designs) {
    if (d.error) {
      console.error(`✗ ${d.id}: ${d.error}`);
      continue;
    }
    let thumb = null;
    let thumbSquare = null;
    try {
      const t = await saveThumbs(d.modelId, d.coverUrl);
      thumb = t.thumb;
      thumbSquare = t.thumbSquare;
    } catch (err) {
      console.warn(`thumb failed for ${d.modelId}: ${err.message}`);
    }

    // Normalize to the shape the design tool asked for
    records.push({
      modelId: d.modelId,
      url: d.url,
      title: d.title,
      author: d.creator?.name ?? null,
      authorHandle: d.creator?.handle ?? null,
      tags: d.tags,
      description:
        (d.summary || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300),
      stats: {
        downloads: d.stats?.downloads ?? null,
        likes: d.stats?.likes ?? null,
        collects: d.stats?.collects ?? null,
        prints: d.stats?.prints ?? null,
      },
      printTime: null,
      filamentUsed: null,
      uploadedAt: d.createTime
        ? new Date(d.createTime).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      category: (d.categories?.map((c) => c.name) || []).join(' / ') || null,
      coverUrl: d.coverUrl,
      license: d.license,
      instances: d.instances?.map((i) => ({
        id: i.id,
        title: i.title,
        cover: i.cover,
        isDefault: i.isDefault,
        pictures: i.pictures,
      })),
      thumb,
      thumbSquare,
    });

    console.log(
      `   ${d.modelId} · ${d.title?.slice(0, 50)} · tags=${d.tags?.length} · thumb=${!!thumb}`,
    );
  }

  await fs.writeFile(
    path.join(OUT_DIR, 'models.json'),
    JSON.stringify(records, null, 2) + '\n',
  );
  console.log(`wrote ${records.length} records to mw-scrape/models.json`);

  // Optional: remove the intermediate designs.json from the zip
  // (keep on disk as a reference).

  const zip = new AdmZip();
  zip.addLocalFolder(OUT_DIR, 'mw-scrape', (p) => !p.endsWith('designs.json'));
  zip.writeZip(ZIP_PATH);
  const size = (await fs.stat(ZIP_PATH)).size;
  console.log(`wrote ${ZIP_PATH} (${size} bytes)`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
