import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export function createTempDir(prefix = 'orchestrator-', baseDir?: string): string {
  const root = baseDir ?? path.join(process.cwd(), '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${prefix}${uuidv4()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDirRecursive(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function atomicSwapDir(src: string, dest: string) {
  if (!fs.existsSync(src)) {
    throw new Error(`Atomic swap source missing: ${src}`);
  }

  // Remove dest if exists, then rename src to dest
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(src, dest);
}
