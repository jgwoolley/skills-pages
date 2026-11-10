import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Catalog, Marketplace, Owner, Plugin, Skill, SourceInfo } from "./types.ts";

/** Top-level names in ./public the generator owns; a skill with one of these names would collide. */
export const RESERVED_NAMES = new Set(["assets", "claude", "omp", "opencode", "skill", "plugins", "build", "tester", "docs", "index.html", "index.json", "manifest.webmanifest", "sw.js", "favicon.ico", "robots.txt", "sitemap.xml"]);

export const exists = async (p: string) => !!(await lstat(p).catch(() => undefined));

export async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skills";
}

export interface Frontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** Parse SKILL.md frontmatter. Invalid YAML falls back to plain `key: value` lines and sets `lenient` (non-enumerable). */
export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?(\n|$)/.exec(text);
  if (!m) return {};
  let data: unknown;
  try {
    data = parseYaml(m[1]!);
  } catch {
    // Common in the wild: `description: Do X: then Y` (unquoted colon). Read top-level `key: value` lines verbatim.
    data = Object.fromEntries(
      m[1]!
        .split(/\r?\n/)
        .map((l) => /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l))
        .filter((x) => !!x)
        .map(([, k, v]) => [k, v!.replace(/^(["'])(.*)\1$/, "$2").trim()]),
    );
    Object.defineProperty(data, "lenient", { value: true, enumerable: false });
  }
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Frontmatter) : {};
}

/** Every regular, non-hidden file under `dir`, as POSIX paths relative to it. Symlinks are skipped. */
async function listFiles(dir: string, warnings: string[], rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) warnings.push(`Skipped symlink ${r} in ${path.basename(dir)}`);
    else if (e.isDirectory()) out.push(...(await listFiles(dir, warnings, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Why a folder without SKILL.md isn't a skill, with the likely fix. */
async function whyNotSkill(root: string, dir: string): Promise<string> {
  const abs = path.join(root, dir);
  const children = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const misnamed = children.find((c) => c.isFile() && c.name !== "SKILL.md" && c.name.toLowerCase() === "skill.md");
  if (misnamed) return `${dir}: skipped, the file is named ${misnamed.name}; rename it to SKILL.md (exactly that case)`;
  const parent = path.posix.dirname(dir);
  for (const c of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!c.isDirectory() || c.name.startsWith(".") || c.name === "node_modules") continue;
    if (await exists(path.join(abs, c.name, "SKILL.md")))
      return `${dir}: skipped, it has no SKILL.md, but ${dir}/${c.name}/SKILL.md exists; skills must sit directly in ${parent}/ (move ${c.name} up one level)`;
  }
  return `${dir}: skipped, it has no SKILL.md, so it isn't a skill`;
}

/** Skill folders directly inside `rel`. Folders that look like they should be skills but aren't get a warning saying why. */
async function skillDirs(root: string, rel: string, warnings: string[]): Promise<string[]> {
  const abs = path.join(root, rel);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = `${rel}/${e.name}`;
    if (e.name === "node_modules") continue;
    if (e.isSymbolicLink()) {
      warnings.push(`${dir}: skipped, symlinks aren't followed; put the skill folder itself here`);
      continue;
    }
    if (!e.isDirectory()) continue;
    const skill = await exists(path.join(abs, e.name, "SKILL.md"));
    if (e.name.startsWith(".")) {
      if (skill) warnings.push(`${dir}: skipped, folders starting with "." are hidden from skill discovery; rename it`);
      continue;
    }
    if (skill) dirs.push(dir);
    else warnings.push(await whyNotSkill(root, dir));
  }
  return dirs;
}

/** Normalise tags from a list or a comma-separated string: lowercase, trimmed, unique. */
export function toTags(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const items = Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\[|\]$/g, "").split(",") : [];
    for (const t of items) {
      if (typeof t !== "string" && typeof t !== "number") continue;
      const tag = String(t).trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
      if (tag && tag.length <= 40) out.add(tag);
    }
  }
  return [...out];
}

export async function loadSkill(root: string, dir: string, plugin: string, warnings: string[], pluginTags: string[] = []): Promise<Skill | undefined> {
  const abs = path.join(root, dir);
  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(await readFile(path.join(abs, "SKILL.md"), "utf8"));
  } catch (err) {
    warnings.push(`${dir}/SKILL.md: invalid frontmatter (${(err as Error).message.split("\n")[0]})`);
    return undefined;
  }
  if ((fm as { lenient?: boolean }).lenient)
    warnings.push(`${dir}/SKILL.md: frontmatter isn't valid YAML (quote values containing ": "); read leniently, but the skills CLI and some agents will skip it`);
  const folder = path.posix.basename(dir);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : folder;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    warnings.push(`${dir}: skill name "${name}" is not kebab-case; skipped`);
    return undefined;
  }
  if (name !== folder) warnings.push(`${dir}: frontmatter name "${name}" differs from folder name`);
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) warnings.push(`${dir}: missing description`);
  else if (description.length > 1024)
    warnings.push(`${dir}: description is ${description.length} characters, over the Agent Skills limit of 1024 (some tools drop such skills; the published index shortens it)`);
  const meta = fm.metadata && typeof fm.metadata === "object" ? (fm.metadata as Record<string, unknown>) : {};
  return {
    name,
    description,
    tags: toTags(fm.tags, fm.keywords, meta.tags, meta.keywords, pluginTags),
    dir,
    files: await listFiles(abs, warnings),
    plugin,
    entry: name,
    hasPluginJson: await exists(path.join(abs, ".claude-plugin", "plugin.json")),
  };
}

export interface DiscoverOptions {
  name?: string;
  title?: string;
}

const strings = (v: unknown): string[] | undefined =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Join repo-relative POSIX paths; undefined if the result escapes the repo. */
function within(...parts: string[]): string | undefined {
  const joined = path.posix.normalize(path.posix.join(...parts.map((x) => x.replace(/\\/g, "/"))));
  if (joined.startsWith("..") || path.posix.isAbsolute(joined)) return undefined;
  return joined.replace(/\/+$/, "") || ".";
}
const sub = (dir: string, child: string) => (dir === "." ? child : `${dir}/${child}`);

/**
 * Find skills and group them into plugins.
 * - An existing `.claude-plugin/` or `.omp-plugin/` marketplace is the source of truth: its entries become our plugins,
 *   with names, descriptions, skill membership and every other field preserved.
 * - Skills it doesn't mention are grouped by convention: `plugins/<plugin>/skills/*` per directory, root `skills/*` as one plugin.
 */
export async function discover(src: SourceInfo, opts: DiscoverOptions = {}): Promise<Catalog> {
  const root = src.dir;
  const warnings: string[] = [];
  const claude = await readJson<Marketplace>(path.join(root, ".claude-plugin", "marketplace.json"));
  const omp = await readJson<Marketplace>(path.join(root, ".omp-plugin", "marketplace.json"));
  const existing = claude ?? omp;
  const repoName = src.remote?.repo ?? path.basename(root);
  const name = slugify(opts.name ?? existing?.name ?? repoName);

  // Each skill dir is loaded once, even when several plugins include it.
  const cache = new Map<string, Skill | undefined>();
  const load = async (dir: string, plugin: string, tags: string[]): Promise<Skill | undefined> => {
    if (!cache.has(dir)) cache.set(dir, await loadSkill(root, dir, plugin, warnings));
    const s = cache.get(dir);
    if (s) s.tags = toTags(s.tags, tags);
    return s;
  };
  /** A path that is a skill dir, or a folder of skill dirs. */
  const skillsAt = async (dir: string): Promise<string[]> => ((await exists(path.join(root, dir, "SKILL.md"))) ? [dir] : skillDirs(root, dir, warnings));
  type Manifest = { name?: string; description?: string; keywords?: unknown; skills?: unknown };

  const plugins: Plugin[] = [];
  const covered = new Set<string>(); // plugin dirs whose skills are accounted for

  // 1. Incoming marketplace entries.
  const pluginRootMeta = typeof existing?.metadata?.pluginRoot === "string" ? existing.metadata.pluginRoot : undefined;
  for (const e of existing?.plugins ?? []) {
    if (!e || typeof e.name !== "string") continue;
    if (typeof e.source !== "string") {
      plugins.push({ name: e.name, description: e.description, dir: "", skills: [], hasPluginJson: false, root: false, entry: e, external: true });
      continue;
    }
    const dir = within(pluginRootMeta ?? ".", e.source);
    if (!dir) {
      warnings.push(`Marketplace entry "${e.name}": source ${e.source} is outside the repo; skipped`);
      continue;
    }
    const manifest = await readJson<Manifest>(path.join(root, dir, ".claude-plugin", "plugin.json"));
    const listed = strings(e.skills) ?? strings(manifest?.skills);
    const dirs = new Set<string>();
    for (const p of listed ?? []) {
      const d = within(dir, p);
      if (d) {
        const found = await skillsAt(d);
        if (!found.length) warnings.push(`Marketplace entry "${e.name}": skills path ${p} ${(await exists(path.join(root, d))) ? "has no SKILL.md and no folders with one" : "doesn't exist"}`);
        for (const x of found) dirs.add(x);
      } else warnings.push(`Marketplace entry "${e.name}": skills path ${p} is outside the repo; ignored`);
    }
    // Like Claude Code: a marketplace-root entry with a skills list loads only those; otherwise <dir>/skills/ is scanned too.
    if (!(dir === "." && listed)) for (const x of await skillDirs(root, sub(dir, "skills"), warnings)) dirs.add(x);
    const tags = toTags(manifest?.keywords, e.keywords, e.tags);
    const skills = (await Promise.all([...dirs].map((d) => load(d, e.name, tags)))).filter((x) => !!x);
    plugins.push({ name: e.name, description: e.description ?? manifest?.description, dir, skills, hasPluginJson: !!manifest, root: dir === ".", entry: e });
    if (dir !== "." || !listed) covered.add(dir);
  }
  const claimed = new Set([...cache.keys()]);
  const taken = new Set(plugins.map((p) => p.name));
  const freeName = (n: string) => {
    let out = n;
    for (let i = 2; taken.has(out); i++) out = `${n}-${i}`;
    taken.add(out);
    return out;
  };

  // 2. Convention: plugins/<plugin>/skills/* not covered by an incoming entry.
  const rootPluginJson = await exists(path.join(root, ".claude-plugin", "plugin.json"));
  const pluginEntries = await readdir(path.join(root, "plugins"), { withFileTypes: true }).catch(() => []);
  for (const d of pluginEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const dir = `plugins/${d.name}`;
    if (covered.has(dir)) continue;
    const all = await skillDirs(root, `${dir}/skills`, warnings);
    const dirs = all.filter((x) => !claimed.has(x));
    if (!all.length && !(await exists(path.join(root, dir, "skills"))))
      warnings.push(`${dir}: not listed, it has no skills/ folder (skills go in ${dir}/skills/<name>/SKILL.md)`);
    if (!dirs.length) continue;
    const manifest = await readJson<Manifest>(path.join(root, dir, ".claude-plugin", "plugin.json"));
    const pname = freeName(slugify(manifest?.name ?? d.name));
    const skills = (await Promise.all(dirs.map((x) => load(x, pname, toTags(manifest?.keywords))))).filter((x) => !!x);
    if (skills.length) plugins.push({ name: pname, description: manifest?.description, dir, skills, hasPluginJson: !!manifest, root: false });
  }

  // 3. Convention: root skills/* not covered by an incoming entry, as one plugin.
  const rootSkills = await skillDirs(root, "skills", warnings);
  if (await exists(path.join(root, "SKILL.md")))
    warnings.push("SKILL.md at the repo root isn't read; skills live in skills/<name>/SKILL.md (or plugins/<plugin>/skills/<name>/SKILL.md)");
  const orphans = covered.has(".") ? [] : rootSkills.filter((x) => !claimed.has(x));
  if (orphans.length) {
    const rootManifest = rootPluginJson ? await readJson<Manifest>(path.join(root, ".claude-plugin", "plugin.json")) : undefined;
    const pname = freeName(slugify(rootManifest?.name ?? name));
    const skills = (await Promise.all(orphans.map((x) => load(x, pname, toTags(rootManifest?.keywords))))).filter((x) => !!x);
    if (skills.length)
      plugins.push({
        name: pname,
        description: rootManifest?.description ?? (existing ? `Other skills in ${repoName}` : `All skills in ${repoName}`),
        dir: ".",
        skills,
        hasPluginJson: rootPluginJson,
        root: true,
      });
  }

  // Unique skill names (OpenCode publishes by name) and unique marketplace entry names.
  const skills = [...new Set(plugins.flatMap((p) => p.skills))];
  const seen = new Map<string, Skill>();
  for (const s of skills) {
    const prev = seen.get(s.name);
    if (prev) throw new Error(`Duplicate skill name "${s.name}" in ${prev.dir} and ${s.dir}`);
    if (RESERVED_NAMES.has(s.name)) throw new Error(`Skill name "${s.name}" (${s.dir}) collides with a generated path in ./public`);
    seen.set(s.name, s);
  }
  // Single-skill shortcuts in the repo's marketplace (what --write-repo adds: `source: "./"` listing one skill, named after
  // it) aren't plugins of their own when the skill also belongs to another plugin. Keep them as the skill's entry instead.
  for (const p of [...plugins]) {
    const only = p.skills.length === 1 ? p.skills[0]! : undefined;
    if (!p.entry || p.entry.source !== "./" || !only || (p.name !== only.name && p.name !== `${only.plugin}-${only.name}`)) continue;
    if (!plugins.some((q) => q !== p && q.skills.includes(only))) continue; // e.g. claude-api upstream: a real one-skill plugin
    plugins.splice(plugins.indexOf(p), 1);
    only.entry = p.name;
    if (only.plugin === p.name) only.plugin = plugins.find((q) => q.skills.includes(only))!.name;
  }
  // A plugin that is exactly one skill of the same name doubles as that skill's single-skill entry.
  const pluginNames = new Set(plugins.map((p) => p.name));
  for (const s of skills) {
    const own = plugins.find((p) => p.name === s.name && p.skills.length === 1 && p.skills[0] === s);
    if (own) Object.assign(s, { entry: own.name, entryIsPlugin: true });
    else if (pluginNames.has(s.name) && s.entry === s.name) s.entry = `${s.plugin}-${s.name}`;
  }

  let pkgPi = false;
  const pkg = await readJson<{ pi?: unknown }>(path.join(root, "package.json"));
  if (pkg?.pi) pkgPi = true;

  const owner: Owner = existing?.owner?.name
    ? existing.owner
    : { name: src.remote?.owner.split("/")[0] ?? repoName, ...(src.remote ? { url: `https://${src.remote.host}/${src.remote.owner.split("/")[0]}` } : {}) };

  return {
    name,
    title: opts.title ?? opts.name ?? existing?.name ?? repoName,
    description: existing?.metadata?.description ?? (existing as { description?: string } | undefined)?.description,
    owner,
    plugins,
    skills,
    rootPluginJson,
    piPackage: rootSkills.length > 0 || pkgPi,
    existing: { claude, omp },
    warnings: [...new Set(warnings)], // the same folder can be scanned for several plugins
  };
}
