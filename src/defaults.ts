// Automatic defaults for CLI options: flag → SKILLS_PAGES_* env → CI variables → git detection.
import path from "node:path";
import { parseRemote } from "./source.ts";
import type { RemoteInfo } from "./types.ts";

export type Env = Record<string, string | undefined>;

/** A resolved value and where it came from (shown in the CLI's settings box). */
export interface Resolved<T = string> {
  value: T;
  from: string;
}

/** Facts from GitHub Actions / GitLab CI predefined variables. */
export interface CiInfo {
  provider: "github" | "gitlab";
  /** Checkout directory of the job. */
  workspace?: string;
  repoUrl?: string;
  sha?: string;
  /** Pages URL with trailing slash, when the platform tells us (GitLab) or it can be derived (github.com). */
  pagesUrl?: string;
  pagesFrom?: string;
  title?: string;
  /** The CI run that is building this site (shown on the build page). */
  run?: { url: string; label: string; pipelineUrl?: string; ref?: string };
}

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const slash = (u: string) => (u.endsWith("/") ? u : `${u}/`);

export function ciInfo(env: Env): CiInfo | undefined {
  if (env.GITLAB_CI === "true") {
    const pages = nonEmpty(env.CI_PAGES_URL);
    return {
      provider: "gitlab",
      workspace: nonEmpty(env.CI_PROJECT_DIR),
      repoUrl: nonEmpty(env.CI_PROJECT_URL),
      sha: nonEmpty(env.CI_COMMIT_SHA),
      ...(pages ? { pagesUrl: slash(pages), pagesFrom: "CI_PAGES_URL" } : {}),
      title: nonEmpty(env.CI_PROJECT_TITLE),
      ...(nonEmpty(env.CI_JOB_URL) || nonEmpty(env.CI_PIPELINE_URL)
        ? {
            run: {
              url: (nonEmpty(env.CI_JOB_URL) ?? nonEmpty(env.CI_PIPELINE_URL))!,
              label: [nonEmpty(env.CI_JOB_NAME) ? `job ${env.CI_JOB_NAME}` : undefined, nonEmpty(env.CI_PIPELINE_ID) ? `pipeline #${env.CI_PIPELINE_ID}` : undefined].filter(Boolean).join(", ") || "GitLab CI job",
              ...(nonEmpty(env.CI_JOB_URL) && nonEmpty(env.CI_PIPELINE_URL) ? { pipelineUrl: env.CI_PIPELINE_URL!.trim() } : {}),
              ...(nonEmpty(env.CI_COMMIT_REF_NAME) ? { ref: env.CI_COMMIT_REF_NAME!.trim() } : {}),
            },
          }
        : {}),
    };
  }
  if (env.GITHUB_ACTIONS === "true") {
    const server = nonEmpty(env.GITHUB_SERVER_URL) ?? "https://github.com";
    const repository = nonEmpty(env.GITHUB_REPOSITORY);
    const repoUrl = repository ? `${server.replace(/\/+$/, "")}/${repository}` : undefined;
    // Pages URLs are only predictable on github.com; GHES/custom domains need --base-url (e.g. actions/configure-pages' base_url).
    const pagesUrl = repoUrl ? parseRemote(repoUrl)?.pagesUrl : undefined;
    const runId = nonEmpty(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT) > 1 ? Number(env.GITHUB_RUN_ATTEMPT) : undefined;
    return {
      provider: "github",
      workspace: nonEmpty(env.GITHUB_WORKSPACE),
      repoUrl,
      sha: nonEmpty(env.GITHUB_SHA),
      ...(pagesUrl ? { pagesUrl, pagesFrom: "GITHUB_REPOSITORY" } : {}),
      ...(repoUrl && runId
        ? {
            run: {
              url: `${repoUrl}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ""}`,
              label: `${nonEmpty(env.GITHUB_WORKFLOW) ?? "workflow"} run #${nonEmpty(env.GITHUB_RUN_NUMBER) ?? runId}${attempt ? ` (attempt ${attempt})` : ""}`,
              ...(nonEmpty(env.GITHUB_REF_NAME) ? { ref: env.GITHUB_REF_NAME!.trim() } : {}),
            },
          }
        : {}),
    };
  }
  return undefined;
}

/** True when `dir` is the CI job's checkout, so CI variables describe it. */
export function isCiWorkspace(ci: CiInfo | undefined, dir: string): ci is CiInfo {
  return !!ci?.workspace && path.resolve(ci.workspace) === path.resolve(dir);
}

/** First defined candidate wins. */
export function pick(...candidates: [string | undefined, string][]): Resolved | undefined {
  for (const [value, from] of candidates) {
    const v = nonEmpty(value);
    if (v) return { value: v, from };
  }
  return undefined;
}

export function resolveSourceArg(arg: string | undefined, env: Env, ci: CiInfo | undefined): Resolved | undefined {
  return pick([arg, "argument"], [env.SKILLS_PAGES_SOURCE, "SKILLS_PAGES_SOURCE"], [ci?.workspace, ci?.provider === "gitlab" ? "CI_PROJECT_DIR" : "GITHUB_WORKSPACE"]);
}

export function resolveBaseUrl(
  flag: string | undefined,
  env: Env,
  ci: CiInfo | undefined,
  remote: RemoteInfo | undefined,
  dir: string,
  /** Local URL when `--serve` is on: links must work where the site is actually served. */
  serving?: string,
): Resolved | undefined {
  const inCi = isCiWorkspace(ci, dir) ? ci : undefined;
  const r = pick(
    [flag, "--base-url"],
    [env.SKILLS_PAGES_BASE_URL, "SKILLS_PAGES_BASE_URL"],
    [serving, "serve"],
    [inCi?.pagesUrl, inCi?.pagesFrom ?? "CI"],
    [remote?.pagesUrl, "git origin"],
  );
  return r && { ...r, value: slash(r.value) };
}

export function resolveOut(flag: string | undefined, env: Env): Resolved {
  return pick([flag, "--out"], [env.SKILLS_PAGES_OUT, "SKILLS_PAGES_OUT"]) ?? { value: "public", from: "default" };
}
