import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { RouteEntry } from "./store.js";
import type { FileFacts } from "./indexer.js";

// ── Extraction AST via tree-sitter (WASM) ──
// web-tree-sitter@0.20.8 + tree-sitter-wasms: ABI appariée pinnée, pas de bindings natifs (install cross-platform). Init lazy, grammaires en cache, échec → null (fallback regex côté indexeur).

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
    case ".java": return "java";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".cs": return "c_sharp";
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
    initFailed = true; // env sans WASM: une seule tentative, fallback regex global
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

/** Ligne de la def nommée englobante (0 = top-level/anonyme). Ligne du nœud porteur du nom, pour aligner `owner` sur `byLine` côté buildSymbols. */
function enclosingDefLine(node: TSNode, defKinds: Set<string>, nameOf: (n: TSNode) => TSNode | null): number {
  let cur = node.parent;
  while (cur) {
    if (defKinds.has(cur.type)) {
      const name = nameOf(cur);
      if (name) {
        // def enregistrée à la ligne du déclarateur/méthode, pas de l'arrow
        if (cur.type === "arrow_function" || cur.type === "function" || cur.type === "function_expression") {
          const carrier = cur.parent; // variable_declarator | public_field_definition
          return line(carrier ?? cur);
        }
        return line(cur);
      }
      // anonyme: on continue de remonter
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
            // local = alias sinon name; imports de type ignorés
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

// ── Java ─────────────────────────────────────────────────────────────────────

const JAVA_DEF_KINDS = new Set(["method_declaration", "constructor_declaration"]);
const SPRING_MAPPINGS: Record<string, string> = {
  GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT",
  DeleteMapping: "DELETE", PatchMapping: "PATCH", RequestMapping: "*",
};

function extractJava(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);
  for (const imp of root.descendantsOfType("import_declaration")) {
    const id = imp.descendantsOfType("scoped_identifier")[0] ?? imp.namedChildren[0];
    if (id) {
      const full = id.text;
      const cls = full.split(".").pop();
      facts.importSpecs.push(full);
      if (cls && /^[A-Z]/.test(cls)) facts.namedImports[cls] = full;
    }
  }
  for (const m of root.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    const name = m.childForFieldName("name");
    if (name) { facts.defs.push({ name: name.text, line: line(m) }); facts.exports.push(name.text); }
    for (const ann of m.descendantsOfType(["annotation", "marker_annotation"])) {
      const an = ann.childForFieldName("name")?.text;
      if (an && SPRING_MAPPINGS[an]) {
        const arg = ann.descendantsOfType("string_literal")[0];
        facts.routes.push({ method: SPRING_MAPPINGS[an], path: arg ? stripQuotes(arg.text) : "", file: rel, line: line(ann), framework: "spring" });
      }
    }
  }
  for (const c of root.descendantsOfType(["class_declaration", "interface_declaration", "enum_declaration"])) {
    const name = c.childForFieldName("name");
    if (name) facts.exports.push(name.text);
  }
  for (const call of root.descendantsOfType("method_invocation")) {
    const name = call.childForFieldName("name");
    const obj = call.childForFieldName("object");
    const owner = enclosingDefLine(call, JAVA_DEF_KINDS, (n) => n.childForFieldName("name"));
    if (obj && /^[A-Z]/.test(obj.text)) facts.rawCalls.push({ name: obj.text + ".", line: line(call), owner });
    if (name) facts.rawCalls.push({ name: name.text, line: line(call), owner });
  }
  return facts;
}

// ── Go ───────────────────────────────────────────────────────────────────────

const GO_DEF_KINDS = new Set(["function_declaration", "method_declaration"]);

function extractGo(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);
  for (const spec of root.descendantsOfType("import_spec")) {
    const path = spec.childForFieldName("path");
    if (path) {
      const p = stripQuotes(path.text);
      facts.importSpecs.push(p);
      const pkg = p.split("/").pop();
      if (pkg) facts.namedImports[pkg] = p;
    }
  }
  for (const fn of root.descendantsOfType(["function_declaration", "method_declaration"])) {
    const name = fn.childForFieldName("name");
    if (name) {
      facts.defs.push({ name: name.text, line: line(fn) });
      if (/^[A-Z]/.test(name.text)) facts.exports.push(name.text);
    }
  }
  for (const ts of root.descendantsOfType("type_spec")) {
    const name = ts.childForFieldName("name");
    if (name && /^[A-Z]/.test(name.text)) facts.exports.push(name.text);
  }
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    const owner = enclosingDefLine(call, GO_DEF_KINDS, (n) => n.childForFieldName("name"));
    if (!fn) continue;
    if (fn.type === "identifier") {
      facts.rawCalls.push({ name: fn.text, line: line(call), owner });
    } else if (fn.type === "selector_expression") {
      const operand = fn.childForFieldName("operand");
      if (operand?.type === "identifier") facts.rawCalls.push({ name: operand.text + ".", line: line(call), owner });
    }
  }
  return facts;
}

// ── Rust ─────────────────────────────────────────────────────────────────────

const RUST_DEF_KINDS = new Set(["function_item"]);

function extractRust(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);
  for (const use of root.descendantsOfType("use_declaration")) {
    const full = use.text.replace(/^use\s+/, "").replace(/;$/, "").trim();
    const parts = full.split("::");
    if (parts.length >= 2) {
      const name = parts[parts.length - 1].replace(/[{}\s].*$/, "");
      const path = parts.slice(0, -1).join("/").replace(/^crate\//, "src/").replace(/^crate$/, "src");
      facts.importSpecs.push(path);
      if (/^[a-z_]\w*$/i.test(name)) facts.namedImports[name] = path;
    }
  }
  for (const fn of root.descendantsOfType("function_item")) {
    const name = fn.childForFieldName("name");
    if (name) {
      facts.defs.push({ name: name.text, line: line(fn) });
      if (fn.children.some((c) => c.type === "visibility_modifier")) facts.exports.push(name.text);
    }
  }
  for (const s of root.descendantsOfType(["struct_item", "enum_item", "trait_item"])) {
    const name = s.childForFieldName("name");
    if (name) facts.exports.push(name.text);
  }
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    const owner = enclosingDefLine(call, RUST_DEF_KINDS, (n) => n.childForFieldName("name"));
    if (!fn) continue;
    if (fn.type === "identifier") {
      facts.rawCalls.push({ name: fn.text, line: line(call), owner });
    } else if (fn.type === "scoped_identifier") {
      const name = fn.descendantsOfType("identifier").pop();
      if (name) facts.rawCalls.push({ name: name.text, line: line(call), owner });
    } else if (fn.type === "field_expression") {
      const field = fn.childForFieldName("field");
      if (field) facts.rawCalls.push({ name: field.text, line: line(call), owner });
    }
  }
  return facts;
}

// ── C# ───────────────────────────────────────────────────────────────────────

const CS_DEF_KINDS = new Set(["method_declaration", "constructor_declaration"]);
const CS_HTTP_ATTRS: Record<string, string> = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE", HttpPatch: "PATCH", Route: "*",
};

function extractCSharp(rel: string, src: string, root: TSNode): FileFacts {
  const facts = emptyFacts(rel, src);
  for (const u of root.descendantsOfType("using_directive")) {
    const name = u.descendantsOfType("qualified_name")[0] ?? u.descendantsOfType("identifier")[0];
    if (name) facts.importSpecs.push(name.text);
  }
  for (const m of root.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    const name = m.childForFieldName("name");
    if (name) { facts.defs.push({ name: name.text, line: line(m) }); facts.exports.push(name.text); }
    for (const attr of m.descendantsOfType("attribute")) {
      const an = attr.childForFieldName("name")?.text;
      if (an && CS_HTTP_ATTRS[an]) {
        const arg = attr.descendantsOfType("string_literal")[0];
        facts.routes.push({ method: CS_HTTP_ATTRS[an], path: arg ? stripQuotes(arg.text) : "", file: rel, line: line(attr), framework: "aspnet" });
      }
    }
  }
  for (const c of root.descendantsOfType(["class_declaration", "interface_declaration", "record_declaration"])) {
    const name = c.childForFieldName("name");
    if (name) facts.exports.push(name.text);
  }
  for (const call of root.descendantsOfType("invocation_expression")) {
    const fn = call.childForFieldName("function");
    const owner = enclosingDefLine(call, CS_DEF_KINDS, (n) => n.childForFieldName("name"));
    if (!fn) continue;
    if (fn.type === "identifier") {
      facts.rawCalls.push({ name: fn.text, line: line(call), owner });
    } else if (fn.type === "member_access_expression") {
      const obj = fn.childForFieldName("expression");
      const name = fn.childForFieldName("name");
      if (obj?.type === "identifier" && /^[A-Z]/.test(obj.text)) facts.rawCalls.push({ name: obj.text + ".", line: line(call), owner });
      if (name) facts.rawCalls.push({ name: name.text, line: line(call), owner });
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
    const root = tree.rootNode;
    let facts: FileFacts;
    switch (ext) {
      case ".py": facts = extractPy(rel, src, root); break;
      case ".java": facts = extractJava(rel, src, root); break;
      case ".go": facts = extractGo(rel, src, root); break;
      case ".rs": facts = extractRust(rel, src, root); break;
      case ".cs": facts = extractCSharp(rel, src, root); break;
      default: facts = extractJs(rel, src, root); break; // ts/tsx/js/jsx
    }

    // Dédupe (1re occurrence) + tri + bornes — parité avec la voie regex.
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
    return null; // illisible par l'AST → regex
  } finally {
    tree?.delete(); // libère la mémoire WASM (milliers de fichiers)
  }
}

/** Routes par convention de fichier Next.js — indépendant du parseur, partagé. */
export function nextRouteFor(rel: string): RouteEntry | null {
  const nm = rel.replace(/\\/g, "/").match(/(^|\/)(pages|app)\/(.+?)\/?(route|page|index)?\.(ts|tsx|js|jsx)$/);
  if (!nm) return null;
  const urlPath = "/" + nm[3].replace(/\[(\w+)\]/g, ":$1").replace(/\/index$/, "");
  return { method: "*", path: urlPath, file: rel, line: 1, framework: "next" };
}
