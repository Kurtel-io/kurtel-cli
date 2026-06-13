import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { RouteEntry } from "./store.js";
import type { FileFacts } from "./indexer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extraction AST via tree-sitter (WASM) — la voie prod.
//   · web-tree-sitter@0.20.8 EXACT + tree-sitter-wasms: paire d'ABI appariée,
//     pinnée dans package.json. PAS de bindings natifs (node-gyp/VS Build Tools
//     seraient l'enfer d'install sur les machines des utilisateurs).
//   · Langages: typescript, tsx, javascript (+ jsx/mjs/cjs), python.
//   · Chargement lazy (init au premier fichier), grammaires mises en cache,
//     arbres libérés après chaque fichier (mémoire WASM).
//   · Si l'init ou une grammaire échoue → null, l'indexeur retombe sur les
//     heuristiques regex. Le CLI ne casse jamais pour un parseur.
// ─────────────────────────────────────────────────────────────────────────────

// Typage minimal de l'API 0.20 (le package CJS n'expose pas ses types via exports)
interface TSPoint { row: number; column: number }
interface TSNode {
  type: string;
  text: string;
  startPosition: TSPoint;
  parent: TSNode | null;
  namedChildren: TSNode[];
  children: TSNode[];
  childForFieldName(name: string): TSNode | null;
  descendantsOfType(type: string | string[]): TSNode[];
}
interface TSTree { rootNode: TSNode; delete(): void }
interface TSParser {
  setLanguage(l: unknown): void;
  parse(src: string): TSTree;
}

const require = createRequire(import.meta.url);

let initFailed = false;
let parser: TSParser | null = null;
const languages = new Map<string, unknown>();   // grammarName → Language
const missing = new Set<string>();

function grammarFor(ext: string): string | null {
  switch (ext) {
    case ".ts": case ".mts": case ".cts": return "typescript";
    case ".tsx": return "tsx";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "javascript"; // jsx couvert par la grammaire JS
    case ".py": return "python";
    default: return null;
  }
}

async function getParser(ext: string): Promise<{ parser: TSParser; lang: unknown } | null> {
  if (initFailed) return null;
  const grammar = grammarFor(ext);
  if (!grammar || missing.has(grammar)) return null;
  try {
    if (!parser) {
      const Parser = require("web-tree-sitter");
      await Parser.init();
      parser = new Parser() as TSParser;
      (getParser as { ParserClass?: unknown }).ParserClass = Parser;
    }
    let lang = languages.get(grammar);
    if (!lang) {
      const wasmDir = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
      const wasmPath = join(wasmDir, `tree-sitter-${grammar}.wasm`);
      if (!existsSync(wasmPath)) { missing.add(grammar); return null; }
      const Parser = (getParser as { ParserClass?: { Language: { load(p: string): Promise<unknown> } } }).ParserClass!;
      lang = await Parser.Language.load(wasmPath);
      languages.set(grammar, lang);
    }
    return { parser, lang };
  } catch {
    initFailed = true; // environnement sans WASM: fallback regex global, une seule tentative
    return null;
  }
}

// ── Helpers communs ──────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const ROUTE_OBJECTS = new Set(["app", "router", "server", "api", "fastify"]);
const NEST_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"]);

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}
function line(n: TSNode): number { return n.startPosition.row + 1; }

/** Ligne de la définition nommée englobante (0 = top-level / handler anonyme → "(module)").
 *  Renvoie la ligne du NŒUD PORTEUR DU NOM (def enregistrée dans facts.defs), pour
 *  que l'attribution par `owner` matche `byLine` côté buildSymbols. */
function enclosingDefLine(node: TSNode, defKinds: Set<string>, nameOf: (n: TSNode) => TSNode | null): number {
  let cur = node.parent;
  while (cur) {
    if (defKinds.has(cur.type)) {
      const name = nameOf(cur);
      if (name) {
        // La def est enregistrée à la ligne du déclarateur/méthode, pas de l'arrow.
        if (cur.type === "arrow_function" || cur.type === "function" || cur.type === "function_expression") {
          const carrier = cur.parent; // variable_declarator | public_field_definition
          return line(carrier ?? cur);
        }
        return line(cur);
      }
      // fonction anonyme (callback inline): on continue de remonter
    }
    cur = cur.parent;
  }
  return 0;
}

function emptyFacts(rel: string, src: string): FileFacts {
  return {
    rel, loc: src.split("\n").length, exports: [], importSpecs: [], routes: [],
    defs: [], namedImports: {}, rawCalls: [],
  };
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────────

const JS_DEF_KINDS = new Set(["function_declaration", "generator_function_declaration", "method_definition", "arrow_function", "function", "function_expression"]);

function jsDefName(n: TSNode): TSNode | null {
  if (n.type === "function_declaration" || n.type === "generator_function_declaration" || n.type === "method_definition") {
    return n.childForFieldName("name");
  }
  // arrow/function expression: nommée seulement si assignée directement à un déclarateur
  const p = n.parent;
  if (p?.type === "variable_declarator") return p.childForFieldName("name");
  if (p?.type === "public_field_definition") return p.childForFieldName("name");
  return null;
}

function extractJs(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);

  // Imports (statiques + re-exports + require)
  for (const imp of root.descendantsOfType("import_statement")) {
    const source = imp.childForFieldName("source");
    if (!source) continue;
    const spec = stripQuotes(source.text);
    facts.importSpecs.push(spec);
    for (const clause of imp.descendantsOfType("import_clause")) {
      for (const child of clause.namedChildren) {
        if (child.type === "identifier") {
          facts.namedImports[child.text] = spec;                 // default import
        } else if (child.type === "namespace_import") {
          const id = child.descendantsOfType("identifier")[0];   // import * as utils
          if (id) facts.namedImports[id.text] = spec;
        } else if (child.type === "named_imports") {
          for (const isp of child.descendantsOfType("import_specifier")) {
            // local = alias si présent, sinon name. On ignore les imports de type.
            if (isp.children.some((c) => c.type === "type")) continue;
            const nameNode = isp.childForFieldName("name");
            const aliasNode = isp.childForFieldName("alias");
            const local = (aliasNode ?? nameNode)?.text;
            const orig = nameNode?.text;
            if (local && orig) facts.namedImports[local] = local === orig ? spec : { spec, orig };
          }
        }
      }
    }
  }
  for (const exp of root.descendantsOfType("export_statement")) {
    const source = exp.childForFieldName("source");
    if (source) facts.importSpecs.push(stripQuotes(source.text)); // re-export = arête
    const decl = exp.childForFieldName("declaration");
    const name = decl?.childForFieldName("name");
    if (name) facts.exports.push(name.text);
    for (const spec of exp.descendantsOfType("export_specifier")) {
      const n = (spec.childForFieldName("alias") ?? spec.childForFieldName("name"))?.text;
      if (n) facts.exports.push(n);
    }
  }

  // Définitions
  for (const fn of root.descendantsOfType(["function_declaration", "generator_function_declaration"])) {
    const name = fn.childForFieldName("name");
    if (name) facts.defs.push({ name: name.text, line: line(fn) });
  }
  for (const decl of root.descendantsOfType("variable_declarator")) {
    const value = decl.childForFieldName("value");
    const name = decl.childForFieldName("name");
    if (name?.type === "identifier" && value && (value.type === "arrow_function" || value.type === "function" || value.type === "function_expression")) {
      facts.defs.push({ name: name.text, line: line(decl) });
    }
  }
  for (const m of root.descendantsOfType("method_definition")) {
    const name = m.childForFieldName("name");
    if (name && name.text !== "constructor") facts.defs.push({ name: name.text, line: line(m) });
  }
  for (const f of root.descendantsOfType("public_field_definition")) {
    const value = f.childForFieldName("value");
    const name = f.childForFieldName("name");
    if (name && value?.type === "arrow_function") facts.defs.push({ name: name.text, line: line(f) });
  }
  for (const c of root.descendantsOfType("class_declaration")) {
    const name = c.childForFieldName("name");
    if (name) facts.exports.push(name.text);
  }

  // Appels + routes
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    if (fn.type === "identifier") {
      if (fn.text === "require") {
        const arg = call.childForFieldName("arguments")?.namedChildren[0];
        if (arg && (arg.type === "string" || arg.type === "template_string")) facts.importSpecs.push(stripQuotes(arg.text));
        continue;
      }
      facts.rawCalls.push({ name: fn.text, line: line(call), owner: enclosingDefLine(call, JS_DEF_KINDS, jsDefName) });
    } else if (fn.type === "member_expression") {
      const obj = fn.childForFieldName("object");
      const prop = fn.childForFieldName("property");
      if (!obj || !prop) continue;
      // Route express-like: app.get("/x", ...)
      if (obj.type === "identifier" && ROUTE_OBJECTS.has(obj.text) && HTTP_METHODS.has(prop.text)) {
        const arg = call.childForFieldName("arguments")?.namedChildren[0];
        if (arg && (arg.type === "string" || arg.type === "template_string")) {
          facts.routes.push({ method: prop.text.toUpperCase(), path: stripQuotes(arg.text), file: rel, line: line(call), framework: "express-like" });
        }
      }
      // Appel qualifié résoluble: ImportéOuClasse.method(...)
      if (obj.type === "identifier") {
        facts.rawCalls.push({ name: obj.text + ".", line: line(call), owner: enclosingDefLine(call, JS_DEF_KINDS, jsDefName) });
      }
    }
  }
  // Décorateurs Nest: @Get("/x")
  for (const dec of root.descendantsOfType("decorator")) {
    const call = dec.namedChildren[0];
    if (call?.type !== "call_expression") continue;
    const fn = call.childForFieldName("function");
    if (fn?.type === "identifier" && NEST_DECORATORS.has(fn.text)) {
      const arg = call.childForFieldName("arguments")?.namedChildren[0];
      facts.routes.push({
        method: fn.text.toUpperCase(),
        path: arg && (arg.type === "string") ? stripQuotes(arg.text) : "",
        file: rel, line: line(dec), framework: "nest",
      });
    }
  }
  return facts;
}

// ── Python ───────────────────────────────────────────────────────────────────

const PY_DEF_KINDS = new Set(["function_definition"]);
const pyDefName = (n: TSNode) => n.childForFieldName("name");

/** "from .sub import x" → spec JS-style "./sub" résoluble par le résolveur existant. */
function pyRelativeSpec(dots: number, mod: string): string {
  const up = dots <= 1 ? "./" : "../".repeat(dots - 1);
  return up + mod.replace(/\./g, "/");
}

function extractPy(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);

  for (const imp of root.descendantsOfType("import_from_statement")) {
    // forme: from <relative_import|dotted_name> import a, b as c | from . import service
    const modNode = imp.childForFieldName("module_name");
    let spec = "";
    let relative = false;
    if (modNode) {
      if (modNode.type === "relative_import") {
        relative = true;
        const dots = (modNode.text.match(/^\.+/) ?? ["."])[0].length;
        const mod = modNode.text.slice(dots);
        spec = pyRelativeSpec(dots, mod);
      } else {
        spec = modNode.text;
      }
    }
    const names: string[] = [];
    for (const child of imp.namedChildren) {
      if (child === modNode) continue;
      if (child.type === "dotted_name") names.push(child.text);
      if (child.type === "aliased_import") {
        const alias = child.childForFieldName("alias");
        if (alias) names.push(alias.text);
      }
    }
    if (relative && !spec.replace(/^\.\/|\.\.\//g, "")) {
      // "from . import service" → chaque nom est un module frère
      for (const n of names) {
        const s = pyRelativeSpec(1, n);
        facts.importSpecs.push(s);
        facts.namedImports[n] = s;
      }
    } else if (spec) {
      facts.importSpecs.push(spec);
      for (const n of names) facts.namedImports[n] = spec;
    }
  }
  for (const imp of root.descendantsOfType("import_statement")) {
    for (const d of imp.descendantsOfType("dotted_name")) facts.importSpecs.push(d.text);
  }

  for (const fn of root.descendantsOfType("function_definition")) {
    const name = fn.childForFieldName("name");
    if (name) {
      facts.defs.push({ name: name.text, line: line(fn) });
      facts.exports.push(name.text);
    }
  }
  for (const cls of root.descendantsOfType("class_definition")) {
    const name = cls.childForFieldName("name");
    if (name) facts.exports.push(name.text);
  }

  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    if (fn.type === "identifier") {
      facts.rawCalls.push({ name: fn.text, line: line(call), owner: enclosingDefLine(call, PY_DEF_KINDS, pyDefName) });
    } else if (fn.type === "attribute") {
      const obj = fn.childForFieldName("object");
      const attr = fn.childForFieldName("attribute");
      if (obj?.type === "identifier" && attr) {
        // Route FastAPI/Flask: app.get("/x") en position de décorateur
        if (call.parent?.type === "decorator" && (HTTP_METHODS.has(attr.text) || attr.text === "route")) {
          const arg = call.childForFieldName("arguments")?.namedChildren[0];
          if (arg?.type === "string") {
            facts.routes.push({
              method: attr.text === "route" ? "*" : attr.text.toUpperCase(),
              path: stripQuotes(arg.text), file: rel, line: line(call), framework: "python",
            });
          }
        }
        facts.rawCalls.push({ name: obj.text + ".", line: line(call), owner: enclosingDefLine(call, PY_DEF_KINDS, pyDefName) });
      }
    }
  }
  return facts;
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

const MAX_DEFS = 40;
const MAX_CALLS = 1000;

/** Extraction AST. Retourne null si tree-sitter indisponible pour ce fichier → fallback regex. */
export async function extractFileAst(rel: string, src: string, ext: string): Promise<FileFacts | null> {
  const ctx = await getParser(ext);
  if (!ctx) return null;
  let tree: TSTree | null = null;
  try {
    ctx.parser.setLanguage(ctx.lang);
    tree = ctx.parser.parse(src);
    const facts = ext === ".py" ? extractPy(rel, src, tree.rootNode) : extractJs(rel, src, tree.rootNode);

    // Bornes + dédupe defs (première occurrence par nom), tri par ligne — comme la voie regex.
    const seen = new Set<string>();
    facts.defs = facts.defs
      .sort((a, b) => a.line - b.line)
      .filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
      .slice(0, MAX_DEFS);
    facts.rawCalls = facts.rawCalls.slice(0, MAX_CALLS).sort((a, b) => a.line - b.line);
    facts.routes = facts.routes.slice(0, 200);
    facts.exports = [...new Set(facts.exports)];
    return facts;
  } catch {
    return null; // fichier illisible par l'AST → regex
  } finally {
    tree?.delete(); // mémoire WASM: indispensable sur des milliers de fichiers
  }
}

/** Routes par convention de fichier Next.js — indépendant du parseur, partagé. */
export function nextRouteFor(rel: string): RouteEntry | null {
  const nm = rel.replace(/\\/g, "/").match(/(^|\/)(pages|app)\/(.+?)\/?(route|page|index)?\.(ts|tsx|js|jsx)$/);
  if (!nm) return null;
  const urlPath = "/" + nm[3].replace(/\[(\w+)\]/g, ":$1").replace(/\/index$/, "");
  return { method: "*", path: urlPath, file: rel, line: 1, framework: "next" };
}
