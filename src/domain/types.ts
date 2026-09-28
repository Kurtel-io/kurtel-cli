export interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;       // express | fastapi | nest | flask | next | unknown
}

export interface SymbolNode {
  name: string;
  line: number;
  calls: string[];         // "path/file.ts::function"
}

export interface ModuleNode {
  id: string;              // repository-relative path
  exports: string[];
  imports: string[];
  loc: number;
  degree: number;
  symbols: SymbolNode[];
}

export interface CodebaseIndex {
  version: 1;
  parser?: { engine: "tree-sitter" | "regex"; regex_fallbacks: number };
  repo: string;
  branch: string;
  files_indexed: number;
  routes: RouteEntry[];
  modules: ModuleNode[];
  god_nodes: { id: string; degree: number }[];
  domains: { name: string; files: number; loc: number }[];
}

export interface MemoryState {
  enabled: boolean;        // kurtel memory on|off
  off?: boolean;           // kurtel off
  activated?: boolean;
  session_zones: Record<string, string[]>;
}

export interface FileFacts {
  rel: string;
  loc: number;
  exports: string[];
  importSpecs: string[];
  routes: RouteEntry[];
  defs: { name: string; line: number }[];
  namedImports: Record<string, { spec: string; orig: string } | string>;
  rawCalls: { name: string; line: number; owner?: number }[];
}
