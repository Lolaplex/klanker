// Node module hooks: compile .tsx/.jsx on the fly so component tests run
// under plain `node --test` without a vitest dependency. esbuild ships
// with vite — resolve it through vite's dependency closure (pnpm never
// hoists it to the root node_modules).
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// import.meta.resolve is unreliable inside the hooks thread — walk up
// from this file and resolve vite through the app's own node_modules.
const appRequire = createRequire(fileURLToPath(new URL("../../package.json", import.meta.url)));
const vitePkg = appRequire.resolve("vite/package.json");
const viteRequire = createRequire(vitePkg);
const esbuild = viteRequire("esbuild");

const isTsx = (spec) => /\.(tsx|jsx)(\?|$)/.test(spec);
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");
const hasExtension = (spec) => /\.[a-zA-Z]+$/.test(spec.split("?")[0]);

export async function resolve(specifier, context, nextResolve) {
  // Extensionless relative imports inside transpiled components (the web
  // app writes vite-style `../wsTree`): probe the runtime extensions.
  if (isRelative(specifier) && !hasExtension(specifier) && context.parentURL?.startsWith("file:")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
      const candidate = new URL(base.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        const url = candidate.href;
        return { url, format: isTsx(url) ? "tsx" : undefined, shortCircuit: true };
      }
    }
  }
  if (isTsx(specifier)) {
    const out = await nextResolve(specifier, context);
    return { ...out, format: "tsx" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (context.format === "tsx" || isTsx(url)) {
    const source = await readFile(new URL(url), "utf8");
    const out = esbuild.transformSync(source, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      target: "node18",
      sourcemap: "inline",
    });
    return { format: "module", source: out.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
