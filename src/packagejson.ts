// package.json for a skills repo, so pi can install it as a package (`pi install git:…` or, once published,
// `pi install npm:<name>`) and npm can version and distribute it. Merged into an existing file: missing fields are
// filled in, existing ones are kept.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Catalog, SourceInfo } from "./types.ts";

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  keywords?: string[];
  repository?: string | { type?: string; url?: string; directory?: string };
  files?: string[];
  pi?: { skills?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

/** Folders that hold the skills ("./skills", "./plugins/devbox/skills"): what pi scans and what npm should ship. */
export function skillRoots(cat: Catalog): string[] {
  return [...new Set(cat.skills.map((s) => `./${path.posix.dirname(s.dir)}`))].sort();
}

/** A valid npm package name: lowercase, optional @scope/, no leading dot or underscore. */
export const validNpmName = (n: string) => /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(n) && n.length <= 214;

export interface PackageJsonOptions {
  name: string;
  /** Will be published to npm (otherwise marked "private" so it can't be published by accident). */
  public: boolean;
}

/** The merged package.json: existing fields win, except `private` (set from the choice) and list fields (added to). */
export function mergePackageJson(existing: PackageJson | undefined, cat: Catalog, src: SourceInfo, o: PackageJsonOptions): PackageJson {
  const roots = skillRoots(cat);
  const cur = existing ?? {};
  const add = (list: unknown, items: string[]) => [...new Set([...(Array.isArray(list) ? (list as string[]) : []), ...items])];
  const extraFiles = [".claude-plugin", ".omp-plugin"].filter((f) => existsSync(path.join(src.dir, f)));
  const next: PackageJson = {
    name: cur.name ?? o.name,
    version: cur.version ?? "0.1.0",
    description: cur.description ?? cat.description ?? `Agent skills: ${cat.skills.map((s) => s.name).join(", ")}`.slice(0, 200),
    ...cur,
    keywords: add(cur.keywords, ["pi-package", "agent-skills"]),
    ...(cur.repository || !src.remote ? {} : { repository: { type: "git", url: `git+${src.remote.httpsUrl}` } }),
    files: add(cur.files, [...roots.map((r) => r.replace(/^\.\//, "")), ...extraFiles]),
    pi: { ...cur.pi, skills: cur.pi?.skills ?? roots },
  };
  if (o.public) delete next.private;
  else next.private = true;
  return next;
}
