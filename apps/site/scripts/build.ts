/**
 * Bundles the site into a directory of static files: the page and its stylesheet as they are,
 * and `main.ts` with its workspace imports into one ES module. A search index goes in under
 * `index/`, where the page fetches it from.
 *
 * Usage: node apps/site/scripts/build.ts [--out <dir>] [--index <dir>] [--no-minify]
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { renderHeadersFile } from "./static.ts";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));

// `pnpm --filter` runs this with the working directory set to the package, so a relative --index
// or --out is resolved against where the person actually typed the command (INIT_CWD, which pnpm
// sets to that directory), not against apps/site. An absolute path passes through unchanged.
const invokedFrom = process.env["INIT_CWD"] ?? process.cwd();
const fromInvocation = (path: string): string => resolve(invokedFrom, path);

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    index: { type: "string" },
    minify: { type: "boolean", default: true },
  },
  strict: true,
});

const out = values.out === undefined ? join(SITE, "dist") : fromInvocation(values.out);
const indexDir = values.index === undefined ? undefined : fromInvocation(values.index);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(SITE, "public"), out, { recursive: true });

const result = await build({
  entryPoints: [join(SITE, "src", "main.ts"), join(SITE, "src", "bench.ts")],
  outdir: out,
  bundle: true,
  format: "esm",
  target: "es2023",
  minify: values.minify,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});

if (indexDir !== undefined) {
  await cp(indexDir, join(out, "index"), { recursive: true });
}

// The security headers a deployment serves the site with (ADR-0028). A Cloudflare Workers
// static-assets deployment reads this file; it is harmless anywhere else. The dev server does
// not read it, applying the same headers in code from the same source, so the two cannot drift.
await writeFile(join(out, "_headers"), renderHeadersFile());

const bytes = async (path: string): Promise<number> => (await stat(path)).size;
const scriptBytes = await bytes(join(out, "main.js"));
const inputs = Object.entries(result.metafile.inputs)
  .sort(([, left], [, right]) => right.bytes - left.bytes)
  .slice(0, 5);

process.stdout.write(
  [
    `Built the site into ${out}`,
    `  main.js ${(scriptBytes / 1024).toFixed(1)} KB${values.minify ? " minified" : ""}`,
    ...inputs.map(([path, input]) => `    ${path} ${(input.bytes / 1024).toFixed(1)} KB`),
    `  ${(await readdir(out)).length} entries at the top level`,
    "",
  ].join("\n"),
);
