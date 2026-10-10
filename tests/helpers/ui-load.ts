import { readFileSync } from "node:fs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function dep(deps: Record<string, any>, spec: string): string {
  if (!(spec in deps)) throw new Error(`loadUiSource: no stub for ${spec}`);
  return `__deps[${JSON.stringify(spec)}]`;
}

/**
 * Runs a file of `ui/` with its imports taken from `deps` (the browser modules cannot be imported by vitest when they import
 * `/vendor/…`). `export` is dropped, and the names in `exportNames` are returned once the module body has finished.
 * Throws on an import form it does not know and on an import without a stub. `text` replaces the file (for the self test).
 */
export function loadUiSource(file: string, deps: Record<string, any>, exportNames: string[] = [], text?: string): Promise<Record<string, any>> {
  const src = (text ?? readFileSync(`ui/${file}`, "utf8"))
    .replace(/^import (\w+) from "([^"]+)";$/gm, (_m, x, s) => `const ${x} = ${dep(deps, s)}.default;`)
    .replace(/^import \{([^}]+)\} from "([^"]+)";$/gm, (_m, names, s) => `const {${names}} = ${dep(deps, s)};`)
    .replace(/^export (async function|function|const)\b/gm, "$1");
  if (/^import /m.test(src)) throw new Error(`loadUiSource: an import form is not supported in ${file}`);
  return new AsyncFunction("__deps", `"use strict";\n${src}\nreturn { ${exportNames.join(", ")} };`)(deps);
}
