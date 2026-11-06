import type { Catalog, Marketplace, MarketplaceEntry, PluginSource, Skill, SourceInfo } from "./types.ts";

/**
 * Marketplaces built from a catalog. Claude Code and oh-my-pi read the same schema.
 * - `relative`: written into the catalog repo (`--write-repo`); sources resolve inside the git clone.
 * - `https` / `ssh`: oh-my-pi's site catalog, added by JSON URL, so sources are absolute git sources.
 * - copies (see buildCopyMarketplace): point at the skill copies in ./public, as a local directory marketplace
 *   or, for Claude Code on an HTTPS site, as zip archives.
 */
export type SourceMode = "relative" | "https" | "ssh";

export interface BuildOptions {
  mode: SourceMode;
  ref?: string;
}

export interface BuildResult {
  marketplace: Marketplace;
  /** Skill entry names included for single-skill installs. */
  skillEntries: string[];
  warnings: string[];
}

const rel = (dir: string) => (dir === "." ? "./" : `./${dir}`);

/**
 * Plugin names Claude Code calls reserved for Anthropic. It still installs and loads them; only
 * `claude plugin validate` / `init` / `tag` refuse them.
 */
export function reservedPluginName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /^(claude|anthropics?|cc-plugin)-/.test(n) ||
    ["claude", "anthropic", "anthropics", "claude-code", "claude-mods"].includes(n) ||
    /(^|-)(claude|anthropic)-official($|-)|(^|-)official-(claude|anthropic)($|-)/.test(n)
  );
}

const RESERVED_MARKETPLACES = [
  "claude-code-marketplace", "claude-code-plugins", "claude-plugins-official", "anthropic-marketplace", "anthropic-plugins",
  "agent-skills", "anthropic-agent-skills", "life-sciences", "knowledge-work-plugins", "claude-for-legal",
  "claude-for-financial-services", "financial-services-plugins", "first-party-plugins", "claude-tag-plugins",
  "claude-community", "claude-plugins-community", "healthcare", "anthropic-plugin-directory", "claude-plugin-directory",
  "inline", "builtin", "skills-dir", "synced", "claude-plugin-test", "npm", "pip", "uv", "cargo", "github", "gh",
];

/**
 * Marketplace names Claude Code refuses to add from anywhere but Anthropic's own GitHub repos, per its docs' "Reserved
 * names": the official/community names, other spellings of them, impersonations, `claudeai-…`, and package-manager names.
 * Returns the reason, or undefined when the name is fine.
 */
export function reservedMarketplaceName(name: string): string | undefined {
  if (/[^\x20-\x7e]/.test(name)) return "it contains a non-ASCII character";
  const n = name.toLowerCase().replace(/\.+$/, "").replace(/[^a-z0-9_]+/g, "-");
  if (RESERVED_MARKETPLACES.includes(n)) return `"${n}" is reserved`;
  if (n.startsWith("claudeai-")) return "names starting with claudeai- are reserved for claude.ai";
  if (/(^|-)official($|-)/.test(n) && /claude|anthropic/.test(n)) return "it impersonates an official Anthropic/Claude marketplace";
  if (/^(claude-code-plugins|claude-plugins|anthropic-plugins|anthropic-marketplace)(-|$)/.test(n)) return "it impersonates an official Anthropic/Claude marketplace";
  return undefined;
}

/** Build the repo-written marketplace (`relative`) or oh-my-pi's git-sourced site catalog (`https`/`ssh`). */
export function buildMarketplace(cat: Catalog, src: SourceInfo, opts: BuildOptions): BuildResult {
  const warnings: string[] = [];
  const skillEntries: string[] = [];
  const url = opts.mode === "ssh" ? src.remote?.sshUrl : src.remote?.httpsUrl;
  if (opts.mode !== "relative" && !url) throw new Error("A git remote is needed for absolute marketplace sources (set origin or pass --repo-url)");
  const ref = opts.ref ? { ref: opts.ref } : {};

  const subdir = (path: string): PluginSource =>
    path === "." ? { source: "url", url: url!, ...ref } : { source: "git-subdir", url: url!, path, ...ref };

  const plugins: MarketplaceEntry[] = [];
  for (const p of cat.plugins) {
    // Incoming entries keep every field. In the repo they're written back verbatim; published, only a local source
    // becomes an absolute git source (oh-my-pi reads a root entry's skills list from the repo's own file in the clone).
    if (p.entry) {
      plugins.push(opts.mode === "relative" || p.external ? p.entry : { ...p.entry, source: subdir(p.dir) });
      continue;
    }
    const entry: MarketplaceEntry = {
      name: p.name,
      source: opts.mode === "relative" ? rel(p.dir) : subdir(p.dir),
      ...(p.description ? { description: p.description } : {}),
    };
    // A root plugin without its own plugin.json gets its skills listed explicitly.
    if (p.root && !p.hasPluginJson) Object.assign(entry, { strict: false, skills: p.skills.map((s) => rel(s.dir)) });
    plugins.push(entry);
  }

  for (const s of cat.skills) {
    if (s.entryIsPlugin) {
      skillEntries.push(s.entry); // its own plugin already installs exactly this skill
      continue;
    }
    // oh-my-pi only honours entry `skills` for marketplace-root sources, which a JSON-URL catalog can't have.
    if (opts.mode !== "relative") continue;
    // Marketplace-root entry listing one skill: Claude Code and oh-my-pi both load exactly that skill.
    if (cat.rootPluginJson) {
      warnings.push(`Root .claude-plugin/plugin.json exists, so "${s.name}" can't get a strict:false entry (conflicting manifests); install its plugin instead`);
      continue;
    }
    plugins.push({ name: s.entry, description: s.description || `The ${s.name} skill`, source: "./", strict: false, skills: [rel(s.dir)] });
    skillEntries.push(s.entry);
  }

  const marketplace: Marketplace = {
    name: cat.name,
    owner: cat.owner,
    metadata: {
      description: cat.description ?? `Agent skills from ${src.remote?.webUrl ?? cat.title}`,
      // No commit sha in repo-written files: it would change on every commit.
      ...(src.sha && opts.mode !== "relative" ? { version: src.sha.slice(0, 12) } : {}),
    },
    plugins,
  };
  return { marketplace, skillEntries, warnings };
}

/** What a copy-based entry needs: the skills it contains (published at ./public/<skill>/). */
export interface CopyEntry {
  name: string;
  skills: Skill[];
}

export interface CopyOptions {
  /**
   * - `local`: the marketplace lives in ./public itself; sources are relative (`./<skill>`). For
   *   `claude|omp plugin marketplace add <public dir>`, which reads the folder in place.
   * - `archive`: Claude Code's site catalog; each entry is a zip of exactly its skills, served from this site.
   */
  mode: "local" | "archive";
  /** For `archive`: url + sha256 + content version of the zip for an entry. */
  archive?: (e: CopyEntry) => { url: string; sha256: string; version: string };
  /** Content version for an entry (both modes), so `marketplace update` notices changes. */
  version: (e: CopyEntry) => string;
}

/**
 * A marketplace whose sources are the skill copies in ./public. Incoming entries keep their other fields;
 * plugins from other repos pass through; plugins without skills (commands/hooks only) can't be copied and are skipped.
 */
export function buildCopyMarketplace(cat: Catalog, src: SourceInfo, opts: CopyOptions): BuildResult {
  const warnings: string[] = [];
  const skillEntries: string[] = [];
  const plugins: MarketplaceEntry[] = [];
  const entryFor = (e: CopyEntry, base: Record<string, unknown>): MarketplaceEntry => {
    const version = opts.version(e);
    if (opts.mode === "local") return { ...base, name: e.name, version, source: "./", strict: false, skills: e.skills.map((s) => `./${s.name}`) };
    const a = opts.archive!(e);
    return { ...base, name: e.name, version: a.version, source: { source: "archive", url: a.url, sha256: a.sha256 } };
  };
  for (const p of cat.plugins) {
    if (p.external) {
      plugins.push(p.entry!);
      continue;
    }
    if (!p.skills.length) {
      warnings.push(`Plugin "${p.name}" has no skills, so it can't be published from the copies in ./public (only skills are copied)`);
      continue;
    }
    // Keep the incoming entry's own fields (category, author, keywords, …) but not where it came from.
    const { source: _s, skills: _k, strict: _t, dependencies: _d, version: _v, ...rest }: Partial<MarketplaceEntry> = p.entry ?? {};
    plugins.push(entryFor({ name: p.name, skills: p.skills }, { ...rest, ...(p.description && !rest.description ? { description: p.description } : {}) }));
  }
  for (const s of cat.skills) {
    skillEntries.push(s.entry);
    if (s.entryIsPlugin) continue; // its own plugin already is exactly this skill
    plugins.push(entryFor({ name: s.entry, skills: [s] }, { description: s.description || `The ${s.name} skill` }));
  }
  const marketplace: Marketplace = {
    name: cat.name,
    owner: cat.owner,
    metadata: { description: cat.description ?? `Agent skills from ${src.remote?.webUrl ?? cat.title}` },
    plugins,
  };
  return { marketplace, skillEntries, warnings };
}

/**
 * Merge generated entries into a hand-maintained marketplace: top-level fields and plugin
 * entries already present are kept; single-skill entries are added or refreshed; nothing is deleted.
 */
export function mergeMarketplace(existing: Marketplace | undefined, generated: Marketplace, skillEntries: string[], opts: { rename?: boolean } = {}): Marketplace {
  if (!existing) return generated;
  const refresh = new Set(skillEntries);
  const plugins = existing.plugins.map((p) => {
    if (!refresh.has(p.name)) return p;
    return generated.plugins.find((g) => g.name === p.name) ?? p;
  });
  const have = new Set(plugins.map((p) => p.name));
  for (const g of generated.plugins) if (!have.has(g.name)) plugins.push(g);
  return {
    ...generated,
    ...existing,
    ...(opts.rename ? { name: generated.name } : {}),
    metadata: { ...generated.metadata, ...existing.metadata },
    plugins,
  };
}

/**
 * Which of our plugins / single-skill entries an existing repo marketplace really provides:
 * same name *and* same content (path, or skill set for marketplace-root entries).
 */
export function matchRepoMarketplace(cat: Catalog, m: Marketplace | undefined): { plugins: string[]; skills: string[] } {
  if (!m) return { plugins: [], skills: [] };
  const byName = new Map(m.plugins.map((e) => [e.name, e]));
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const norm = (paths: unknown) => (Array.isArray(paths) ? paths.filter((x): x is string => typeof x === "string").map((x) => x.replace(/\/+$/, "")) : []);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const plugins = cat.plugins
    .filter((p) => {
      const e = byName.get(p.name);
      if (!e) return false;
      if (p.entry) return same(e.source, p.entry.source) && same(e.skills, p.entry.skills);
      if (!p.root) return e.source === rel(p.dir);
      // Root plugin: "./" with no skills list loads root skills/; otherwise the list must match ours.
      return e.source === "./" && (e.skills === undefined || sameSet(norm(e.skills), p.skills.map((s) => rel(s.dir))));
    })
    .map((p) => p.name);
  const skills = cat.skills
    .filter((s) => {
      if (s.entryIsPlugin) return plugins.includes(s.entry);
      const e = byName.get(s.entry);
      return !!e && e.source === "./" && sameSet(norm(e.skills), [rel(s.dir)]);
    })
    .map((s) => s.entry);
  return { plugins, skills };
}
