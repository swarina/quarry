/**
 * Bundles the site into a directory of static files: the page and its stylesheet as they are,
 * and `main.ts` with its workspace imports into one ES module. A search index goes in under
 * `index/`, where the page fetches it from.
 *
 * Usage: node apps/site/scripts/build.ts [--out <dir>] [--index <dir>] [--no-minify]
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));

const { values } = parseArgs({
  options: {
    out: { type: "string", default: join(SITE, "dist") },
    index: { type: "string" },
    minify: { type: "boolean", default: true },
  },
  strict: true,
});

await rm(values.out, { recursive: true, force: true });
await mkdir(values.out, { recursive: true });
await cp(join(SITE, "public"), values.out, { recursive: true });

const result = await build({
  entryPoints: [join(SITE, "src", "main.ts"), join(SITE, "src", "bench.ts")],
  outdir: values.out,
  bundle: true,
  format: "esm",
  target: "es2023",
  minify: values.minify,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});

if (values.index !== undefined) {
  await cp(values.index, join(values.out, "index"), { recursive: true });
}

const bytes = async (path: string): Promise<number> => (await stat(path)).size;
const scriptBytes = await bytes(join(values.out, "main.js"));
const inputs = Object.entries(result.metafile.inputs)
  .sort(([, left], [, right]) => right.bytes - left.bytes)
  .slice(0, 5);

process.stdout.write(
  [
    `Built the site into ${values.out}`,
    `  main.js ${(scriptBytes / 1024).toFixed(1)} KB${values.minify ? " minified" : ""}`,
    ...inputs.map(([path, input]) => `    ${path} ${(input.bytes / 1024).toFixed(1)} KB`),
    `  ${(await readdir(values.out)).length} entries at the top level`,
    "",
  ].join("\n"),
);
