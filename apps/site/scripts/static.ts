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
      "content-security-policy": POLICY,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}
