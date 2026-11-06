import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteInfo, SourceInfo } from "./types.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** True for anything that looks like a git URL rather than a local path. */
export function isGitUrl(input: string): boolean {
  return /^(https?|ssh|git):\/\//.test(input) || /^[\w.-]+@[\w.-]+:/.test(input);
}

/**
 * Normalise `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git` and
 * `https://user:token@host/owner/repo` into https/ssh/web forms. Port of build-footer's commit-info.sh.
 */
export function parseRemote(remote: string): RemoteInfo | undefined {
  let r = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  r = r
    .replace(/^(ssh|git|https?):\/\//, "")
    .replace(/^[^@/]+@/, "") // credentials or ssh user
    .replace(/^([^:/]+):(?!\d+\/)/, "$1/") // scp-like host:path
    .replace(/^([^:/]+):\d+\//, "$1/"); // drop ssh/http port
  const parts = r.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  const host = parts[0]!.toLowerCase();
  const repo = parts[parts.length - 1]!;
  const owner = parts.slice(1, -1).join("/");
  const isGitLab = host.includes("gitlab");
  const webUrl = `https://${host}/${owner}/${repo}`;
  let pagesUrl: string | undefined;
  if (host === "github.com") {
    const user = owner.toLowerCase();
    pagesUrl = repo.toLowerCase() === `${user}.github.io` ? `https://${user}.github.io/` : `https://${user}.github.io/${repo}/`;
  } else if (host === "gitlab.com") {
    const [top, ...rest] = owner.split("/");
    pagesUrl = `https://${top!.toLowerCase()}.gitlab.io/${[...rest, repo].join("/")}/`;
  }
  return {
    host,
    owner,
    repo,
    httpsUrl: `${webUrl}.git`,
    sshUrl: `git@${host}:${owner}/${repo}.git`,
    webUrl,
    isGitLab,
    pagesUrl,
  };
}

export function commitUrl(remote: RemoteInfo | undefined, sha: string | undefined): string | undefined {
  if (!remote || !sha) return undefined;
  return `${remote.webUrl}/${remote.isGitLab ? "-/commit" : "commit"}/${sha}`;
}

/** Web link to a path in the repo. */
export function treeUrl(remote: RemoteInfo, ref: string | undefined, dir: string): string {
  return `${remote.webUrl}/${remote.isGitLab ? "-/tree" : "tree"}/${ref ?? "HEAD"}/${dir}`;
}

/** Commit date, subject, branch and whether the working tree is dirty (uncommitted changes, ignoring git-ignored files). */
async function commitFacts(dir: string): Promise<Pick<SourceInfo, "commitDate" | "commitSubject" | "branch" | "dirty">> {
  const log = await git(dir, "log", "-1", "--format=%cI%n%s");
  const [commitDate, commitSubject] = log ? log.split("\n") : [];
  const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  // `git status` exits 0 with empty output when clean; undefined means it failed (e.g. not a work tree).
  let dirty: boolean | undefined;
  try {
    const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: dir });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = undefined;
  }
  return { commitDate, commitSubject, branch: branch && branch !== "HEAD" ? branch : undefined, dirty };
}

export interface ResolveOptions {
  ref?: string;
  /** Overrides the detected origin remote. */
  repoUrl?: string;
  /** Where `repoUrl` came from (for display). */
  repoUrlFrom?: string;
  /** Used for a local checkout when git can't tell (CI variables for the job's workspace). */
  fallback?: { repoUrl?: string; sha?: string; from: string };
}

/** Resolve a local path or clone a git URL (shallow, into a temp dir; nothing from it is executed). */
export async function resolveSource(input: string, opts: ResolveOptions = {}): Promise<SourceInfo> {
  if (isGitUrl(input)) {
    const tmp = await mkdtemp(path.join(tmpdir(), "skills-pages-"));
    const dir = path.join(tmp, "repo");
    const args = ["clone", "--depth", "1", "--no-tags", "--quiet", "-c", "core.hooksPath=/dev/null"];
    if (opts.ref) args.push("--branch", opts.ref);
    try {
      await run("git", [...args, "--", input, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      const msg = (err as { stderr?: string }).stderr?.trim() || String(err);
      throw new Error(`git clone failed for ${input}: ${msg}`);
    }
    const sha = await git(dir, "rev-parse", "HEAD");
    return {
      ...(await commitFacts(dir)),
      dir,
      local: false,
      remote: parseRemote(opts.repoUrl ?? input),
      remoteFrom: opts.repoUrl ? (opts.repoUrlFrom ?? "--repo-url") : "argument",
      sha,
      shaFrom: sha ? "git" : undefined,
      commitUrl: commitUrl(parseRemote(input), sha),
      ref: opts.ref,
      cleanup: () => rm(tmp, { recursive: true, force: true }),
    };
  }

  const dir = path.resolve(input);
  const st = await stat(dir).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const fb = opts.fallback;
  // Detected facts: git first, then CI variables describing this checkout.
  const gitOrigin = await git(dir, "remote", "get-url", "origin");
  const gitSha = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  const isGitRepo = (await git(dir, "rev-parse", "--is-inside-work-tree")) === "true";
  const detectedOrigin = gitOrigin ?? fb?.repoUrl;
  const sha = gitSha ?? fb?.sha;
  const origin = opts.repoUrl ?? detectedOrigin;
  return {
    ...(gitSha ? await commitFacts(dir) : {}),
    isGitRepo,
    dir,
    local: true,
    remote: origin ? parseRemote(origin) : undefined,
    remoteFrom: opts.repoUrl ? (opts.repoUrlFrom ?? "--repo-url") : gitOrigin ? "git origin" : fb?.repoUrl ? fb.from : undefined,
    sha,
    shaFrom: gitSha ? "git" : fb?.sha ? fb.from : undefined,
    commitUrl: detectedOrigin ? commitUrl(parseRemote(detectedOrigin), sha) : undefined,
    ref: opts.ref,
    cleanup: async () => {},
  };
}
