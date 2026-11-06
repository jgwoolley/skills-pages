// `skills-pages check`: the tester's checks in the terminal, for URLs and local paths (a SKILL.md, zip, index,
// marketplace, skill folder, built site or whole skills repo). Exit code 1 when something would break.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pc from "picocolors";
import { add, checkBytes, checkSkillMd, checkUrl, configure, fetchBytes, probeSite, report, text, worst, type Fetched, type Report, type Status } from "./checks.ts";
import { discover } from "./discover.ts";

const TYPES: Record<string, string> = { ".html": "text/html", ".json": "application/json", ".md": "text/markdown", ".zip": "application/zip" };

/** Built-site checks map the site's own URLs (siteUrl/…) to the local folder, so a site can be checked before deploying. */
let mapping: { siteUrl: string; dir: string } | undefined;

async function readLocal(file: string): Promise<Fetched> {
  let p = file;
  if ((await stat(p)).isDirectory()) p = path.join(p, "index.html"); // a folder reads like a web server would
  return { url: pathToFileURL(p).href, bytes: new Uint8Array(await readFile(p)), contentType: TYPES[path.extname(p).toLowerCase()] ?? "" };
}

configure({
  yaml: async () => (await import("yaml")) as unknown as { parse(src: string): unknown },
  read: async (url) => {
    if (mapping && url.startsWith(mapping.siteUrl)) return readLocal(path.join(mapping.dir, decodeURIComponent(new URL(url).pathname.slice(new URL(mapping.siteUrl).pathname.length))));
    if (url.startsWith("file:")) {
      try {
        return await readLocal(fileURLToPath(url));
      } catch (err) {
        throw new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (err as Error).message);
      }
    }
    return fetchBytes(url);
  },
});

/** The siteUrl a built site was generated for (from its page data), to map its own URLs to local files. */
async function builtSiteUrl(dir: string): Promise<string | undefined> {
  const index = path.join(dir, "index.html");
  if (!existsSync(index)) return undefined;
  const m = /id="catalog-data">(.*?)<\/script>/s.exec(await readFile(index, "utf8"));
  try {
    return m ? (JSON.parse(m[1]!) as { siteUrl?: string }).siteUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Check one URL or local path. */
export async function checkTarget(target: string): Promise<Report> {
  if (/^https?:\/\//i.test(target) || /^(git@|ssh:\/\/|git:\/\/)/.test(target)) return checkUrl(target);
  const abs = path.resolve(target);
  const st = await stat(abs).catch(() => undefined);
  if (!st) return add(report(target, "path"), "fail", "No such file or folder.");
  if (st.isFile()) return checkBytes(await readLocal(abs), target);

  // A single skill folder.
  if (existsSync(path.join(abs, "SKILL.md"))) return checkSkillMd(text(new Uint8Array(await readFile(path.join(abs, "SKILL.md")))), `${target}/SKILL.md`, path.basename(abs));

  // A built skills-pages site (or any folder serving the catalog files).
  const siteUrl = await builtSiteUrl(abs);
  if (siteUrl || existsSync(path.join(abs, ".well-known", "agent-skills", "index.json"))) {
    mapping = siteUrl ? { siteUrl, dir: abs } : undefined;
    const r = await probeSite(pathToFileURL(abs).href + "/");
    r.title = target;
    if (siteUrl) add(r, "info", `Built for ${siteUrl}; its own URLs were read from this folder.`);
    return r;
  }

  // A skills repository: every SKILL.md, plus the repo's own marketplace files.
  const cat = await discover({ dir: abs, local: true, cleanup: async () => {} });
  const r = report(target, "skills repository");
  if (!cat.skills.length) return add(r, "fail", "No skills found (expected skills/<name>/SKILL.md or plugins/<plugin>/skills/<name>/SKILL.md).");
  add(r, "info", `${cat.skills.length} skills in ${cat.plugins.length} plugins.`);
  for (const w of cat.warnings) add(r, "warn", w);
  for (const s of cat.skills) r.children.push(await checkSkillMd(await readFile(path.join(abs, s.dir, "SKILL.md"), "utf8"), `${s.dir}/SKILL.md`, path.posix.basename(s.dir)));
  for (const f of [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"])
    if (existsSync(path.join(abs, f))) r.children.push(await checkBytes(await readLocal(path.join(abs, f)), f));
  return r;
}

const ICON: Record<Status, string> = { ok: pc.green("✓"), warn: pc.yellow("!"), fail: pc.red("✕"), info: pc.dim("i") };
const color = (t: string) => t.replace(/`([^`]+)`/g, (_, c: string) => pc.cyan(c));

/** Print a report tree. Passing children are collapsed to one line unless `verbose`. */
export function printReport(r: Report, verbose = false, depth = 0, out: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  const status = worst(r);
  out.push(`${pad}${ICON[status]} ${pc.bold(r.title)} ${pc.dim(r.kind)}`);
  const quiet = !verbose && status === "ok" && depth > 0;
  if (!quiet) {
    for (const c of r.checks) if (verbose || c.status !== "ok") out.push(`${pad}  ${ICON[c.status]} ${color(c.text)}`);
    for (const ch of r.children) printReport(ch, verbose, depth + 1, out);
  }
  return out;
}

/** Count statuses over the whole tree (checks only). */
export function tally(r: Report, t: Record<Status, number> = { ok: 0, warn: 0, fail: 0, info: 0 }): Record<Status, number> {
  for (const c of r.checks) t[c.status]++;
  for (const ch of r.children) tally(ch, t);
  return t;
}
