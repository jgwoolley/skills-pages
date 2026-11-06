import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, formatBytes, formatTokens, totalSize, type FileInfo, type InstallData, type SkillSize } from "./install.ts";
import { renderDoc, renderSkillMarkdown, stripFrontmatter } from "./markdown.ts";
import { buildCopyMarketplace, buildMarketplace, type CopyEntry } from "./marketplace.ts";
import { ico, manifest, pngSize, serviceWorker } from "./pwa.ts";
import { headTags, pagePath, robotsTxt, sitemapXml, type SocialImage } from "./seo.ts";
import { zip, type ZipEntry } from "./zip.ts";
import { treeUrl } from "./source.ts";
import type { Catalog, Skill, SourceInfo } from "./types.ts";

/** Package root: the nearest directory above this file with our package.json (works from src/ and dist/src/). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json")) || !existsSync(path.join(dir, "assets", "app.css"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot find the skills-pages package root");
    dir = parent;
  }
  return dir;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

async function write(file: string, data: string | Uint8Array, written: string[], out: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  written.push(path.relative(out, file));
}

/** Copy one skill's files to `dest`, refusing anything that escapes the skill dir. */
async function copySkill(root: string, s: Skill, dest: string): Promise<void> {
  const base = path.join(root, s.dir);
  for (const f of s.files) {
    const from = path.resolve(base, f);
    const to = path.resolve(dest, f);
    if (!from.startsWith(base + path.sep) || !to.startsWith(path.resolve(dest) + path.sep)) throw new Error(`Unsafe path ${f} in ${s.dir}`);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/** Copy a directory tree (regular files only). */
async function copyTree(from: string, to: string): Promise<void> {
  for (const e of await readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b);
    else if (e.isFile()) {
      await mkdir(path.dirname(b), { recursive: true });
      await copyFile(a, b);
    }
  }
}

async function generatorVersion(): Promise<string> {
  try {
    return (JSON.parse(await readFile(path.join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

async function skillVersion(root: string, s: Skill): Promise<string> {
  const h = createHash("sha256");
  for (const f of s.files) h.update(f).update("\0").update(await readFile(path.join(root, s.dir, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

export interface PublishOptions {
  out: string;
  siteUrl: string;
  /** False when siteUrl is a placeholder because the CLI couldn't work out where the site is served. */
  siteUrlKnown?: boolean;
  /** The repo's package.json as a pi/npm package (see InstallData.npm). */
  npm?: InstallData["npm"];
  /** The catalog checkout as git sees it (see InstallData.checkout). */
  checkout?: InstallData["checkout"];
  /** Who built the site (see InstallData.deploy). */
  deploy?: InstallData["deploy"];
  /** The CI run building this site, if any (shown on the build page). */
  ci?: { provider: "github" | "gitlab"; url: string; label: string; pipelineUrl?: string; ref?: string };
  ref?: string;
  /** Marketplace files present in the repo after --write-repo (or already committed). */
  git: InstallData["git"];
}

export interface PublishResult {
  files: string[];
  data: InstallData;
  warnings: string[];
}

export async function publish(cat: Catalog, src: SourceInfo, opts: PublishOptions): Promise<PublishResult> {
  const out = path.resolve(opts.out);
  const files: string[] = [];
  const warnings: string[] = [];
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // `--installed`: skills live in folders on this machine. The site is read elsewhere, so it never shows those paths.
  const installed = !src.remote && src.dir === "/";

  // Content version per skill (also used by the OpenCode index), and per marketplace entry.
  const versions = new Map<string, string>();
  for (const s of cat.skills) versions.set(s.name, await skillVersion(src.dir, s));
  const entryVersion = (e: CopyEntry) =>
    e.skills.length === 1 ? versions.get(e.skills[0]!.name)! : createHash("sha256").update(e.skills.map((x) => `${x.name}:${versions.get(x.name)}`).join("\n")).digest("hex").slice(0, 16);

  // 1. Local marketplace: ./public itself, with relative sources pointing at the skill copies. Claude Code and
  //    oh-my-pi both accept a directory (`plugin marketplace add <dir>`) and read it in place.
  const local = buildCopyMarketplace(cat, src, { mode: "local", version: entryVersion });
  warnings.push(...local.warnings);
  await write(path.join(out, ".claude-plugin", "marketplace.json"), json(local.marketplace), files, out);
  await write(path.join(out, ".omp-plugin", "marketplace.json"), json(local.marketplace), files, out);

  // 2. Claude Code site catalog: each plugin / skill as a zip of exactly its skills, served from this site
  //    (`archive` sources: HTTPS only, not loopback hosts).
  const archives = new Map<string, { url: string; sha256: string; version: string }>();
  const archiveEntries: CopyEntry[] = [
    ...cat.plugins.filter((p) => !p.external && p.skills.length).map((p) => ({ name: p.name, skills: p.skills })),
    ...cat.skills.filter((s) => !s.entryIsPlugin).map((s) => ({ name: s.entry, skills: [s] })),
  ];
  for (const e of archiveEntries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name)) throw new Error(`Can't publish "${e.name}" as an archive: unusual characters in the name`);
    const entries: ZipEntry[] = [];
    for (const sk of e.skills) for (const f of sk.files) entries.push({ path: `skills/${sk.name}/${f}`, data: await readFile(path.join(src.dir, sk.dir, f)) });
    const data = zip(entries);
    const file = path.join(out, "claude", "archives", `${e.name}.zip`);
    await write(file, data, files, out);
    archives.set(e.name, { url: `${opts.siteUrl}claude/archives/${encodeURIComponent(e.name)}.zip`, sha256: createHash("sha256").update(data).digest("hex"), version: entryVersion(e) });
  }
  const site = buildCopyMarketplace(cat, src, { mode: "archive", version: entryVersion, archive: (e) => archives.get(e.name)! });
  await write(path.join(out, "claude", "marketplace.json"), json(site.marketplace), files, out);
  const json_: InstallData["json"] = { claudeSkills: site.skillEntries, ompSkills: [] };

  // 3. Agent-skills discovery index (v0.2.0) for the skills CLI: `npx skills add <site>` finds it at
  //    <site>/.well-known/agent-skills/index.json; each entry is a zip with SKILL.md at its root, plus a sha256 digest.
  const wellKnown: { $schema: string; skills: { name: string; type: "archive"; description: string; url: string; digest: string }[] } = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [],
  };
  for (const sk of cat.skills) {
    const entries: ZipEntry[] = [];
    for (const f of sk.files) entries.push({ path: f, data: await readFile(path.join(src.dir, sk.dir, f)) });
    const data = zip(entries);
    await write(path.join(out, ".well-known", "agent-skills", `${sk.name}.zip`), data, files, out);
    // The skills CLI drops index entries whose description is over the spec's 1024 characters; the zip keeps the full SKILL.md.
    const description = sk.description.length > 1024 ? `${sk.description.slice(0, 1023)}…` : sk.description;
    wellKnown.skills.push({ name: sk.name, type: "archive", description, url: `${sk.name}.zip`, digest: `sha256:${createHash("sha256").update(data).digest("hex")}` });
  }
  await write(path.join(out, ".well-known", "agent-skills", "index.json"), json(wellKnown), files, out);

  // 4. oh-my-pi site catalog: it has no archive source, so it keeps git sources and needs a remote.
  if (src.remote) {
    for (const mode of ["https", "ssh"] as const) {
      const r = buildMarketplace(cat, src, { mode, ref: opts.ref });
      if (mode === "https") json_.ompSkills = r.skillEntries;
      await write(path.join(out, "omp", `marketplace${mode === "ssh" ? ".ssh" : ""}.json`), json(r.marketplace), files, out);
    }
  }

  // OpenCode: <site>/index.json + <site>/<name>/<file>, and a one-skill index per skill under opencode/<name>/.
  const index: { skills: { name: string; version: string; description: string; files: string[] }[] } = { skills: [] };
  for (const s of cat.skills) {
    const item = { name: s.name, version: versions.get(s.name)!, description: s.description, files: s.files };
    index.skills.push(item);
    await copySkill(src.dir, s, path.join(out, s.name));
    await copySkill(src.dir, s, path.join(out, "opencode", s.name, s.name));
    await write(path.join(out, "opencode", s.name, "index.json"), json({ skills: [item] }), files, out);
  }
  await write(path.join(out, "index.json"), json(index), files, out);
  files.push(...cat.skills.map((s) => `${s.name}/…`));

  // Context-window estimate per skill.
  const sizes = new Map<string, SkillSize>();
  const fileInfo = new Map<string, FileInfo[]>();
  for (const s of cat.skills) {
    let bytes = 0;
    const info: FileInfo[] = [];
    for (const f of s.files) {
      const buf = await readFile(path.join(src.dir, s.dir, f));
      bytes += buf.length;
      // Binary if there's a NUL byte early on (same heuristic as git).
      const binary = buf.subarray(0, 8000).includes(0);
      info.push({ path: f, bytes: buf.length, tokens: binary ? null : estimateTokens(buf.toString("utf8")) });
    }
    fileInfo.set(s.name, info);
    const md = await readFile(path.join(src.dir, s.dir, "SKILL.md"), "utf8");
    sizes.set(s.name, { always: estimateTokens(`${s.name}: ${s.description}`), invoke: estimateTokens(stripFrontmatter(md)), bytes });
  }

  const data: InstallData = {
    name: cat.name,
    title: cat.title,
    siteUrl: opts.siteUrl,
    repo: src.remote
      ? { https: src.remote.httpsUrl, ssh: src.remote.sshUrl, web: src.remote.webUrl, blob: `${src.remote.webUrl}/${src.remote.isGitLab ? "-/blob" : "blob"}/${opts.ref ?? "HEAD"}/` }
      : null,
    git: opts.git,
    json: json_,
    // Archive sources must be HTTPS and not loopback; the local marketplace only makes sense on this machine.
    siteArchives: /^https:\/\//.test(opts.siteUrl) && !LOOPBACK.test(opts.siteUrl),
    siteUrlKnown: opts.siteUrlKnown ?? true,
    ...(installed ? { installed: true } : {}),
    ...(opts.deploy ? { deploy: opts.deploy } : {}),
    ...(opts.checkout ? { checkout: opts.checkout } : {}),
    ...(opts.npm ? { npm: opts.npm } : {}),
    piPackage: cat.piPackage,
    mixedLayout: cat.plugins.some((p) => p.root && p.skills.length) && cat.plugins.some((p) => !p.root && !p.external && p.skills.length),
    plugins: cat.plugins.map((p) => ({
      name: p.name,
      description: p.description,
      skills: p.skills.map((s) => s.name),
      ...(p.external ? { external: true } : {}),
    })),
    skills: cat.skills.map((s) => ({
      name: s.name,
      entry: s.entry,
      plugin: s.plugin,
      description: s.description,
      tags: s.tags,
      dir: installed ? s.name : s.dir,
      files: s.files,
      ...(src.remote ? { url: treeUrl(src.remote, opts.ref, s.dir) } : {}),
      size: sizes.get(s.name)!,
    })),
  };

  // Static site: page + CSS + the browser build of install.ts / site-app.ts.
  const pkg = packageRoot();
  const jsDir = path.join(pkg, "dist", "src");
  if (!existsSync(path.join(jsDir, "site-app.js"))) throw new Error("Run `npm run build` first: the site needs the compiled browser scripts in dist/src");
  // Icons and the social card; the catalog repo's own card wins. Set before rendering: every page links to it.
  await copyTree(path.join(pkg, "assets", "icons"), path.join(out, "assets", "icons"));
  social = DEFAULT_SOCIAL;
  for (const f of ["og-image.png", ".github/og-image.png"]) {
    const own = path.join(src.dir, f);
    if (!existsSync(own)) continue;
    const bytes = new Uint8Array(await readFile(own));
    const size = pngSize(bytes);
    if (!size) {
      warnings.push(`${f} isn't a PNG; using the default social card`);
      break;
    }
    await write(path.join(out, "assets", "og-image.png"), bytes, files, out);
    social = { path: "assets/og-image.png", ...size, alt: cat.title };
    break;
  }
  await write(path.join(out, "assets", "app.css"), await readFile(path.join(pkg, "assets", "app.css")), files, out);
  await write(path.join(out, "assets", "app.js"), await readFile(path.join(jsDir, "site-app.js")), files, out);
  await write(path.join(out, "assets", "install.js"), await readFile(path.join(jsDir, "install.js")), files, out);
  await write(path.join(out, "index.html"), renderPage(cat, src, data), files, out);
  await write(path.join(out, "plugins", "index.html"), renderPluginsPage(cat, src, data), files, out);
  for (const p of cat.plugins) {
    if (pageable(p.name)) await write(path.join(out, "plugins", p.name, "index.html"), renderPluginPage(cat, src, data, p), files, out);
    else warnings.push(`Plugin "${p.name}" has no page: its name isn't usable as a folder name`);
  }
  for (const sk of cat.skills) {
    const md = await readFile(path.join(src.dir, sk.dir, "SKILL.md"), "utf8");
    await write(path.join(out, "skill", sk.name, "index.html"), renderSkillPage(cat, src, data, sk, md, fileInfo.get(sk.name)!), files, out);
  }
  await write(path.join(out, "build", "index.html"), renderBuildPage(cat, src, data, opts, await generatorVersion()), files, out);
  await write(path.join(out, "tester", "index.html"), renderTesterPage(cat, src, data), files, out);
  // skills-pages' install guide, shipped with the CLI (docs/install.md).
  const guide = path.join(pkg, "docs", "install.md");
  if (existsSync(guide)) await write(path.join(out, "docs", "install", "index.html"), renderDocsPage(cat, src, data, await readFile(guide, "utf8")), files, out);
  // Tester scripts: its own module, the shared modules it imports, and a vendored YAML parser (no CDN).
  for (const f of ["tester.js", "checks.js", "marketplace.js"]) await write(path.join(out, "assets", f), await readFile(path.join(jsDir, f)), files, out);
  // Wherever npm put the `yaml` dependency (nested or hoisted into a project's node_modules).
  const yamlDir = path.dirname(createRequire(import.meta.url).resolve("yaml/package.json"));
  await copyTree(path.join(yamlDir, "browser", "dist"), path.join(out, "assets", "vendor", "yaml"));
  await writeAppFiles(cat, src, data, out, files);
  await write(path.join(out, ".nojekyll"), "", files, out);
  return { files, data, warnings };
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

/** The social card (Open Graph / Twitter). The catalog repo can supply its own: og-image.png or .github/og-image.png. */
const DEFAULT_SOCIAL: SocialImage = { path: "assets/icons/og.png", width: 1200, height: 630, alt: "Agent skills: browse, test and install skills" };
let social: SocialImage = DEFAULT_SOCIAL;

/** Search engines may index the site: it has a real, public URL (not a preview or a placeholder). */
const indexable = (d: InstallData) => d.siteUrlKnown !== false && !LOOPBACK.test(d.siteUrl);

/** One timestamp for every page of a build (and the build page). */
const BUILT_AT = new Date().toISOString().replace(/\.\d+Z$/, "Z");

const LOOPBACK = /^https?:\/\/(localhost|127\.[0-9.]+|\[::1\])(:\d+)?\//i;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ext = (href: string, text: string, cls = "") =>
  `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Which page the browser script is driving, and the relative path back to the site root. */
export interface PageInfo {
  kind: "catalog" | "skill" | "plugins" | "plugin" | "build" | "tester" | "docs";
  skill?: string;
  plugin?: string;
  /** "" for the root page, "../" for plugins/, "../../" for skill/<name>/. */
  root: string;
}

interface LayoutOptions {
  title: string;
  /** Catalog title, shown in the navbar. */
  siteTitle: string;
  /** Override the page's Content-Security-Policy (the tester needs to fetch the URLs you enter). */
  csp?: string;
  /** Extra module scripts, relative to the site root. */
  scripts?: string[];
  description: string;
  page: PageInfo;
  data: InstallData;
  body: string;
}

function layout(src: SourceInfo, o: LayoutOptions): string {
  const r = o.page.root;
  const built = BUILT_AT;
  // Only link when git told us both the commit and the origin; otherwise plain text.
  const sha = src.sha?.slice(0, 12);
  const builtText = `Built <span id="build-footer-time">just now</span>`;
  // Links to the build page (source, commit, CI run), which lives on this site.
  const footerInner = `<a id="build-footer-link" href="${r}build/" title="Build details${sha ? `: ${esc(sha)}` : ""}">${builtText}</a>`;
  const csp = o.csp ?? CSP;
  // Data block: not executed, so the strict CSP still holds. `<` is escaped so it can't close the tag.
  const payload = JSON.stringify({ ...o.data, page: o.page }).replace(/</g, "\\u003c");
  // Site navigation stays in the same tab (every other link opens a new one).
  const navLink = (href: string, label: string, on: boolean, cls = "") => `<a href="${href}"${cls ? ` class="${cls}"` : ""}${on ? ' aria-current="page"' : ""}>${label}</a>`;
  const menuOn = o.page.kind === "docs" || o.page.kind === "tester" || o.page.kind === "build";
  const nav = `<nav class="topnav" aria-label="Site">
  <div class="wrap">
    <a class="brand" href="${r || "./"}"><img class="brand-icon" src="${r}assets/icons/icon.svg" alt="" width="26" height="26"><span class="brand-name">${esc(o.siteTitle)}</span></a>
    ${navLink(r || "./", "Skills", o.page.kind === "catalog" || o.page.kind === "skill")}
    ${navLink(`${r}plugins/`, "Plugins", o.page.kind === "plugins" || o.page.kind === "plugin")}
    <span class="spacer"></span>
    <details class="nav-menu">
      <summary aria-label="More pages"${menuOn ? ' class="on"' : ""}><span class="burger" aria-hidden="true"></span></summary>
      <div class="nav-menu-list">
        ${navLink(`${r}docs/install/`, "Docs", o.page.kind === "docs")}
        ${navLink(`${r}tester/`, "Tester", o.page.kind === "tester")}
        ${navLink(`${r}build/`, "Source", o.page.kind === "build")}
      </div>
    </details>
  </div>
</nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${esc(o.title)}</title>
${headTags({ title: o.title, description: o.description, siteTitle: o.siteTitle, page: o.page, data: o.data, indexable: indexable(o.data), image: social, modified: src.commitDate })}
<link rel="stylesheet" href="${r}assets/app.css">
<script type="module" src="${r}assets/app.js"></script>
${(o.scripts ?? []).map((x) => `<script type="module" src="${r}${x}"></script>`).join("\n")}
</head>
<body>
${nav}
${o.body}
<script type="application/json" id="catalog-data">${payload}</script>
<!-- build footer: filled in at build time (script lives in assets/app.js for the CSP) -->
<footer id="build-footer" data-built="${built}">
  ${footerInner}
</footer>
</body>
</html>
`;
}

function installSection(heading: string): string {
  return `<section class="card" id="install" aria-labelledby="install-title">
    <div class="card-head">
      <h2 id="install-title">${heading}</h2>
      <div class="toggles">
        <label class="agent-select"><span>Agent</span><select id="agent" aria-label="Agent"></select></label>
        <div class="seg" role="radiogroup" aria-label="Git protocol" data-setting="protocol">
          <button type="button" role="radio" data-value="https">HTTPS</button><button type="button" role="radio" data-value="ssh">SSH</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="Install scope" data-setting="scope">
          <button type="button" role="radio" data-value="global">Global</button><button type="button" role="radio" data-value="project">Project</button>
        </div>
      </div>
    </div>
    <p class="context-estimate" id="context-estimate"></p>
    <div class="methods">
      <span class="methods-label" id="method-label">Install method</span>
      <div class="tabs" id="methods" role="tablist" aria-labelledby="method-label"></div>
    </div>
    <div class="guide" id="guide" role="tabpanel" aria-live="polite"></div>
  </section>`;
}

export function renderPage(cat: Catalog, src: SourceInfo, data: InstallData): string {
  const repoLink = src.remote ? ext(src.remote.webUrl, `${esc(src.remote.host)}/${esc(src.remote.owner)}/${esc(src.remote.repo)}`, "repo") : "";
  const body = `<header class="hero">
  <div class="wrap">
    <p class="eyebrow">Agent skills catalog</p>
    <h1>${esc(cat.title)}</h1>
    <p class="lede">${esc(cat.description ?? "Skills for Claude Code, OpenCode, pi and oh-my-pi.")}</p>
    <p class="meta"><span>${plural(cat.skills.length, "skill")}</span><span>${plural(cat.plugins.length, "plugin")}</span>${repoLink}</p>
  </div>
</header>
<main class="wrap">
  ${installSection("Install the catalog")}

  <section class="card" aria-labelledby="skills-title">
    <div class="card-head">
      <h2 id="skills-title">Skills</h2>
      <input id="filter" type="search" placeholder="Filter skills…" aria-label="Filter skills" autocomplete="off">
    </div>
    <div class="active-filters" id="active-filters" aria-label="Active filters" hidden></div>
    <div class="table-wrap">
      <table id="skills">
        <thead><tr><th scope="col">Skill</th><th scope="col" class="plugin">Plugin</th><th scope="col" class="tags-cell">Tags</th><th scope="col">Description</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="empty" id="empty" hidden>No skills match.</p>
    </div>
    <nav class="pager" id="pager" aria-label="Skills pages"></nav>
  </section>

  <section class="card files" aria-labelledby="files-title">
    <h2 id="files-title">Generated files</h2>
    <ul>
      <li>${ext(".claude-plugin/marketplace.json", "<code>.claude-plugin/marketplace.json</code>")} · ${ext(".omp-plugin/marketplace.json", "<code>.omp-plugin/</code>")}: local marketplace (this folder) for Claude Code and oh-my-pi</li>
      <li>${ext("claude/marketplace.json", "<code>claude/marketplace.json</code>")}: Claude Code marketplace (zip archives in <code>claude/archives/</code>)</li>
      ${src.remote ? `<li>${ext("omp/marketplace.json", "<code>omp/marketplace.json</code>")} · ${ext("omp/marketplace.ssh.json", "<code>.ssh.json</code>")}: oh-my-pi marketplace (git sources)</li>` : ""}
      <li>${ext("index.json", "<code>index.json</code>")}: OpenCode skills index</li>
    </ul>
  </section>
</main>`;
  return layout(src, {
    title: `${cat.title} · agent skills`,
    siteTitle: cat.title,
    description: cat.description ?? `Agent skills from ${cat.title}`,
    page: { kind: "catalog", root: "" },
    data,
    body,
  });
}

/** Static page for one skill: details, install guides scoped to it, files and a SKILL.md preview. */
export function renderSkillPage(cat: Catalog, src: SourceInfo, data: InstallData, skill: Skill, skillMd: string, files: FileInfo[] = []): string {
  const r = "../../";
  const info = data.skills.find((x) => x.name === skill.name);
  const memberOf = cat.plugins.filter((p) => p.skills.includes(skill)).map((p) => p.name);
  const pluginLinks = memberOf.map((p) => `<a href="${r}${pluginHref(p)}">${esc(p)}</a>`).join(", ");
  const body = `<header class="hero">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${r}">Skills</a></li><li aria-current="page">${esc(skill.name)}</li></ol></nav>
    <p class="eyebrow">Skill · ${esc(memberOf.join(" · "))}</p>
    <h1 class="mono">${esc(skill.name)}</h1>
    <p class="lede">${esc(skill.description || "No description.")}</p>
    ${skill.tags.length ? `<p class="tags" aria-label="Tags">${skill.tags.map((t) => ext(`${r}?tag=${encodeURIComponent(t)}`, esc(t), "tag")).join("")}</p>` : ""}
    <p class="meta"><span>${plural(skill.files.length, "file")}</span><span>${memberOf.length === 1 ? "plugin" : "plugins"} ${pluginLinks}</span>${ext(`${r}${skill.name}/SKILL.md`, "SKILL.md")}${info?.url ? ext(info.url, "Source", "repo") : ""}</p>
  </div>
</header>
<main class="wrap">
  ${installSection(`Install ${esc(skill.name)}`)}

  <section class="card" aria-labelledby="md-title">
    <div class="card-head">
      <h2 id="md-title">SKILL.md</h2>
      ${ext(`${r}${skill.name}/SKILL.md`, "View source", "hint-link")}
    </div>
    <article class="markdown">${renderSkillMarkdown(skillMd, { fileBase: `${r}${skill.name}/` })}</article>
  </section>

  <section class="card" aria-labelledby="files-title">
    <div class="card-head"><h2 id="files-title">Files</h2><span class="muted">${plural(files.length, "file")} · ${formatBytes(files.reduce((n, f) => n + f.bytes, 0))}</span></div>
    <p class="hint files-hint">OpenCode index for just this skill: ${ext(`${r}opencode/${skill.name}/index.json`, `<code>opencode/${esc(skill.name)}/index.json</code>`)}</p>
    <div class="table-wrap">
      <table id="files">
        <thead><tr><th scope="col">File</th><th scope="col" class="num-col">Size</th><th scope="col" class="num-col" title="Estimated at ~4 characters per token, if the agent reads the file">≈ Tokens</th></tr></thead>
        <tbody>
        ${files
          .map(
            (f) =>
              `<tr><td class="file">${ext(`${r}${skill.name}/${f.path}`, `<code>${esc(f.path)}</code>`)}${f.path === "SKILL.md" ? ' <span class="kind">main</span>' : ""}</td><td class="num-col">${formatBytes(f.bytes)}</td><td class="num-col">${f.tokens === null ? '<span class="muted" title="Binary file">–</span>' : formatTokens(f.tokens)}</td></tr>`,
          )
          .join("\n        ")}
        </tbody>
      </table>
    </div>
    <nav class="pager" id="files-pager" aria-label="File pages"></nav>
  </section>
</main>`;
  return layout(src, {
    title: `${skill.name} · ${cat.title}`,
    description: skill.description || `The ${skill.name} skill`,
    siteTitle: cat.title,
    page: { kind: "skill", skill: skill.name, root: r },
    data: { ...data, skills: info ? [info] : [] }, // only this skill: keeps pages small for big catalogs
    body,
  });
}

function contextCell(sizes: SkillSize[]): string {
  if (!sizes.length) return `<span class="muted">–</span>`;
  const t = totalSize(sizes);
  return `<div><strong>${formatTokens(t.always)}</strong> <span class="muted">always</span></div><div><strong>${formatTokens(t.invoke)}</strong> <span class="muted">when used</span></div><div class="muted">${formatBytes(t.bytes)} on disk</div>`;
}

/** Plugin names become folder names; anything unusual gets no page (it's still listed). */
const pageable = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
const pluginHref = (name: string) => (pageable(name) ? `plugins/${encodeURIComponent(name)}/` : `plugins/#plugin-${encodeURIComponent(name)}`);

const pluginKind = (p: Catalog["plugins"][number]) => (p.external ? "other repo" : p.entry ? "repo marketplace" : p.root ? "root skills/" : "folder");
const pluginWhere = (p: Catalog["plugins"][number], src: SourceInfo) => {
  if (p.external) {
    const s = p.entry?.source as { repo?: string; url?: string } | undefined;
    return esc(s?.repo ?? s?.url ?? "");
  }
  // Installed skills (no repo) live on the machine that built the site; readers elsewhere don't need that path.
  if (!src.remote && src.dir === "/") return "installed";
  return `<code>${esc(p.dir === "." ? "./" : `${p.dir}/`)}</code>`;
};

/** Static page for one plugin: details, install guides scoped to it, and its skills. */
export function renderPluginPage(cat: Catalog, src: SourceInfo, data: InstallData, plugin: Catalog["plugins"][number]): string {
  const r = "../../";
  const members = data.skills.filter((s) => plugin.skills.some((m) => m.name === s.name));
  const tags = [...new Set(plugin.skills.flatMap((s) => s.tags))];
  const rows = members
    .map(
      (s) => `<tr><td class="name"><a href="${r}skill/${encodeURIComponent(s.name)}/">${esc(s.name)}</a></td><td class="desc"><div title="${esc(s.description)}">${esc(s.description)}</div></td></tr>`,
    )
    .join("\n        ");
  const body = `<header class="hero">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${r}plugins/">Plugins</a></li><li aria-current="page">${esc(plugin.name)}</li></ol></nav>
    <p class="eyebrow">Plugin · ${pluginKind(plugin)}</p>
    <h1 class="mono">${esc(plugin.name)}</h1>
    <p class="lede">${esc(plugin.description || "No description.")}</p>
    ${tags.length ? `<p class="tags" aria-label="Tags">${tags.map((t) => ext(`${r}?tag=${encodeURIComponent(t)}`, esc(t), "tag")).join("")}</p>` : ""}
    <p class="meta"><span>${plural(plugin.skills.length, "skill")}</span><span>${pluginWhere(plugin, src)}</span>${plugin.skills.length ? `<a href="${r}?plugin=${encodeURIComponent(plugin.name)}">View in the skills table</a>` : ""}</p>
  </div>
</header>
<main class="wrap">
  ${installSection(`Install ${esc(plugin.name)}`)}
  <section class="card" aria-labelledby="members-title">
    <h2 id="members-title">Skills in ${esc(plugin.name)}</h2>
    ${
      members.length
        ? `<div class="table-wrap members-table"><table>
        <thead><tr><th scope="col">Skill</th><th scope="col">Description</th></tr></thead>
        <tbody>
        ${rows}
        </tbody>
      </table></div>`
        : `<p class="muted">${plugin.external ? "This plugin lives in another repository, so its skills aren't listed here." : "This plugin has no skills (it may provide commands, agents or hooks)."}</p>`
    }
  </section>
</main>`;
  return layout(src, {
    title: `${plugin.name} · ${cat.title}`,
    siteTitle: cat.title,
    description: plugin.description || `The ${plugin.name} plugin`,
    page: { kind: "plugin", plugin: plugin.name, root: r },
    data: { ...data, skills: members },
    body,
  });
}

/** Static table of plugins: kind, description, skill count (with a link to the filtered skills table) and context size. */
export function renderPluginsPage(cat: Catalog, src: SourceInfo, data: InstallData): string {
  const r = "../";
  const kind = pluginKind;
  const where = (p: Catalog["plugins"][number]) => pluginWhere(p, src);
  const rows = cat.plugins
    .map(
      (p) => `<tr id="plugin-${esc(p.name)}">
          <td class="name">${pageable(p.name) ? `<a href="${r}${pluginHref(p.name)}">${esc(p.name)}</a>` : esc(p.name)}</td>
          <td><span class="kind">${kind(p)}</span><div class="where">${where(p)}</div></td>
          <td class="desc"><div>${esc(p.description ?? "")}</div></td>
          <td class="members">${
            p.skills.length
              ? `<strong>${plural(p.skills.length, "skill")}</strong><br><a class="filter-link" href="${r}?plugin=${encodeURIComponent(p.name)}">View in the table →</a>`
              : `<span class="muted">No skills listed${p.external ? " (lives in another repo)" : ""}</span>`
          }</td>
          <td class="context">${contextCell(p.skills.map((s) => data.skills.find((x) => x.name === s.name)!.size))}</td>
        </tr>`,
    )
    .join("\n        ");
  const body = `<header class="hero">
  <div class="wrap">
    <p class="eyebrow">Agent skills catalog</p>
    <h1>Plugins</h1>
    <p class="lede">${plural(cat.plugins.length, "plugin")} in ${esc(cat.title)}${cat.existing.claude || cat.existing.omp ? ", taken from the repo's own marketplace where it has one" : ""}.</p>
  </div>
</header>
<main class="wrap">
  <section class="card" aria-labelledby="plugins-title">
    <div class="card-head"><h2 id="plugins-title">All plugins</h2></div>
    <div class="table-wrap">
      <table id="plugins">
        <thead><tr><th scope="col">Plugin</th><th scope="col">Kind</th><th scope="col">Description</th><th scope="col">Skills</th><th scope="col" title="Estimated at ~4 characters per token">Context</th></tr></thead>
        <tbody>
        ${rows}
        </tbody>
      </table>
    </div>
  </section>
</main>`;
  return layout(src, {
    title: `Plugins · ${cat.title}`,
    siteTitle: cat.title,
    description: `Plugins in ${cat.title}`,
    page: { kind: "plugins", root: r },
    data: { ...data, skills: [] }, // the page is static; keep the payload small
    body,
  });
}

/** "2026-11-06 10:25 UTC" plus a live "(3 days ago)". */
const when = (iso: string) =>
  `<time datetime="${esc(iso)}">${esc(iso.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, " UTC").replace(/([+-]\d\d:\d\d)$/, " $1"))}</time> <span class="ago" data-since="${esc(iso)}"></span>`;

/** Build details: when, from which commit (and whether it was clean), and which CI run built it. */
export function renderBuildPage(cat: Catalog, src: SourceInfo, data: InstallData, opts: PublishOptions, version: string): string {
  const r = "../";
  const row = (k: string, v: string) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  // The repo whose commit built the site: the catalog repo, or (installed skills) the repo the site is built in.
  const g = src.sha || src.remote ? src : (src.host ?? src);
  const installedSkills = !src.remote && src.dir === "/";
  const sha = g.sha;
  const repoCell = g.remote ? ext(g.remote.webUrl, esc(`${g.remote.host}/${g.remote.owner}/${g.remote.repo}`)) : '<span class="muted">No remote</span>';
  const commit = sha ? (g.commitUrl ? ext(g.commitUrl, `<code>${esc(sha.slice(0, 12))}</code>`) : `<code>${esc(sha.slice(0, 12))}</code>`) : undefined;
  const stale =
    g.dirty === true
      ? `<span class="flag flag-warn">⚠ Uncommitted changes</span> <span class="muted">The working tree had changes that weren't committed when the site was built, so the published files may differ from this commit.</span>`
      : g.dirty === false
        ? `<span class="flag flag-ok">✓ Clean</span> <span class="muted">Built from exactly this commit.</span>`
        : `<span class="muted">Unknown</span>`;
  const note = installedSkills
    ? [row("Skills", '<span class="muted">Installed on the machine that built the site, not taken from a repository.</span>')]
    : [];
  const sourceRows = sha
    ? [
        row(installedSkills ? "Site repository" : "Repository", repoCell),
        ...note,
        row("Commit", `${commit}${g.commitSubject ? ` <span class="muted">${esc(g.commitSubject)}</span>` : ""}${g.commitUrl ? "" : ' <span class="muted">(no GitHub/GitLab link: the origin remote is unknown)</span>'}`),
        ...(g.commitDate ? [row("Commit date", when(g.commitDate))] : []),
        ...(g.branch || opts.ci?.ref ? [row("Branch", `<code>${esc(g.branch ?? opts.ci!.ref!)}</code>`)] : []),
        row("Working tree", stale),
      ]
    : [
        row(installedSkills ? "Site repository" : "Repository", g.remote ? repoCell : '<span class="muted">None</span>'),
        ...note,
        row(
          "Commit",
          g.remote
            ? `<span class="flag flag-warn">⚠ No commits yet</span> <span class="muted">The repository has an origin but no commits. Commit and push, and the next build links the commit here.</span>`
            : `<span class="muted">${installedSkills ? "None: the site wasn't built inside a git repository." : "Unknown: the source isn't a git checkout with commits."}</span>`,
        ),
      ];
  const ciRows = opts.ci
    ? [
        row("Provider", opts.ci.provider === "github" ? "GitHub Actions" : "GitLab CI/CD"),
        row("Run", ext(opts.ci.url, esc(opts.ci.label))),
        ...(opts.ci.pipelineUrl ? [row("Pipeline", ext(opts.ci.pipelineUrl, "View pipeline"))] : []),
        ...(opts.ci.ref ? [row("Ref", `<code>${esc(opts.ci.ref)}</code>`)] : []),
      ]
    : [row("Run", '<span class="muted">Built outside CI/CD, so there\'s no run to link.</span>')];
  const body = `<header class="hero">
  <div class="wrap">
    <p class="eyebrow">Source</p>
    <h1>Build details</h1>
    <p class="lede">When and from what this catalog was generated.</p>
  </div>
</header>
<main class="wrap">
  <section class="card" aria-labelledby="b-title">
    <h2 id="b-title">Build</h2>
    <table class="kv">
      ${row("Built", when(BUILT_AT))}
      ${row("Site URL", data.siteUrlKnown === false ? `<code>${esc(data.siteUrl)}</code> <span class="flag flag-warn">⚠ Placeholder</span> <span class="muted">The site URL wasn't known; rebuild with <code>--base-url</code>.</span>` : `<code>${esc(data.siteUrl)}</code>`)}
      ${row("Generator", `skills-pages ${esc(version)} <span class="muted">·</span> <a href="${r}docs/install/">How to install skills-pages</a>`)}
      ${row("Contents", `${plural(cat.skills.length, "skill")}, ${plural(cat.plugins.length, "plugin")}`)}
    </table>
  </section>
  <section class="card" aria-labelledby="s-title">
    <h2 id="s-title">Source</h2>
    <table class="kv">
      ${sourceRows.join("\n      ")}
    </table>
  </section>
  <section class="card" aria-labelledby="c-title">
    <h2 id="c-title">CI/CD</h2>
    <table class="kv">
      ${ciRows.join("\n      ")}
    </table>
  </section>
</main>`;
  return layout(src, { title: `Build details · ${cat.title}`, siteTitle: cat.title, description: `How ${cat.title} was built`, page: { kind: "build", root: r }, data: { ...data, skills: [] }, body });
}

/**
 * Tester: validates URLs or files in the browser. Its CSP is the one exception to connect-src 'self': it may fetch
 * the http(s) URLs you enter, only when you press Validate.
 */
export function renderTesterPage(cat: Catalog, src: SourceInfo, data: InstallData): string {
  const r = "../";
  const examples: [string, string][] = [
    ["This site's skills index", `${r}.well-known/agent-skills/index.json`],
    ["Claude Code marketplace", `${r}claude/marketplace.json`],
    ["OpenCode index", `${r}index.json`],
    ...(cat.skills[0] ? ([[`${cat.skills[0].name} SKILL.md`, `${r}${cat.skills[0].name}/SKILL.md`]] as [string, string][]) : []),
  ];
  const body = `<header class="hero">
  <div class="wrap">
    <p class="eyebrow">Tester</p>
    <h1>Check a skill</h1>
    <p class="lede">Paste the URL of a SKILL.md, a skill zip, a skills index, a Claude Code / oh-my-pi marketplace, or a catalog site. The browser reads it the way agents would and checks whether it should work.</p>
  </div>
</header>
<main class="wrap">
  <section class="card" aria-labelledby="t-title">
    <h2 id="t-title">URL or file</h2>
    <form id="tester-form" class="tester-form">
      <input id="tester-url" type="url" placeholder="https://example.com/skills/.well-known/agent-skills/index.json" aria-label="URL to check" required>
      <button type="submit" class="primary">Validate</button>
    </form>
    <p class="tester-alt"><label class="file-pick">Or check a file: <input id="tester-file" type="file" accept=".md,.zip,.json,text/markdown,application/zip,application/json"></label></p>
    <p class="hint">Try: ${examples.map(([label, href]) => `<button type="button" class="chip" data-example="${esc(href)}">${esc(label)}</button>`).join(" ")}</p>
    <p class="hint">Requests go only to the URL you enter (and the files it lists), when you press Validate; a file you choose stays in your browser. Git repositories can't be read from a browser, so paste raw file or site URLs. Hosts must allow cross-origin requests (CORS).</p>
  </section>
  <div id="tester-results" aria-live="polite"></div>
</main>`;
  return layout(src, {
    title: `Tester · ${cat.title}`,
    siteTitle: cat.title,
    description: "Check whether a skill, index or marketplace would work",
    page: { kind: "tester", root: r },
    data: { ...data, skills: [] },
    body,
    csp: CSP.replace("connect-src 'self'", "connect-src 'self' https: http:"),
    scripts: ["assets/tester.js"],
  });
}

/** skills-pages' own install guide (docs/install.md), rendered into every generated site. */
export function renderDocsPage(cat: Catalog, src: SourceInfo, data: InstallData, markdown: string): string {
  const r = "../../";
  const html = renderDoc(markdown);
  const toc = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => `<li><a href="#${id}">${t}</a></li>`).join("");
  const body = `<header class="hero">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${r}">Skills</a></li><li aria-current="page">Docs</li></ol></nav>
    <p class="eyebrow">Docs</p>
    <h1>Install skills-pages</h1>
    <p class="lede">This site was generated by skills-pages. Here's how to install it and build a site like this one from your own skills.</p>
  </div>
</header>
<main class="wrap docs-layout">
  ${toc ? `<nav class="card docs-toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${toc}</ul></nav>` : ""}
  <article class="card markdown doc">${html.replace(/^<h1[^>]*>.*?<\/h1>\n?/, "")}</article>
</main>`;
  return layout(src, {
    title: `Install skills-pages · ${cat.title}`,
    siteTitle: cat.title,
    description: "How to install skills-pages",
    page: { kind: "docs", root: r },
    data: { ...data, skills: [] },
    body,
  });
}

/** Installable app and search files: manifest, service worker, favicon.ico, robots.txt, sitemap.xml. */
async function writeAppFiles(cat: Catalog, src: SourceInfo, data: InstallData, out: string, files: string[]): Promise<void> {
  const pkg = packageRoot();
  const description = cat.description ?? `Agent skills from ${cat.title}`;
  await write(path.join(out, "manifest.webmanifest"), manifest({ title: cat.title, description }), files, out);
  await write(path.join(out, "favicon.ico"), ico(new Uint8Array(await readFile(path.join(pkg, "assets", "icons", "icon-32.png")))), files, out);

  // Offline: the app shell up front; skill and plugin pages are cached as they're visited.
  const pages = ["./", "plugins/", "tester/", "build/", ...(existsSync(path.join(out, "docs", "install", "index.html")) ? ["docs/install/"] : [])];
  const assets = ["app.css", "app.js", "install.js", "tester.js", "checks.js", "marketplace.js", "icons/icon.svg", "icons/icon-192.png", "icons/icon-32.png"].map((a) => `assets/${a}`);
  await write(path.join(out, "sw.js"), serviceWorker(`${src.sha?.slice(0, 12) ?? "local"}-${BUILT_AT}`, [...pages, ...assets, "manifest.webmanifest"]), files, out);

  // Search: content pages only (the build and tester pages are noindex).
  const content = [
    { kind: "catalog", root: "" },
    { kind: "plugins", root: "" },
    ...cat.plugins.filter((p) => pageable(p.name)).map((p) => ({ kind: "plugin", plugin: p.name, root: "" })),
    ...cat.skills.map((s) => ({ kind: "skill", skill: s.name, root: "" })),
    ...(pages.includes("docs/install/") ? [{ kind: "docs", root: "" }] : []),
  ] as PageInfo[];
  await write(path.join(out, "robots.txt"), robotsTxt(data.siteUrl, indexable(data)), files, out);
  if (indexable(data)) await write(path.join(out, "sitemap.xml"), sitemapXml(data.siteUrl, content.map(pagePath), src.commitDate), files, out);
}
