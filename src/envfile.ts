// .env handling for the interactive CLI: answers are saved as SKILLS_PAGES_* lines and loaded on the next run.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Old variable prefix (before the rename to skills-pages); still read, never written. */
export const LEGACY_PREFIX = "SKILLS_CATALOG_";
export const PREFIX = "SKILLS_PAGES_";

/** Copy SKILLS_CATALOG_X to SKILLS_PAGES_X where the new name isn't set. Returns the old names that were used. */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_PREFIX) || v === undefined) continue;
    const key = PREFIX + k.slice(LEGACY_PREFIX.length);
    if (env[key] === undefined) {
      env[key] = v;
      used.push(k);
    }
  }
  return used;
}

/** Load ./.env into process.env without overriding variables that are already set. Returns the keys it set. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const file = path.join(dir, ".env");
  const loaded = new Set<string>();
  if (!existsSync(file)) return loaded;
  const before = new Set(Object.keys(env));
  // Node's own parser (handles quotes and comments); it never overrides existing variables.
  process.loadEnvFile(file);
  for (const k of Object.keys(env)) if (!before.has(k)) loaded.add(k);
  return loaded;
}

const quote = (v: string) => (/^[\w./:@+-]*$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

/** Merge KEY=value pairs into ./.env (replacing existing keys, keeping everything else) and make sure it's git-ignored. */
export async function saveDotEnv(dir: string, values: Record<string, string>): Promise<{ file: string; ignoredNow: boolean }> {
  const file = path.join(dir, ".env");
  const lines = existsSync(file) ? (await readFile(file, "utf8")).split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const out = lines.flatMap((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    // An old-prefixed line for a key being saved is replaced by the new name.
    if (m?.[1]?.startsWith(LEGACY_PREFIX) && pending.has(PREFIX + m[1].slice(LEGACY_PREFIX.length))) return [];
    if (m && pending.has(m[1]!)) {
      const v = pending.get(m[1]!)!;
      pending.delete(m[1]!);
      return [`${m[1]}=${quote(v)}`];
    }
    return [line];
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  if (pending.size) {
    if (!lines.length) out.push("# skills-pages answers (saved by the interactive CLI; flags and real env vars take precedence)");
    for (const [k, v] of pending) out.push(`${k}=${quote(v)}`);
  }
  await writeFile(file, `${out.join("\n")}\n`);
  return { file, ignoredNow: await ensureIgnored(dir, ".env") };
}

/** Add `entry` to ./.gitignore unless a line already ignores it. Returns true when it had to be added. */
export async function ensureIgnored(dir: string, entry: string): Promise<boolean> {
  const file = path.join(dir, ".gitignore");
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const ignored = text.split(/\r?\n/).some((l) => [entry, `/${entry}`, "*.env", ".env*"].includes(l.trim()));
  if (ignored) return false;
  await writeFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`);
  return true;
}

export const truthy = (v: string | undefined) => (v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v.trim()) ? true : /^(0|false|no|off|)$/i.test(v.trim()) ? false : undefined);
