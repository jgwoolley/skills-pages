import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTarget, tally } from "../src/check-cli.ts";
import { githubWorkflow, gitlabJob, writeWorkflow } from "../src/ci-workflow.ts";
import { applyEnvDefaults, loadPrefs, saveUserPrefs, systemConfigFiles, userConfigFile } from "../src/prefs.ts";
import { worst } from "../src/checks.ts";
import { discover } from "../src/discover.ts";
import { publish } from "../src/publish.ts";
import { parseRemote } from "../src/source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(here, "fixtures", "example-catalog");

describe("skills-pages check", () => {
  it("passes a healthy skills repository", async () => {
    const r = await checkTarget(example);
    assert.equal(r.kind, "skills repository");
    assert.equal(worst(r), "ok");
    assert.equal(r.children.length, 5);
  });
  it("fails a broken skill and explains why", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "check-"));
    try {
      await mkdir(path.join(dir, "Bad_Name"));
      await writeFile(path.join(dir, "Bad_Name", "SKILL.md"), `---\nname: Bad_Name\ndescription: ${"x".repeat(1100)}\n---\n`);
      const r = await checkTarget(path.join(dir, "Bad_Name"));
      assert.equal(worst(r), "fail");
      const texts = r.checks.map((c) => `${c.status}: ${c.text}`);
      assert.ok(texts.some((t) => t.startsWith("fail:") && t.includes("lowercase")));
      assert.ok(texts.some((t) => t.startsWith("warn:") && t.includes("over the spec's 1024")));
      assert.ok(texts.some((t) => t.startsWith("warn:") && t.includes("body is empty")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("checks a built site offline: its own URLs are read from the folder", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "check-site-"));
    try {
      const src = { dir: example, local: true, remote: parseRemote("https://github.com/acme/skills.git"), cleanup: async () => {} };
      const git = { claude: false, omp: false, claudeSkills: [], ompSkills: [], claudeEntries: [], ompEntries: [] };
      await publish(await discover(src), src, { out, siteUrl: "https://acme.github.io/skills/", git });
      const r = await checkTarget(out);
      const n = tally(r);
      assert.equal(n.fail, 0, JSON.stringify(r, null, 1).slice(0, 2000));
      assert.equal(n.warn, 0);
      assert.ok(r.children.length >= 3, "well-known index, OpenCode index and marketplaces were found");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
  it("refuses git repositories (a browser or fetch can't read them)", async () => {
    const r = await checkTarget("git@github.com:acme/skills.git");
    assert.equal(worst(r), "fail");
    assert.match(r.checks[0]!.text, /git repository/);
  });
});

describe("skills-pages init: CI workflows", () => {
  const o = { out: "public", image: "node:22", pkg: "@nf3t/skills-pages" };
  it("GitHub: builds in the chosen image and deploys with the Pages actions, using configure-pages' URL", () => {
    const y = githubWorkflow("main", o);
    assert.match(y, /branches: \[main\]/);
    assert.match(y, /container:\n\s+image: "node:22"/);
    assert.match(y, /safe\.directory/);
    assert.match(y, /npx --yes @nf3t\/skills-pages build --no-interactive --out "public" --base-url "\$\{\{ steps\.pages\.outputs\.base_url \}\}\/"/);
    assert.match(y, /actions\/upload-pages-artifact@v3\n\s+with:\n\s+path: public/);
    assert.doesNotMatch(y, /NPM_CONFIG_REGISTRY/);
  });
  it("corporate settings: image, npm mirror and a pinned package", () => {
    const corp = { out: "public", image: "registry.corp.example/mirror/node:22", npmRegistry: "https://npm.corp.example/", pkg: "@nf3t/skills-pages@1" };
    const gh = githubWorkflow("main", corp);
    assert.match(gh, /image: "registry\.corp\.example\/mirror\/node:22"/);
    assert.match(gh, /NPM_CONFIG_REGISTRY: "https:\/\/npm\.corp\.example\/"/);
    assert.match(gh, /npx --yes @nf3t\/skills-pages@1 build/);
    const gl = gitlabJob(corp);
    assert.match(gl, /^  image: "registry\.corp\.example\/mirror\/node:22"$/m);
    assert.match(gl, /NPM_CONFIG_REGISTRY: "https:\/\/npm\.corp\.example\/"/);
  });
  it("GitLab: a pages job publishing the output folder", () => {
    assert.match(gitlabJob(o), /^pages:\n/m);
    assert.doesNotMatch(gitlabJob(o), /publish:/);
    assert.match(gitlabJob({ ...o, out: "site" }), /publish: site/);
  });
  it("never overwrites an existing workflow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-"));
    try {
      await cp(example, dir, { recursive: true });
      assert.equal((await writeWorkflow("gitlab", dir, o)).written, true);
      await writeFile(path.join(dir, ".gitlab-ci.yml"), "mine\n");
      const again = await writeWorkflow("gitlab", dir, o);
      assert.equal(again.written, false);
      assert.equal(await readFile(path.join(dir, ".gitlab-ci.yml"), "utf8"), "mine\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("global preferences (XDG)", () => {
  it("system files (packagers) < user file; first XDG_CONFIG_DIRS entry wins; env defaults fill unset variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xdg-"));
    try {
      const sys1 = path.join(root, "sys1"), sys2 = path.join(root, "sys2"), user = path.join(root, "user");
      const put = async (dir: string, j: unknown) => {
        await mkdir(path.join(dir, "skills-pages"), { recursive: true });
        await writeFile(path.join(dir, "skills-pages", "config.json"), JSON.stringify(j));
      };
      await put(sys2, { ci: { image: "sys2/node", provider: "gitlab" } });
      await put(sys1, { ci: { image: "registry.corp/node:22", npmRegistry: "https://npm.corp/" }, env: { SKILLS_PAGES_PORT: "5000" } });
      const env: NodeJS.ProcessEnv = { XDG_CONFIG_DIRS: `${sys1}:${sys2}:relative/ignored`, XDG_CONFIG_HOME: user };
      assert.deepEqual(systemConfigFiles(env), [path.join(sys1, "skills-pages", "config.json"), path.join(sys2, "skills-pages", "config.json")]);
      let p = await loadPrefs(env);
      assert.equal(p.ci.image.value, "registry.corp/node:22", "the first system dir wins");
      assert.equal(p.ci.provider.value, "gitlab", "lower dirs still fill gaps");
      assert.equal(p.ci.package.value, "@nf3t/skills-pages");
      assert.equal(p.ci.package.from, "built-in");
      assert.deepEqual(applyEnvDefaults(p, env), ["SKILLS_PAGES_PORT"]);
      assert.equal(env.SKILLS_PAGES_PORT, "5000");
      // The user's saved choice overrides the system file, and keeps other keys.
      const file = await saveUserPrefs({ image: "my/node:22" }, env);
      assert.equal(file, path.join(user, "skills-pages", "config.json"));
      p = await loadPrefs(env);
      assert.equal(p.ci.image.value, "my/node:22");
      assert.equal(p.ci.npmRegistry.value, "https://npm.corp/");
      assert.equal(p.files[0], file, "user file is the most important");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("defaults to ~/.config and /etc/xdg", () => {
    assert.match(userConfigFile({}), /\.config\/skills-pages\/config\.json$/);
    assert.deepEqual(systemConfigFiles({}), ["/etc/xdg/skills-pages/config.json"]);
  });
});
