// `--installed`: a catalog of the skills installed on this machine, whatever the agent/harness.
// Global (user-level) locations plus the current project's, read from each tool's own records where they exist.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists, loadSkill, readJson, RESERVED_NAMES, slugify } from "./discover.ts";
import type { Catalog, Plugin, Skill, SourceInfo } from "./types.ts";

/** One place skills are installed. Each becomes a plugin (group) in the catalog. */
export interface Location {
  /** Group name, e.g. "claude-code", "devbox". */
  group: string;
  /** What it is, without a path, e.g. "Claude Code skills". Shown on the site (read on other machines). */
  label: string;
  /** Label plus the folder, e.g. "Claude Code skills (~/.claude/skills)". Only for the CLI's own output. */
  description: string;
  /** Absolute folder. */
  dir: string;
  /** `skills`: a folder of <skill>/SKILL.md; `package`: a plugin/package root (SKILL.md itself, skills/*, or listed paths). */
  kind: "skills" | "package";
  /** Extra skill paths listed by a plugin manifest, relative to `dir`. */
  listed?: string[];
  scope: "global" | "project";
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).map((e) => path.join(dir, e.name));
}

/** Every place to look, global first, then the project in `cwd`. Only existing folders are returned. */
export async function installedLocations(home = os.homedir(), cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<Location[]> {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgCache = env.XDG_CACHE_HOME || path.join(home, ".cache");
  const out: Location[] = [];
  const skills = (group: string, label: string, dir: string, scope: Location["scope"]) =>
    out.push({ group, label, description: `${label} (${tilde(dir, home)})`, dir, kind: "skills", scope });

  // Global skill folders (agent ids follow the Vercel skills CLI's table where it applies).
  skills("claude-code", "Claude Code skills", path.join(claudeDir, "skills"), "global");
  skills("agents", "Shared agent skills: pi, Codex, Cline, Amp, …", path.join(home, ".agents", "skills"), "global");
  skills("opencode", "OpenCode skills", path.join(xdgConfig, "opencode", "skills"), "global");
  skills("opencode", "OpenCode skills", path.join(xdgConfig, "opencode", "skill"), "global");
  skills("opencode-remote", "OpenCode remote-index downloads", path.join(xdgCache, "opencode", "skills"), "global");
  skills("pi", "pi skills", path.join(home, ".pi", "agent", "skills"), "global");
  skills("oh-my-pi", "oh-my-pi skills", path.join(home, ".omp", "agent", "skills"), "global");
  skills("cursor", "Cursor skills", path.join(home, ".cursor", "skills"), "global");
  skills("github-copilot", "GitHub Copilot skills", path.join(home, ".copilot", "skills"), "global");
  skills("gemini-cli", "Gemini CLI skills", path.join(home, ".gemini", "skills"), "global");
  skills("roo", "Roo Code skills", path.join(home, ".roo", "skills"), "global");
  skills("goose", "Goose skills", path.join(xdgConfig, "goose", "skills"), "global");
  skills("amp", "Amp skills", path.join(xdgConfig, "agents", "skills"), "global");

  // Claude Code plugins: exact install paths from its own record (user scope, or project scope for this directory).
  type Installed = { plugins?: Record<string, { scope?: string; installPath?: string; projectPath?: string }[]> };
  const record = await readJson<Installed>(path.join(claudeDir, "plugins", "installed_plugins.json"));
  for (const [id, installs] of Object.entries(record?.plugins ?? {})) {
    for (const i of installs ?? []) {
      if (!i.installPath) continue;
      if (i.scope && i.scope !== "user" && path.resolve(i.projectPath ?? "") !== path.resolve(cwd)) continue;
      const manifest = await readJson<{ skills?: unknown }>(path.join(i.installPath, ".claude-plugin", "plugin.json"));
      const listed = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills.filter((x): x is string => typeof x === "string") : [];
      out.push({
        group: id.split("@")[0]!,
        label: `Claude Code plugin ${id}`,
        description: `Claude Code plugin ${id} (${tilde(i.installPath, home)})`,
        dir: i.installPath,
        kind: "package",
        listed,
        scope: i.scope === "user" || !i.scope ? "global" : "project",
      });
    }
  }

  // oh-my-pi plugin cache: <marketplace>___<plugin>___<version>/
  for (const d of await subdirs(path.join(home, ".omp", "plugins", "cache", "plugins"))) {
    const [mkt, plugin] = path.basename(d).split("___");
    if (plugin) out.push({ group: plugin, label: `oh-my-pi plugin ${plugin}@${mkt}`, description: `oh-my-pi plugin ${plugin}@${mkt} (${tilde(d, home)})`, dir: d, kind: "package", scope: "global" });
  }

  // pi git packages: <agentDir>/git/<host>/<path…>/ (global) and .pi/git/… (project).
  const piPackages = async (root: string, scope: Location["scope"]) => {
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) return;
      if ((await exists(path.join(dir, "skills"))) || (await exists(path.join(dir, "package.json")))) {
        out.push({ group: path.basename(dir), label: `pi package ${path.relative(root, dir)}`, description: `pi package ${path.relative(root, dir)} (${tilde(dir, home)})`, dir, kind: "package", scope });
        return;
      }
      for (const d of await subdirs(dir)) await walk(d, depth + 1);
    };
    for (const host of await subdirs(root)) await walk(host, 1);
  };
  await piPackages(path.join(home, ".pi", "agent", "git"), "global");

  // The current project.
  if (path.resolve(cwd) !== path.resolve(home)) {
    const p = (rel: string) => path.join(cwd, rel);
    skills("project-claude", "This project's Claude Code skills", p(".claude/skills"), "project");
    skills("project-agents", "This project's shared agent skills", p(".agents/skills"), "project");
    skills("project-opencode", "This project's OpenCode skills", p(".opencode/skills"), "project");
    skills("project-opencode", "This project's OpenCode skills", p(".opencode/skill"), "project");
    skills("project-pi", "This project's pi skills", p(".pi/skills"), "project");
    skills("project-oh-my-pi", "This project's oh-my-pi skills", p(".omp/skills"), "project");
    skills("project-roo", "This project's Roo Code skills", p(".roo/skills"), "project");
    skills("project-goose", "This project's Goose skills", p(".goose/skills"), "project");
    await piPackages(p(".pi/git"), "project");
  }

  const present: Location[] = [];
  for (const l of out) if ((await stat(l.dir).catch(() => undefined))?.isDirectory()) present.push(l);
  return present;
}

/** Skill folders in a location (absolute paths). */
async function skillFolders(l: Location): Promise<string[]> {
  const has = (d: string) => exists(path.join(d, "SKILL.md"));
  if (l.kind === "skills") {
    const out: string[] = [];
    for (const d of await subdirs(l.dir)) if (await has(d)) out.push(d);
    return out;
  }
  const set = new Set<string>();
  if (await has(l.dir)) set.add(l.dir);
  for (const d of await subdirs(path.join(l.dir, "skills"))) if (await has(d)) set.add(d);
  for (const rel of l.listed ?? []) {
    const d = path.resolve(l.dir, rel);
    if (!d.startsWith(l.dir)) continue;
    if (await has(d)) set.add(d);
    else for (const x of await subdirs(d)) if (await has(x)) set.add(x);
  }
  return [...set];
}

const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

export interface InstalledResult {
  catalog: Catalog;
  src: SourceInfo;
  locations: Location[];
}

/** Build a catalog of installed skills. Paths are kept relative to "/" so the normal publish pipeline can copy them. */
export async function discoverInstalled(
  opts: { name?: string; title?: string; home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<InstalledResult> {
  const home = opts.home ?? os.homedir();
  const locations = await installedLocations(home, opts.cwd, opts.env);
  const warnings: string[] = [];
  const byReal = new Map<string, Skill>(); // same folder reached twice (symlinks): one skill
  const byName = new Map<string, { skill: Skill; sha: string }>();
  const groups = new Map<string, { description: string; dirs: Set<string>; skills: Skill[] }>();

  for (const l of locations) {
    let g = groups.get(l.group);
    if (!g) groups.set(l.group, (g = { description: l.label, dirs: new Set(), skills: [] }));
    g.dirs.add(l.dir);
    for (const folder of await skillFolders(l)) {
      const real = await realpath(folder).catch(() => folder);
      let skill = byReal.get(real);
      if (!skill) {
        const loaded = await loadSkill("/", path.relative("/", real), slugify(l.group), warnings);
        if (!loaded) continue;
        if (RESERVED_NAMES.has(loaded.name)) {
          warnings.push(`${tilde(real, home)}: skill name "${loaded.name}" collides with a generated path; skipped`);
          continue;
        }
        const sha = await hash(path.join(real, "SKILL.md"));
        const prev = byName.get(loaded.name);
        if (prev && prev.sha === sha) skill = prev.skill; // the same skill copied for another agent
        else if (prev) {
          warnings.push(`${tilde(real, home)}: another skill named "${loaded.name}" is already listed (${tilde("/" + prev.skill.dir, home)}); skipped`);
          continue;
        } else {
          skill = loaded;
          byName.set(loaded.name, { skill, sha });
        }
        byReal.set(real, skill);
      }
      if (!g.skills.includes(skill)) g.skills.push(skill);
    }
  }

  const plugins: Plugin[] = [];
  const taken = new Set<string>();
  for (const [group, g] of groups) {
    if (!g.skills.length) continue;
    let name = slugify(group);
    for (let i = 2; taken.has(name) || byName.has(name); i++) name = `${slugify(group)}-${i}`;
    taken.add(name);
    const dir = path.relative("/", [...g.dirs][0]!);
    plugins.push({ name, description: g.description, dir, skills: g.skills, hasPluginJson: false, root: false });
  }
  const skills = [...new Set(plugins.flatMap((p) => p.skills))];
  for (const s of skills) s.plugin = plugins.find((p) => p.skills.includes(s))!.name;

  // Skill dirs are relative to "/" internally; show warnings (CLI output only) with ~ paths.
  const homeRel = path.relative("/", home);
  const shown = warnings.map((w) => (w.startsWith(homeRel + "/") ? `~${w.slice(homeRel.length)}` : w));
  const user = os.userInfo().username;
  const catalog: Catalog = {
    name: slugify(opts.name ?? "installed-skills"),
    title: opts.title ?? opts.name ?? "Installed skills",
    description: `Skills installed on this machine for ${user}, across agents (global and this project).`,
    owner: { name: user },
    plugins,
    skills,
    rootPluginJson: false,
    piPackage: false,
    existing: {},
    warnings: shown,
  };
  const src: SourceInfo = { dir: "/", local: true, cleanup: async () => {} };
  return { catalog, src, locations };
}

export { tilde };
