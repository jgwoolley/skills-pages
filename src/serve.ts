// Tiny static server for previewing the generated site (`--serve`). Local only: binds 127.0.0.1.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** The tester page fetches the URLs you enter: its header policy must allow that too (header and <meta> both apply). */
const TESTER_CSP = CSP.replace("connect-src 'self'", "connect-src 'self' https: http:");

/** Same policy the pages declare in <meta>, plus headers a real deployment should send. */
const HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*", // OpenCode / oh-my-pi fetch index.json and marketplace JSON
  "Cache-Control": "no-store",
};

export function serve(dir: string, port: number): Promise<Server> {
  const root = path.resolve(dir);
  const server = createServer(async (req, res) => {
    let file: string;
    try {
      file = path.join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    } catch {
      return void res.writeHead(400).end();
    }
    if (file !== root && !file.startsWith(root + path.sep)) return void res.writeHead(403).end();
    let st = await stat(file).catch(() => undefined);
    if (st?.isDirectory()) {
      file = path.join(file, "index.html");
      st = await stat(file).catch(() => undefined);
    }
    if (!st?.isFile()) return void res.writeHead(404, { ...HEADERS, "Content-Type": "text/plain" }).end("Not found");
    const tester = path.relative(root, file).split(path.sep)[0] === "tester";
    res.writeHead(200, {
      ...HEADERS,
      ...(tester ? { "Content-Security-Policy": TESTER_CSP } : {}),
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "text/plain; charset=utf-8",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
