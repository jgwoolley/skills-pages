// Global preferences, per the XDG Base Directory spec:
//   user:   $XDG_CONFIG_HOME/skills-pages/config.json        (default ~/.config/skills-pages/config.json)
//   system: <each of $XDG_CONFIG_DIRS>/skills-pages/config.json (default /etc/xdg/skills-pages/config.json)
// System files are for packagers (e.g. an internal RPM pointing at a corporate Docker image / npm mirror); the user
// file overrides them, and flags / environment variables / ./.env override both.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Prefs {
  ci?: {
    /** Default CI provider for `init`. */
    provider?: "github" | "gitlab" | "none";
    /** Docker image the CI job runs in (e.g. a corporate mirror of node:22). */
    image?: string;
    /** npm registry the CI job installs skills-pages from (e.g. an internal mirror). */
    npmRegistry?: string;
    /** Package (and version) the CI job runs, e.g. "@nf3t/skills-pages@1". */
    package?: string;
  };
  npm?: {
    /** Scope for suggested package names, e.g. "nf3t" → "@nf3t/<catalog>". */
    scope?: string;
  };
  /** Defaults for SKILLS_PAGES_* variables, used when neither the environment nor ./.env sets them. */
  env?: Record<string, string>;
}

export const DEFAULTS: Required<NonNullable<Prefs["ci"]>> = {
  provider: "github",
  image: "node:22",
  npmRegistry: "",
  package: "@nf3t/skills-pages",
};

const APP = "skills-pages";

export function userConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, APP, "config.json");
}

/** In order of importance (the spec: the first directory wins). Relative entries are ignored, as the spec says. */
export function systemConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").filter((d) => d && path.isAbsolute(d));
  return dirs.map((d) => path.join(d, APP, "config.json"));
}

/** A value and the file it came from. */
export interface PrefValue<T> {
  value: T;
  from: string;
}

export interface LoadedPrefs {
  ci: { [K in keyof typeof DEFAULTS]: PrefValue<(typeof DEFAULTS)[K]> };
  env: Record<string, PrefValue<string>>;
  npmScope?: PrefValue<string>;
  /** Files that exist and were read, most important first. */
  files: string[];
  errors: string[];
}

async function readPrefs(file: string, errors: string[]): Promise<Prefs | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a JSON object");
    return j as Prefs;
  } catch (err) {
    errors.push(`${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Merge built-in defaults < system files (least important first) < user file. */
export async function loadPrefs(env: NodeJS.ProcessEnv = process.env): Promise<LoadedPrefs> {
  const errors: string[] = [];
  const out: LoadedPrefs = {
    ci: Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { value: v, from: "built-in" }])) as LoadedPrefs["ci"],
    env: {},
    files: [],
    errors,
  };
  const ordered = [...systemConfigFiles(env)].reverse().concat(userConfigFile(env)); // least → most important
  for (const file of ordered) {
    const p = await readPrefs(file, errors);
    if (!p) continue;
    out.files.unshift(file);
    for (const [k, v] of Object.entries(p.ci ?? {}))
      if (k in DEFAULTS && typeof v === "string") (out.ci as Record<string, PrefValue<string>>)[k] = { value: v, from: file };
    if (typeof p.npm?.scope === "string" && p.npm.scope) out.npmScope = { value: p.npm.scope.replace(/^@/, ""), from: file };
    for (const [k, v] of Object.entries(p.env ?? {})) if (/^SKILLS_PAGES_[A-Z0-9_]+$/.test(k) && typeof v === "string") out.env[k] = { value: v, from: file };
  }
  return out;
}

/** Apply `env` defaults from config files where the variable isn't set (by the environment or ./.env). Returns the keys set. */
export function applyEnvDefaults(prefs: LoadedPrefs, env: NodeJS.ProcessEnv = process.env): string[] {
  const set: string[] = [];
  for (const [k, v] of Object.entries(prefs.env))
    if (env[k] === undefined) {
      env[k] = v.value;
      set.push(k);
    }
  return set;
}

/** Merge `ci` values into the user's config file (other keys are kept). */
export async function saveUserPrefs(ci: Prefs["ci"], env: NodeJS.ProcessEnv = process.env, npm?: Prefs["npm"]): Promise<string> {
  const file = userConfigFile(env);
  const current = (await readPrefs(file, [])) ?? {};
  const next: Prefs = { ...current, ...(ci ? { ci: { ...current.ci, ...ci } } : {}), ...(npm ? { npm: { ...current.npm, ...npm } } : {}) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}
