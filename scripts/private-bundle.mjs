import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || existsSync(destination)) throw Error('Usage: node scripts/private-bundle.mjs <new-empty-destination>; run npm run build first');
if (!existsSync(join(root, 'dist', 'index.js'))) throw Error('Build the CLI first');
mkdirSync(destination, { recursive: true });
for (const name of ['dist', 'assets', 'package.json', 'package-lock.json']) if (existsSync(join(root, name))) cpSync(join(root, name), join(destination, name), { recursive: true });
const install = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], { cwd: destination, encoding: 'utf8', windowsHide: true })
  : spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, encoding: 'utf8' });
if (install.status !== 0) throw Error(install.stderr || install.error?.message || 'Production dependency installation failed');
const offline = { version: 1, mode: 'offline', engine_origins: [] };
writeFileSync(join(destination, 'network-policy.json'), JSON.stringify(offline, null, 2) + '\n');
writeFileSync(join(destination, 'kurtel.mjs'), `import { fileURLToPath } from 'node:url';\nprocess.env.KURTEL_POLICY_FILE ??= fileURLToPath(new URL('./network-policy.json', import.meta.url));\nawait import('./dist/index.js');\n`);
cpSync(join(root, 'scripts', 'verify-bundle.mjs'), join(destination, 'verify-bundle.mjs'));
const manifest = { version: 1, node: process.version, platform: process.platform, architecture: process.arch, cli_version: JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).version, files: {} };
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name), path = prefix + name, stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue; // npm executable links; CLI does not use node_modules/.bin.
    if (stat.isDirectory()) walk(file, path + '/');
    else manifest.files[path] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
}
walk(destination);
writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ bundle: destination, files: Object.keys(manifest.files).length, platform: manifest.platform, architecture: manifest.architecture }));
