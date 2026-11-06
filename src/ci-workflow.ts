// `skills-pages init`: CI workflows that build the site on every push and deploy it to GitHub Pages / GitLab Pages.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CiProvider = "github" | "gitlab";

export interface WorkflowOptions {
  /** Output folder the job publishes. */
  out: string;
  /** Docker image the job runs in (needs node/npx; git for commit info, tar for GitHub's artifact upload). */
  image: string;
  /** Optional npm registry/mirror to install skills-pages from. */
  npmRegistry?: string;
  /** Package spec to run, e.g. "@nf3t/skills-pages" or "@nf3t/skills-pages@1". */
  pkg: string;
}

const yamlStr = (v: string) => JSON.stringify(v); // a JSON string is a valid YAML scalar

/** The repo's default branch: origin/HEAD, else the current branch, else "main". */
export async function defaultBranch(dir: string): Promise<string> {
  const git = async (...a: string[]) => (await run("git", a, { cwd: dir }).catch(() => ({ stdout: "" }))).stdout.trim();
  return (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "") || (await git("rev-parse", "--abbrev-ref", "HEAD")).replace(/^HEAD$/, "") || "main";
}

/** GitHub Actions: build in the chosen image and deploy with the official Pages actions (configure-pages gives the URL, incl. custom domains). */
export function githubWorkflow(branch: string, o: WorkflowOptions): string {
  return `# Builds the skills site with skills-pages and deploys it to GitHub Pages.
# Enable Pages with "Source: GitHub Actions" in the repository settings.
name: skills-pages
on:
  push:
    branches: [${branch}]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    container:
      image: ${yamlStr(o.image)}
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    env:
      DO_NOT_TRACK: "1"
${o.npmRegistry ? `      NPM_CONFIG_REGISTRY: ${yamlStr(o.npmRegistry)}\n` : ""}    steps:
      - uses: actions/checkout@v4
      # Inside a container git refuses the workspace without this, and the site would lose its commit details.
      - run: git config --global --add safe.directory "$GITHUB_WORKSPACE"
      - id: pages
        uses: actions/configure-pages@v5
      - run: npx --yes ${o.pkg} build --no-interactive --out "${o.out}" --base-url "\${{ steps.pages.outputs.base_url }}/"
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${o.out}
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

/** GitLab CI: a \`pages\` job in the chosen image, publishing the output folder (the URL comes from CI_PAGES_URL). */
export function gitlabJob(o: WorkflowOptions): string {
  return `# Builds the skills site with skills-pages and deploys it to GitLab Pages.
pages:
  image: ${yamlStr(o.image)}
  variables:
    DO_NOT_TRACK: "1"
${o.npmRegistry ? `    NPM_CONFIG_REGISTRY: ${yamlStr(o.npmRegistry)}\n` : ""}  script:
    - npx --yes ${o.pkg} build --no-interactive --out ${o.out}
  artifacts:
    paths:
      - ${o.out}
${o.out === "public" ? "" : `  publish: ${o.out}\n`}  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
`;
}

export interface WorkflowResult {
  file: string;
  written: boolean;
  /** Content to merge by hand when the file already exists. */
  content: string;
}

/** Write the workflow into the repo, never overwriting an existing file. */
export async function writeWorkflow(provider: CiProvider, repoDir: string, o: WorkflowOptions): Promise<WorkflowResult> {
  const file = provider === "github" ? path.join(repoDir, ".github", "workflows", "skills-pages.yml") : path.join(repoDir, ".gitlab-ci.yml");
  const content = provider === "github" ? githubWorkflow(await defaultBranch(repoDir), o) : gitlabJob(o);
  if (existsSync(file)) return { file, written: false, content };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return { file, written: true, content };
}
