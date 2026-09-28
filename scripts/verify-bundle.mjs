import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || !manifest.files || manifest.platform !== process.platform || manifest.architecture !== process.arch) throw Error('Bundle platform or manifest mismatch');
const observed = new Set();
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const path = prefix + name, file = join(dir, name), stat = lstatSync(file);
    if (path === 'manifest.json') continue;
    if (stat.isSymbolicLink()) { if (!path.startsWith('node_modules/.bin/')) throw Error(`Unexpected link: ${path}`); continue; }
    if (stat.isDirectory()) walk(file, path + '/');
    else {
      if (manifest.files[path] !== createHash('sha256').update(readFileSync(file)).digest('hex')) throw Error(`Integrity mismatch: ${path}`);
      observed.add(path);
    }
  }
}
walk(root);
if (observed.size !== Object.keys(manifest.files).length) throw Error('Bundle files missing');
console.log(`Verified ${observed.size} files. Manifest authenticity must be checked through your trusted distribution channel.`);
