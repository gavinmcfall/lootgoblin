import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import { getDb, schema } from '@/db/client';
import { completeItem, failItem } from '@/workers/queue';
import { getWriter } from '@/destinations';
import { emit } from '@/lib/sse';
import { logger } from '@/logger';

const log = logger.child({ route: 'upload' });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = getDb() as any;
  const [item] = await db.select().from(schema.items).where(eq(schema.items.id, id));
  if (!item) return NextResponse.json({ error: 'item not found' }, { status: 404 });
  if (item.status !== 'awaiting-upload') {
    return NextResponse.json(
      { error: `item not awaiting upload (status=${item.status})` },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const file = form.get('file');
  const name = String(form.get('name') ?? '');
  if (!file || !(file instanceof Blob) || !name) {
    return NextResponse.json({ error: 'file and name fields required' }, { status: 400 });
  }

  // Write file bytes to staging dir
  const stagingDir = path.join(process.env.STAGING_DIR ?? os.tmpdir(), `lg-${id}`);
  await fs.mkdir(stagingDir, { recursive: true });
  const destPath = path.join(stagingDir, name);
  await pipeline(
    Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destPath),
  );

  // Update pending list in snapshot
  const snap = (item.snapshot ?? {}) as Record<string, unknown>;
  const pendingUploads =
    (snap.pendingUploads as Array<{ url: string; name: string }> | undefined) ?? [];
  const remaining = pendingUploads.filter((p) => p.name !== name);
  const uploadedFiles = [...((snap.uploadedFiles as string[] | undefined) ?? []), name];

  await db
    .update(schema.items)
    .set({
      snapshot: { ...snap, pendingUploads: remaining, uploadedFiles },
      updatedAt: new Date(),
    })
    .where(eq(schema.items.id, id));

  emit('item-updated', { id, status: 'awaiting-upload', uploaded: name });

  // If all pending files have arrived, assemble + complete
  if (remaining.length === 0) {
    try {
      await assembleAndComplete(id, stagingDir, { ...snap, pendingUploads: remaining, uploadedFiles });
    } catch (err) {
      log.error({ err, id }, 'assemble-after-upload failed');
      await failItem(id, `assemble: ${(err as Error).message}`, false);
      emit('item-updated', { id, status: 'failed' });
      return NextResponse.json({ error: 'assembly failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, remaining: remaining.length });
}

// ── Assembly ───────────────────────────────────────────────────────────────

interface StoredMetadata {
  id?: number;
  slug?: string;
  title?: string;
  titleTranslated?: string;
  summary?: string;
  summaryTranslated?: string;
  coverUrl?: string;
  tags?: string[];
  tagsTranslated?: string[];
  license?: string | { code?: string };
  designCreator?: { name: string; handle: string };
  categories?: unknown[];
  modelId?: string;
  defaultInstanceId?: number;
}

async function assembleAndComplete(
  id: string,
  stagingDir: string,
  snap: Record<string, unknown>,
): Promise<void> {
  const db = getDb() as any;
  const [item] = await db.select().from(schema.items).where(eq(schema.items.id, id));
  if (!item) throw new Error('item not found');
  if (!item.destinationId) throw new Error('no destination assigned');

  // Build a FetchedItem-shaped object from stored snapshot.metadata
  const meta = (snap.metadata ?? {}) as StoredMetadata;

  const title = (typeof meta.titleTranslated === 'string' && meta.titleTranslated.trim())
    ? meta.titleTranslated.trim()
    : (meta.title ?? 'Unknown');
  const description = (typeof meta.summaryTranslated === 'string' && meta.summaryTranslated.trim())
    ? meta.summaryTranslated.trim()
    : (meta.summary ?? '');
  const tags: string[] = meta.tagsTranslated ?? meta.tags ?? [];
  const license =
    typeof meta.license === 'string'
      ? meta.license
      : ((meta.license as { code?: string } | undefined)?.code ?? 'unknown');
  const designerName = meta.designCreator?.name ?? 'Unknown';
  const designerHandle = meta.designCreator?.handle;
  const designerProfileUrl = designerHandle
    ? `https://makerworld.com/en/@${designerHandle}`
    : undefined;
  const sourceUrl = (meta.id && meta.slug)
    ? `https://makerworld.com/en/models/${meta.id}-${meta.slug}`
    : item.sourceUrl;
  const thumbnailUrl = meta.coverUrl;

  // Enumerate files already on disk in staging (excluding datapackage.json)
  const fileNames = await fs.readdir(stagingDir);
  const stagedFileNames = fileNames.filter((n) => n !== 'datapackage.json');

  // Build resources list for datapackage.json
  const resources = stagedFileNames.map((n) => ({
    name: path.parse(n).name,
    path: n,
    mediatype: guessMediaType(n),
  }));

  // Write datapackage.json from synthesized metadata
  const pkg = {
    $schema: 'https://manyfold.app/profiles/0.0/datapackage.json',
    name: slugify(title),
    title,
    homepage: sourceUrl,
    image: thumbnailUrl ? 'thumbnail.jpg' : undefined,
    keywords: tags,
    resources,
    sensitive: false,
    contributors: [
      {
        title: designerName,
        path: designerProfileUrl ?? sourceUrl,
        roles: ['creator'],
        links: [],
      },
    ],
    collections: [],
    license: { title: license },
    links: [],
  };
  await fs.writeFile(
    path.join(stagingDir, 'datapackage.json'),
    JSON.stringify(pkg, null, 2),
  );

  // Resolve destination + write
  const [dest] = await db
    .select()
    .from(schema.destinations)
    .where(eq(schema.destinations.id, item.destinationId));
  if (!dest) throw new Error('destination not found');

  const writer = getWriter(dest.type);
  const syntheticItem = {
    sourceItemId: item.sourceItemId,
    title,
    description,
    designer: { name: designerName, profileUrl: designerProfileUrl },
    collection: undefined,
    tags,
    license,
    sourceUrl,
    thumbnailUrl,
    images: thumbnailUrl ? [{ name: 'cover', url: thumbnailUrl }] : [],
    files: [],
    extraMetadata: {},
  };

  const { outputPath } = await writer.write(stagingDir, dest as any, { item: syntheticItem });
  await completeItem(id, outputPath);
  emit('item-updated', { id, status: 'done', outputPath });
  log.info({ id, outputPath }, 'item assembled and completed after upload');
}

function guessMediaType(name: string): string {
  if (name.endsWith('.3mf')) return 'model/3mf';
  if (name.endsWith('.stl')) return 'model/stl';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
