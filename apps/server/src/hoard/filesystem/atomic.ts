import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicMoveDir(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (err) {
    // Cross-device: copy then delete.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyRecursive(from, to);
      await fs.rm(from, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyRecursive(s, d);
    else await fs.copyFile(s, d);
  }
}

export async function ensureEmptyStagingDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}
