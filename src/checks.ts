// Skill checks shared by the browser tester and `skills-pages check`: they read a SKILL.md, zip, skills index,
// marketplace or catalog site the way agents would, and report what would break. No Node or DOM APIs here; the
// YAML parser and the reader (fetch, or files in Node) are configured by the caller.
import { estimateTokens, formatBytes, formatTokens } from "./install.ts";
import { reservedMarketplaceName, reservedPluginName } from "./marketplace.ts";

export type Status = "ok" | "warn" | "fail" | "info";
export interface Check {
  status: Status;
  text: string;
}
export interface Report {
  title: string;
  kind: string;
  checks: Check[];
  children: Report[];
}

const MAX_FETCH = 50 * 1024 * 1024;
const MAX_ARTIFACTS = 40; // per index/marketplace, so a huge catalog doesn't trigger hundreds of requests

// ---- tiny helpers ----

export const report = (title: string, kind: string): Report => ({ title, kind, checks: [], children: [] });
export const add = (r: Report, status: Status, text: string) => (r.checks.push({ status, text }), r);
export const worst = (r: Report): Status => {
  const all = [...r.checks.map((c) => c.status), ...r.children.map(worst)];
  return all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : all.includes("ok") ? "ok" : "info";
};

export interface Yaml {
  parse(src: string): unknown;
}

export interface Fetched {
  url: string;
  bytes: Uint8Array;
  contentType: string;
}

/** Where the YAML parser comes from and how URLs are read (the browser uses fetch; the CLI also reads file: URLs). */
const env: { yaml?: () => Promise<Yaml>; read: (url: string) => Promise<Fetched> } = { read: (url) => fetchBytes(url) };
let yamlLib: Promise<Yaml> | undefined;
const yaml = () => (yamlLib ??= env.yaml ? env.yaml() : Promise.reject(new Error("no YAML parser configured")));
export function configure(o: { yaml?: () => Promise<Yaml>; read?: (url: string) => Promise<Fetched> }) {
  if (o.yaml) env.yaml = o.yaml;
  if (o.read) env.read = o.read;
}

export async function fetchBytes(url: string): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const len = Number(res.headers.get("content-length"));
    if (len > MAX_FETCH) throw new Error(`too large (${formatBytes(len)})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_FETCH) throw new Error(`too large (${formatBytes(bytes.length)})`);
    return { url: res.url || url, bytes, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") throw new Error("timed out after 30 s");
    // fetch() rejects with a bare TypeError for CORS and network failures; the browser hides which one.
    if (e instanceof TypeError) throw new Error("the browser couldn't read it: the host may not allow cross-origin requests (CORS), or it's unreachable");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const text = (b: Uint8Array) => new TextDecoder().decode(b);
export const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function sha256Hex(b: Uint8Array): Promise<string | undefined> {
  if (!crypto?.subtle) return undefined; // only in secure contexts (HTTPS or localhost)
  const d = await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- zip reading (central directory + DecompressionStream) ----

interface ZipFile {
  path: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

function readZip(b: Uint8Array): ZipFile[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a readable zip (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives aren't supported by this tester");
  const out: ZipFile[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const path = text(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (path.endsWith("/")) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + csize);
    out.push({
      path,
      size: usize,
      read: async () => {
        if (method === 0) return data;
        if (method !== 8) throw new Error(`unsupported compression method ${method}`);
        const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return out;
}

// ---- SKILL.md ----

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Checks one SKILL.md against the Agent Skills spec and what common agents/tools actually enforce. */
export async function checkSkillMd(md: string, title: string, folder?: string): Promise<Report> {
  const r = report(title, "SKILL.md");
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  if (!m) return add(r, "fail", "No frontmatter: SKILL.md must start with a `---` block containing `name` and `description`.");
  let fm: Record<string, unknown> = {};
  try {
    const data = (await yaml()).parse(m[1]!);
    if (data && typeof data === "object" && !Array.isArray(data)) fm = data as Record<string, unknown>;
    else add(r, "fail", "Frontmatter isn't a key/value mapping.");
  } catch (err) {
    add(r, "warn", `Frontmatter isn't valid YAML (${(err as Error).message.split("\n")[0]}). The skills CLI and some agents skip such skills; quote values that contain \`: \`.`);
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!name) add(r, "fail", "`name` is missing.");
  else {
    if (!KEBAB.test(name)) add(r, "fail", `\`name\` "${name}" must be lowercase letters, digits and single hyphens.`);
    else add(r, "ok", `\`name\`: ${name}`);
    if (name.length > 64) add(r, "fail", `\`name\` is ${name.length} characters; the limit is 64.`);
    if (folder && folder !== name) add(r, "warn", `\`name\` "${name}" differs from its folder "${folder}"; some agents expect them to match.`);
    if (/anthropic|claude/.test(name)) add(r, "warn", "`name` contains \"claude\" or \"anthropic\", which Claude reserves (Claude Code still loads it as a plugin skill).");
  }
  if (!description) add(r, "fail", "`description` is missing; agents use it to decide when to load the skill.");
  else {
    add(r, description.length > 1024 ? "warn" : "ok", `\`description\`: ${description.length} characters${description.length > 1024 ? ", over the spec's 1024: the skills CLI drops such index entries" : ""}.`);
    if (/<[a-z][\s\S]*>/i.test(description)) add(r, "warn", "`description` contains something that looks like an XML/HTML tag, which the spec doesn't allow.");
  }
  const body = md.slice(m[0].length).trim();
  if (!body) add(r, "warn", "The body is empty: the skill has nothing to tell the agent once loaded.");
  add(r, "info", `Context: ${formatTokens(estimateTokens(`${name}: ${description}`))} tokens always loaded, ${formatTokens(estimateTokens(body))} when used (≈4 characters per token).`);
  return r;
}

// ---- zips ----

export async function checkZip(b: Uint8Array, title: string, layout: "skill-root" | "any"): Promise<Report> {
  const r = report(title, "zip");
  let files: ZipFile[];
  try {
    files = readZip(b);
  } catch (err) {
    return add(r, "fail", `Can't read the zip: ${(err as Error).message}.`);
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  add(r, "info", `${files.length} files, ${formatBytes(b.length)} compressed, ${formatBytes(total)} uncompressed.`);
  if (files.length > 1000 || total > 25 * 1024 * 1024 || b.length > 10 * 1024 * 1024)
    add(r, "warn", "Over the skills CLI's default download limits (10 MiB download, 25 MiB extracted, 1000 files).");
  if (files.some((f) => f.path.startsWith("/") || f.path.split("/").includes(".."))) add(r, "fail", "Contains unsafe paths (absolute or `..`).");
  const skillMds = files.filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"));
  if (layout === "skill-root" && !files.some((f) => f.path === "SKILL.md"))
    add(r, "fail", "No SKILL.md at the root of the zip, which the skills CLI requires for an index entry.");
  if (!skillMds.length) return add(r, "fail", "No SKILL.md anywhere in the zip.");
  for (const f of skillMds.slice(0, MAX_ARTIFACTS)) {
    const dir = f.path.split("/").slice(0, -1);
    r.children.push(await checkSkillMd(text(await f.read()), f.path, dir.at(-1)));
  }
  if (skillMds.length > MAX_ARTIFACTS) add(r, "info", `Checked the first ${MAX_ARTIFACTS} of ${skillMds.length} skills.`);
  return r;
}

async function checkArtifact(url: string, title: string, expect: { sha256?: string; layout: "skill-root" | "any" }): Promise<Report> {
  const r = report(title, "artifact");
  let f: Fetched;
  try {
    f = await env.read(url);
  } catch (err) {
    return add(r, "fail", `Couldn't fetch ${url}: ${(err as Error).message}.`);
  }
  if (expect.sha256) {
    const got = await sha256Hex(f.bytes);
    if (!got) add(r, "info", "sha256 not checked: the browser only computes it on HTTPS or localhost pages.");
    else add(r, got === expect.sha256.toLowerCase() ? "ok" : "fail", got === expect.sha256.toLowerCase() ? "sha256 matches." : `sha256 mismatch: got ${got}.`);
  }
  if (isZip(f.bytes)) r.children.push(await checkZip(f.bytes, "contents", expect.layout));
  else r.children.push(await checkSkillMd(text(f.bytes), "SKILL.md"));
  return r;
}

// ---- indexes and marketplaces ----

const isLoopback = (u: URL) => /^(localhost|127\.|\[::1\])/.test(u.host);

async function checkWellKnown(j: { $schema?: unknown; skills: unknown[] }, url: string): Promise<Report> {
  const r = report(url, "agent-skills index (skills CLI)");
  const v2 = typeof j.$schema === "string" && j.$schema.includes("/discovery/0.2.0/");
  add(r, "info", `${j.skills.length} skills, ${v2 ? "discovery format 0.2.0" : "legacy format (name/description/files)"}.`);
  for (const [i, raw] of j.skills.entries()) {
    const e = raw as Record<string, unknown>;
    const c = report(String(e.name ?? `entry ${i}`), "entry");
    if (typeof e.name !== "string" || !KEBAB.test(e.name)) add(c, "fail", "`name` must be a lowercase-hyphenated string.");
    if (typeof e.description !== "string" || !e.description) add(c, "fail", "`description` is missing.");
    else if (e.description.length > 1024) add(c, "fail", `\`description\` is ${e.description.length} characters: the skills CLI drops entries over 1024.`);
    if (v2) {
      if (e.type !== "archive" && e.type !== "skill-md") add(c, "fail", "`type` must be `archive` or `skill-md`.");
      if (typeof e.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(e.digest)) add(c, "fail", "`digest` must be `sha256:<64 hex>`.");
      if (typeof e.url === "string" && i < MAX_ARTIFACTS)
        c.children.push(await checkArtifact(new URL(e.url, url).href, e.url, { sha256: String(e.digest ?? "").replace(/^sha256:/, ""), layout: e.type === "archive" ? "skill-root" : "any" }));
    } else if (Array.isArray(e.files) && typeof e.name === "string" && i < MAX_ARTIFACTS) {
      if (!e.files.includes("SKILL.md")) add(c, "fail", "`files` doesn't list SKILL.md.");
      c.children.push(await checkArtifact(new URL(`${e.name}/SKILL.md`, url).href, "SKILL.md", { layout: "any" }));
    }
    r.children.push(c);
  }
  if (j.skills.length > MAX_ARTIFACTS) add(r, "info", `Downloaded the first ${MAX_ARTIFACTS} skills only.`);
  return r;
}

async function checkOpenCodeIndex(j: { skills: unknown[] }, url: string): Promise<Report> {
  const r = report(url, "OpenCode skills index");
  const base = url.replace(/index\.json(\?.*)?$/, "");
  add(r, "info", `${j.skills.length} skills; OpenCode downloads <base>/<name>/<file> for each.`);
  for (const [i, raw] of j.skills.entries()) {
    const e = raw as Record<string, unknown>;
    const c = report(String(e.name ?? `entry ${i}`), "entry");
    if (typeof e.name !== "string") add(c, "fail", "`name` is missing.");
    if (!Array.isArray(e.files) || !e.files.includes("SKILL.md")) add(c, "fail", "`files` must include SKILL.md, or OpenCode ignores the entry.");
    if (e.version !== undefined && typeof e.version !== "string") add(c, "warn", "`version` should be a string (OpenCode re-downloads when it changes).");
    if (typeof e.name === "string" && i < MAX_ARTIFACTS) c.children.push(await checkArtifact(new URL(`${e.name}/SKILL.md`, base).href, "SKILL.md", { layout: "any" }));
    r.children.push(c);
  }
  return r;
}

async function checkMarketplace(j: Record<string, unknown>, url: string): Promise<Report> {
  const r = report(url, "Claude Code / oh-my-pi marketplace");
  const name = typeof j.name === "string" ? j.name : "";
  if (!name) add(r, "fail", "`name` is missing.");
  else {
    const bad = reservedMarketplaceName(name);
    add(r, bad ? "fail" : "ok", bad ? `Marketplace name "${name}": ${bad}; Claude Code refuses to add it.` : `Marketplace name: ${name}`);
  }
  if (!(j.owner && typeof (j.owner as { name?: unknown }).name === "string")) add(r, "fail", "`owner.name` is missing.");
  const plugins = Array.isArray(j.plugins) ? (j.plugins as Record<string, unknown>[]) : [];
  add(r, plugins.length ? "info" : "fail", `${plugins.length} plugin entries.`);
  let fetched = 0;
  for (const p of plugins) {
    const c = report(String(p.name ?? "?"), "plugin");
    if (typeof p.name === "string" && reservedPluginName(p.name)) add(c, "warn", "Reserved-looking plugin name: Claude Code installs it, but `claude plugin validate` flags it.");
    const src = p.source as string | Record<string, unknown> | undefined;
    if (typeof src === "string") {
      // In .claude-plugin/ or .omp-plugin/ the file is meant for a git repo or folder, where relative sources are right.
      const repoStyle = /\/\.(claude|omp)-plugin\/marketplace\.json$/.test(new URL(url).pathname);
      add(c, repoStyle ? "info" : "warn", repoStyle ? `Relative source \`${src}\` (for use as a git repo or folder marketplace).` : `Relative source \`${src}\`: fine when the marketplace is added as a git repo or folder, but it can't resolve when added by URL.`);
    } else if (src && src.source === "archive") {
      const u = new URL(String(src.url), url);
      if (u.protocol !== "https:" || isLoopback(u))
        // On a local preview that's expected: it works once the site is deployed over HTTPS.
        add(c, isLoopback(new URL(url)) ? "warn" : "fail", `Archive URL ${u.href}: Claude Code only downloads archives over HTTPS from non-loopback hosts${isLoopback(new URL(url)) ? ", so this local preview works once deployed over HTTPS" : ""}.`);
      if (fetched++ < MAX_ARTIFACTS) c.children.push(await checkArtifact(u.href, u.pathname.split("/").pop() ?? "archive", { sha256: typeof src.sha256 === "string" ? src.sha256 : undefined, layout: "any" }));
    } else if (src && ["github", "url", "git-subdir", "git"].includes(String(src.source))) {
      add(c, "info", `Git source (${String(src.source)}): git repositories can't be checked from the browser.`);
    } else if (src) add(c, "info", `Source type \`${String(src.source)}\` isn't checked here.`);
    else add(c, "fail", "`source` is missing.");
    r.children.push(c);
  }
  return r;
}

// ---- entry points ----

/** Repository URLs we can't read from a browser; GitHub blob links are rewritten to raw ones. */
export function normalise(input: string): { url?: string; note?: string; error?: string } {
  const s = input.trim();
  if (/^(git@|ssh:\/\/|git:\/\/)/.test(s) || /\.git\/?$/.test(s))
    return { error: "This is a git repository URL. Git repositories can't be read from a browser; paste a raw file URL (a SKILL.md, a zip, an index.json or a marketplace.json) or a site URL." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "Not a valid URL." };
  }
  if (u.protocol === "file:") return { url: u.href }; // the CLI reads local files
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http(s) URLs can be fetched." };
  const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
  if (u.host === "github.com" && blob) return { url: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`, note: "GitHub page link rewritten to its raw file." };
  if ((u.host === "github.com" || u.host === "gitlab.com") && u.pathname.split("/").filter(Boolean).length <= 2)
    return { error: "This is a repository page. Git repositories can't be read from a browser; paste a raw file URL or the URL of a published catalog site." };
  return { url: u.href };
}

/** Classify fetched bytes and run the matching checks. */
export async function checkBytes(f: Fetched, title: string): Promise<Report> {
  if (isZip(f.bytes)) return checkZip(f.bytes, title, "any");
  const t = text(f.bytes);
  if (/^﻿?---\r?\n/.test(t)) return checkSkillMd(t, title, title.split("/").slice(-2, -1)[0]);
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    const r = report(title, "unknown");
    return add(r, "fail", f.contentType.includes("html") ? "This is an HTML page, not a skill file." : "Not a SKILL.md, zip or JSON index this tester knows.");
  }
  const o = j as Record<string, unknown>;
  if (Array.isArray(o.plugins)) return checkMarketplace(o, f.url);
  if (Array.isArray(o.skills)) {
    const first = (o.skills[0] ?? {}) as Record<string, unknown>;
    if (/\/\.well-known\/(agent-skills|skills)\//.test(f.url) || typeof o.$schema === "string" || "digest" in first)
      return checkWellKnown(o as { skills: unknown[] }, f.url);
    return checkOpenCodeIndex(o as { skills: unknown[] }, f.url);
  }
  return add(report(title, "unknown"), "fail", "JSON, but neither a skills index nor a marketplace.");
}

/** A site URL (HTML page): look for the files a catalog publishes. */
export async function probeSite(base: string): Promise<Report> {
  const r = report(base, "site");
  const root = base.endsWith("/") ? base : `${base.replace(/\/[^/]*$/, "")}/`;
  const paths = [".well-known/agent-skills/index.json", "index.json", "claude/marketplace.json", ".claude-plugin/marketplace.json"];
  let found = 0;
  for (const p of paths) {
    try {
      const f = await env.read(new URL(p, root).href);
      found++;
      r.children.push(await checkBytes(f, p));
    } catch {
      add(r, "info", `No ${p}.`);
    }
  }
  if (!found) add(r, "fail", "No skills index or marketplace found at this URL.");
  return r;
}

export async function checkUrl(input: string): Promise<Report> {
  const n = normalise(input);
  if (n.error) return add(report(input, "url"), "fail", n.error);
  const url = n.url!;
  let f: Fetched;
  try {
    f = await env.read(url);
  } catch (err) {
    return add(report(url, "url"), "fail", `Couldn't fetch it: ${(err as Error).message}.`);
  }
  const looksHtml = f.contentType.includes("text/html") || /^\s*<(!doctype|html)/i.test(text(f.bytes.subarray(0, 200)));
  const r = looksHtml ? await probeSite(url) : await checkBytes(f, url);
  if (n.note) add(r, "info", n.note);
  return r;
}
