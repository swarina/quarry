/**
 * Serving the built site, in one place.
 *
 * Two commands serve these files: `site serve`, for working on search alone, and
 * `pipeline serve-criteria --site`, which serves them beside the criterion path so that asking
 * is same-origin (ADR-0028). They share this module rather than each carrying a copy, because
 * the thing worth not duplicating is the policy below: a second copy would drift, and the one
 * that drifted would be the one serving the page that holds a secret.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * No inline scripts, no third-party code, and nothing may frame the page.
 *
 * `connect-src 'self'` is what keeps the criterion path same-origin: the page may call back to
 * the host it came from and nowhere else, so a secret typed into it cannot be sent to another
 * origin by anything that got into the page.
 */
export const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The headers every page and asset is served with. ADR-0028 rests on these, the content security
 * policy above all, so they are defined once and used by the dev server here and by the deployed
 * site, which applies them through a `_headers` file (`renderHeadersFile`). A second copy is a
 * copy that drifts, and the one that drifts is the one on the page holding a secret.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * The `_headers` file a Cloudflare Workers static-assets deployment reads (verified against the
 * docs on 2026-10-06). `/*` matches every path; the content-addressed index files are also
 * marked immutable, except the manifest that names them, which must not be.
 */
export function renderHeadersFile(): string {
  const block = (pattern: string, headers: Record<string, string>): string =>
    [pattern, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join("\n");
  return `${[
    block("/*", SECURITY_HEADERS),
    // Shards and links are named by the build hash, so they never change under a given name.
    block("/index/*/shards/*", { "cache-control": "public, max-age=31536000, immutable" }),
    block("/index/*/links/*", { "cache-control": "public, max-age=31536000, immutable" }),
  ].join("\n\n")}\n`;
}

/**
 * Answers one request from a directory of built files, or returns false if there is no such
 * file, leaving the caller to decide what that means.
 */
export async function serveStatic(
  directory: string,
  path: string,
  response: ServerResponse,
): Promise<boolean> {
  const decoded = decodeURIComponent(path.split("?")[0] ?? "/");
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const file = join(directory, relative.endsWith("/") ? `${relative}index.html` : relative);
  try {
    const found = await stat(file);
    if (!found.isFile()) return false;
    // A build's index files are content addressed, so they can be cached for as long as anyone
    // likes; the manifest naming them cannot.
    const immutable = relative.startsWith("/index/") && !relative.endsWith("manifest.json");
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      ...SECURITY_HEADERS,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}
