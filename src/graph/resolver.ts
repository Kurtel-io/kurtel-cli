import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';

interface Config { base?: string; paths?: Record<string, string[]>; pathsBase?: string }

export function resolutionConfigFiles(root: string): string[] {
  const seen = new Set<string>();
  readConfig(join(root, existsSync(join(root, 'tsconfig.json')) ? 'tsconfig.json' : 'jsconfig.json'), seen);
  return [...new Set([join(root, 'tsconfig.json'), join(root, 'jsconfig.json'), ...seen])].sort();
}

function readConfig(file: string, seen = new Set<string>()): Config {
  if (seen.has(file) || !existsSync(file)) return {};
  seen.add(file);
  try {
    const errors: ParseError[] = [];
    const raw = parse(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length || !raw || typeof raw !== 'object') return {};
    let config: Config = {};
    const parents = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
    for (const parent of parents) {
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
      let path = resolve(dirname(file), parent);
      if (!extname(path)) path += '.json';
      config = { ...config, ...readConfig(path, seen) };
    }
    const options = raw.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') config.base = resolve(dirname(file), options.baseUrl);
    if (options.paths && typeof options.paths === 'object') {
      config.paths = options.paths;
      config.pathsBase = config.base ?? dirname(file);
    }
    return config;
  } catch { return {}; }
}

/** Resolve only to indexed files; never load code from a package or outside the repository. */
export function buildResolver(root: string, files: Iterable<string>): (file: string, spec: string) => string | undefined {
  const known = new Set(files);
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs'];
  const config = readConfig(join(root, existsSync(join(root, 'tsconfig.json')) ? 'tsconfig.json' : 'jsconfig.json'));
  function find(path: string): string | undefined {
    const rel = relative(root, resolve(root, path)).replace(/\\/g, '/');
    if (known.has(rel)) return rel;
    const stem = rel.replace(/\.(?:mjs|cjs|js|jsx)$/, '');
    for (const ext of extensions) if (known.has(stem + ext)) return stem + ext;
    for (const ext of extensions) if (known.has(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
    if (known.has(`${stem}/__init__.py`)) return `${stem}/__init__.py`;
    return undefined;
  }
  return (file, spec) => {
    if (spec.startsWith('.')) return find(join(dirname(file), spec));
    const aliases = Object.entries(config.paths ?? {}).sort(([a], [b]) => b.split('*')[0].length - a.split('*')[0].length);
    for (const [alias, targets] of aliases) {
      const [prefix, suffix = ''] = alias.split('*');
      const wildcard = alias.includes('*');
      if (wildcard ? !spec.startsWith(prefix) || !spec.endsWith(suffix) : spec !== alias) continue;
      const middle = wildcard ? spec.slice(prefix.length, suffix ? -suffix.length : undefined) : '';
      if (Array.isArray(targets)) for (const target of targets) {
        if (typeof target !== 'string') continue;
        const match = find(resolve(config.pathsBase ?? root, target.replace('*', middle)));
        if (match) return match;
      }
      return undefined;
    }
    if (config.base) {
      const match = find(resolve(config.base, spec));
      if (match) return match;
    }
    if (extname(file) === '.py') return find(spec.replace(/\./g, '/'));
    // Retain legacy conventions only when the project does not declare aliases.
    if (!config.paths) return find(spec.replace(/^[@~]\//, 'src/')) ?? find(spec);
    return find(spec);
  };
}
