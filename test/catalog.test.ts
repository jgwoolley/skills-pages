import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discover, parseFrontmatter, toTags } from "../src/discover.ts";
import { defaultMethod, estimateTokens, formatBytes, formatTokens, methods, totalSize, type InstallData, type Method } from "../src/install.ts";
import { buildCopyMarketplace, buildMarketplace, matchRepoMarketplace, mergeMarketplace, reservedMarketplaceName, reservedPluginName, type CopyEntry } from "../src/marketplace.ts";
import { publish } from "../src/publish.ts";
import { commitUrl, parseRemote } from "../src/source.ts";
import type { SourceInfo } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string, remote = "git@github.com:acme/skills.git"): SourceInfo => ({
  dir: path.join(here, "fixtures", name),
  local: true,
  remote: parseRemote(remote),
  sha: "0123456789abcdef0123456789abcdef01234567",
  commitUrl: commitUrl(parseRemote(remote), "0123456789abcdef0123456789abcdef01234567"),
  cleanup: async () => {},
});

describe("parseRemote", () => {
  it("normalises ssh, https, credentials and ports", () => {
    for (const r of [
      "git@github.com:acme/skills.git",
      "ssh://git@github.com/acme/skills.git",
      "https://user:token@github.com/acme/skills",
      "https://github.com/acme/skills.git/",
      "ssh://git@github.com:22/acme/skills.git",
    ]) {
      const info = parseRemote(r)!;
      assert.equal(info.webUrl, "https://github.com/acme/skills", r);
      assert.equal(info.sshUrl, "git@github.com:acme/skills.git", r);
      assert.equal(info.httpsUrl, "https://github.com/acme/skills.git", r);
      assert.equal(info.pagesUrl, "https://acme.github.io/skills/", r);
    }
  });
  it("handles GitLab subgroups and commit links", () => {
    const info = parseRemote("git@gitlab.com:Group/sub/proj.git")!;
    assert.equal(info.owner, "Group/sub");
    assert.equal(info.pagesUrl, "https://group.gitlab.io/sub/proj/");
    assert.equal(commitUrl(info, "abc"), "https://gitlab.com/Group/sub/proj/-/commit/abc");
  });
  it("user pages repos and self-hosted hosts", () => {
    assert.equal(parseRemote("https://github.com/acme/acme.github.io")!.pagesUrl, "https://acme.github.io/");
    assert.equal(parseRemote("git@git.example.com:team/skills.git")!.pagesUrl, undefined);
  });
});

describe("discover", () => {
  it("parses frontmatter", () => {
    assert.deepEqual(parseFrontmatter("---\nname: x\ndescription: y\n---\nbody"), { name: "x", description: "y" });
    assert.deepEqual(parseFrontmatter("no frontmatter"), {});
    assert.deepEqual(parseFrontmatter("---\nname: x\ndescription: Do X: then Y\n---\n"), { name: "x", description: "Do X: then Y" });
  });
  it("normalises tags from lists, comma strings and the lenient parser", () => {
    assert.deepEqual(toTags(["Git", " review ", 42], "git, Security", undefined, 7), ["git", "review", "42", "security"]);
    assert.deepEqual(toTags("[a11y, 'web']"), ["a11y", "web"]);
    assert.deepEqual(toTags({ not: "tags" }), []);
  });
  it("reads tags from frontmatter, metadata and plugin keywords", async () => {
    const cat = await discover({ ...fixture("root-layout"), dir: path.join(here, "fixtures", "example-catalog") });
    const tags = Object.fromEntries(cat.skills.map((s) => [s.name, s.tags]));
    assert.deepEqual(tags["code-review-checklist"], ["git", "review", "security"]);
    assert.deepEqual(tags["static-site-checks"], ["privacy", "deploy", "web"]);
    assert.deepEqual(tags["accessibility-audit"], ["a11y", "review", "web"]);
    assert.deepEqual(tags["csv-cleanup"], ["csv", "cleaning"]);
  });
  it("warns about descriptions over the Agent Skills limit of 1024 characters", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "long-desc-"));
    try {
      await mkdir(path.join(dir, "skills", "wordy"), { recursive: true });
      await writeFile(path.join(dir, "skills", "wordy", "SKILL.md"), `---\nname: wordy\ndescription: ${"x".repeat(1100)}\n---\n`);
      const cat = await discover({ ...fixture("root-layout"), dir });
      assert.ok(cat.warnings.some((w) => w.includes("1100 characters, over the Agent Skills limit of 1024")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("finds root-level skills as one synthetic plugin", async () => {
    const cat = await discover(fixture("root-layout"));
    assert.equal(cat.name, "skills");
    assert.deepEqual(cat.skills.map((s) => s.name), ["alpha", "beta"]);
    assert.equal(cat.plugins.length, 1);
    assert.equal(cat.plugins[0]!.root, true);
    assert.equal(cat.piPackage, true);
    assert.deepEqual(cat.skills[1]!.files, ["scripts/run.sh", "SKILL.md"]);
  });
  it("finds plugin skills, keeps the existing marketplace name and de-duplicates entry names", async () => {
    const cat = await discover(fixture("plugin-layout"));
    assert.equal(cat.name, "fixture-market");
    assert.equal(cat.owner.name, "Fixture Owner");
    assert.equal(cat.piPackage, false);
    assert.deepEqual(cat.skills.map((s) => [s.name, s.entry]), [["gamma", "gamma"], ["tools", "tools-tools"]]);
    assert.equal(cat.plugins[0]!.description, "Hand-written description");
  });
  it("--name overrides the existing marketplace name", async () => {
    assert.equal((await discover(fixture("plugin-layout"), { name: "My Skills" })).name, "my-skills");
  });
});

describe("preserving incoming plugins", () => {
  it("flags names Claude Code reserves for Anthropic", () => {
    for (const n of ["claude-api", "anthropic-tools", "claude", "claude-code", "cc-plugin-x", "my-claude-official"]) assert.equal(reservedPluginName(n), true, n);
    for (const n of ["claudette", "pdf", "document-skills", "my-claude-helper"]) assert.equal(reservedPluginName(n), false, n);
  });
  it("uses the repo marketplace's grouping, keeps extra fields, passes external entries through", async () => {
    const src = fixture("marketplace-layout");
    const cat = await discover(src);
    assert.equal(cat.name, "grouped");
    const groups = Object.fromEntries(cat.plugins.map((p) => [p.name, p.skills.map((s) => s.name)]));
    assert.deepEqual(groups, { "document-skills": ["docx", "pdf"], solo: ["solo"], elsewhere: [], grouped: ["loose"] });
    assert.equal(cat.plugins.find((p) => p.name === "elsewhere")!.external, true);
    const solo = cat.skills.find((s) => s.name === "solo")!;
    assert.equal(solo.entry, "solo");
    assert.equal(solo.entryIsPlugin, true);

    // Copy-based marketplaces (local folder / archives) point at ./public/<skill>/ and keep the entries' other fields.
    const version = (e: CopyEntry) => `v-${e.name}`;
    const local = buildCopyMarketplace(cat, src, { mode: "local", version });
    const by = (n: string) => local.marketplace.plugins.find((p) => p.name === n);
    assert.deepEqual(by("document-skills"), {
      name: "document-skills",
      description: "Office documents",
      category: "productivity",
      version: "v-document-skills",
      source: "./",
      strict: false,
      skills: ["./docx", "./pdf"],
    });
    assert.deepEqual(by("solo"), { name: "solo", description: "Solo plugin", version: "v-solo", source: "./", strict: false, skills: ["./solo"] });
    assert.deepEqual(by("elsewhere"), cat.existing.claude!.plugins[2], "external entry unchanged");
    assert.deepEqual(local.marketplace.plugins.map((p) => p.name), ["document-skills", "solo", "elsewhere", "grouped", "docx", "pdf", "loose"], "no duplicate entry for solo");
    assert.deepEqual(local.skillEntries, ["docx", "pdf", "solo", "loose"]);
    // Archives: a zip of exactly the plugin's skills (no bundle workaround needed).
    const archive = (e: CopyEntry) => ({ url: `https://site/claude/archives/${e.name}.zip`, sha256: "ab".repeat(32), version: `z-${e.name}` });
    const site = buildCopyMarketplace(cat, src, { mode: "archive", version, archive });
    assert.deepEqual(site.marketplace.plugins.find((p) => p.name === "document-skills"), {
      name: "document-skills",
      description: "Office documents",
      category: "productivity",
      version: "z-document-skills",
      source: { source: "archive", url: "https://site/claude/archives/document-skills.zip", sha256: "ab".repeat(32) },
    });
    // oh-my-pi (no archive source) keeps git sources and reads the subset from the repo's own file in the clone.
    const omp = buildMarketplace(cat, src, { mode: "https" }).marketplace;
    assert.deepEqual(omp.plugins.find((p) => p.name === "document-skills"), { ...cat.existing.claude!.plugins[0], source: { source: "url", url: "https://github.com/acme/skills.git" } });
    // Read back from the repo, every preserved plugin and the solo skill are recognised.
    assert.deepEqual(matchRepoMarketplace(cat, cat.existing.claude), { plugins: ["document-skills", "solo", "elsewhere"], skills: ["solo"] });
  });
});

describe("marketplaces", () => {
  it("oh-my-pi git catalog: incoming entries with absolute sources, no single-skill entries", async () => {
    const src = fixture("plugin-layout");
    const cat = await discover(src);
    const { marketplace, skillEntries } = buildMarketplace(cat, src, { mode: "ssh" });
    assert.deepEqual(marketplace.plugins.find((p) => p.name === "tools"), { name: "tools", source: { source: "git-subdir", url: "git@github.com:acme/skills.git", path: "plugins/tools" }, description: "Hand-written description", category: "dev" });
    assert.deepEqual(marketplace.plugins.map((p) => p.name), ["tools", "extra"]);
    assert.deepEqual(skillEntries, []);
  });
  it("root layout: url source listing every skill", async () => {
    const src = fixture("root-layout");
    const { marketplace } = buildMarketplace(await discover(src), src, { mode: "https" });
    assert.deepEqual(marketplace.plugins[0], {
      name: "skills",
      source: { source: "url", url: "https://github.com/acme/skills.git" },
      description: "All skills in skills",
      strict: false,
      skills: ["./skills/alpha", "./skills/beta"],
    });
  });
  it("copy marketplaces skip plugins without skills (only skills are copied)", async () => {
    const src = fixture("plugin-layout");
    const r = buildCopyMarketplace(await discover(src), src, { mode: "local", version: () => "v" });
    assert.deepEqual(r.marketplace.plugins.map((p) => p.name), ["tools", "gamma", "tools-tools"]);
    assert.ok(r.warnings.some((w) => w.includes('"extra" has no skills')));
  });
  it("refuses marketplace names Claude Code reserves", () => {
    for (const n of ["anthropic-agent-skills", "claude-plugins-official", "agent-skills", "claude.code.plugins", "official-claude-plugins", "claude-plugins-v2", "claudeai-mine", "github", "skills-dir", "café"])
      assert.ok(reservedMarketplaceName(n), n);
    for (const n of ["skills-example", "ai-skills", "installed-skills", "my-claude-tools", "anthropic-skills-mirror"]) assert.equal(reservedMarketplaceName(n), undefined, n);
  });
  it("relative (repo) catalog + merge keeps hand-written entries and recognises its own output", async () => {
    const src = fixture("plugin-layout");
    const cat = await discover(src);
    const gen = buildMarketplace(cat, src, { mode: "relative" });
    assert.deepEqual(gen.marketplace.plugins.find((p) => p.name === "gamma"), { name: "gamma", description: "Gamma skill.", source: "./", strict: false, skills: ["./plugins/tools/skills/gamma"] });
    assert.deepEqual(gen.marketplace.plugins.slice(0, 2), cat.existing.claude!.plugins, "incoming entries written back verbatim");
    assert.equal(gen.marketplace.metadata?.version, undefined, "no sha in repo files");
    const merged = mergeMarketplace(cat.existing.claude, gen.marketplace, gen.skillEntries);
    assert.deepEqual(merged.plugins.map((p) => p.name), ["tools", "extra", "gamma", "tools-tools"]);
    assert.equal(merged.plugins[0]!.category, "dev");
    assert.equal(merged.name, "fixture-market");
    assert.deepEqual(matchRepoMarketplace(cat, merged), { plugins: ["tools", "extra"], skills: ["gamma", "tools-tools"] });
    // Rebuilding from a repo whose marketplace now contains those single-skill entries: they stay skill entries,
    // not extra plugins (the skills already belong to "tools").
    const dir = await mkdtemp(path.join(tmpdir(), "rewrite-"));
    try {
      await cp(src.dir, dir, { recursive: true });
      await writeFile(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(merged));
      const again = await discover({ ...src, dir });
      assert.deepEqual(again.plugins.map((p) => p.name), ["tools", "extra"]);
      assert.deepEqual(again.skills.map((x) => [x.name, x.entry]), [["gamma", "gamma"], ["tools", "tools-tools"]]);
      assert.deepEqual(matchRepoMarketplace(again, merged).skills, ["gamma", "tools-tools"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.deepEqual(matchRepoMarketplace(cat, cat.existing.claude), { plugins: ["tools", "extra"], skills: [] });
  });
});

const data = (over: Partial<InstallData> = {}): InstallData => ({
  name: "mkt",
  title: "Mkt",
  siteUrl: "https://acme.github.io/skills/",
  repo: { https: "https://github.com/acme/skills.git", ssh: "git@github.com:acme/skills.git", web: "https://github.com/acme/skills", blob: "https://github.com/acme/skills/blob/HEAD/" },
  git: { claude: false, omp: false, claudeSkills: [], ompSkills: [], claudeEntries: [], ompEntries: [] },
  json: { claudeSkills: ["alpha"], ompSkills: [] },
  siteArchives: true,
  piPackage: true,
  mixedLayout: false,
  plugins: [{ name: "skills", skills: ["alpha"] }],
  skills: [{ name: "alpha", entry: "alpha", plugin: "skills", description: "", tags: [], dir: "skills/alpha", files: ["SKILL.md"], size: { always: 2, invoke: 10, bytes: 60 } }],
  ...over,
});
type Opts = Parameters<typeof methods>[2];
/** Methods that work as built (blocked ones are listed too, with a reason; see below). */
const ids = (d: InstallData, agent: string, o: Opts) => methods(d, agent, o).filter((m) => !m.blocked).map((m) => m.id);
const blockedOf = (d: InstallData, agent: string, id: string, o: Opts) => methods(d, agent, o).find((m) => m.id === id)?.blocked;
const method = (d: InstallData, agent: string, id: string, o: Opts) => methods(d, agent, o).find((m) => m.id === id)!;
/** Commands per phase: { setup: [...], install: [...], update: [...] } */
const phases = (m: Method) => Object.fromEntries(m.phases.map((p) => [p.kind, p.steps.map((s) => s.code)]));
const gitAll = { claude: true, omp: true, claudeSkills: ["alpha"], ompSkills: ["alpha"], claudeEntries: ["skills"], ompEntries: ["skills"], claudeName: "repo-mkt" };

describe("install methods", () => {
  const https = { protocol: "https", scope: "global" } as const;
  it("each agent offers its native methods first, then the skills CLI", () => {
    assert.deepEqual(ids(data(), "claude", https), ["site-marketplace", "skills-cli"]);
    assert.deepEqual(ids(data({ git: gitAll }), "claude", https), ["git-marketplace", "site-marketplace", "skills-cli"]);
    assert.deepEqual(ids(data(), "opencode", https), ["remote-index", "skills-cli"]);
    assert.deepEqual(ids(data(), "pi", https), ["pi-package", "skills-cli"]);
    assert.deepEqual(ids(data(), "pi", { ...https, skill: "alpha" }), ["skills-cli"], "pi has no single-skill install");
    assert.deepEqual(ids(data(), "omp", { ...https, skill: "alpha" }), ["skills-cli"], "no omp single-skill entry in the site JSON");
    assert.deepEqual(ids(data(), "cursor", https), ["skills-cli"]);
  });
  it("Claude Code site marketplace: setup / install / update", () => {
    const m = method(data(), "claude", "site-marketplace", { protocol: "ssh", scope: "project" });
    assert.deepEqual(phases(m), {
      setup: ["claude plugin marketplace add https://acme.github.io/skills/claude/marketplace.json"],
      install: ["claude plugin install skills@mkt --scope project"],
      update: ["claude plugin marketplace update mkt\nclaude plugin update skills@mkt"],
    });
    assert.deepEqual(m.phases[0]!.notes, ["Source: [claude/marketplace.json](claude/marketplace.json) on this site; plugins are zip archives of the skills, also from this site (the HTTPS/SSH choice doesn't apply)."]);
    // Not on public HTTPS (e.g. an http://localhost preview): still offered, with a note.
    const preview = method(data({ siteArchives: false }), "claude", "site-marketplace", { protocol: "https", scope: "global" });
    assert.ok(preview.phases[0]!.notes!.some((n) => n.includes("once it's deployed over HTTPS")));
    assert.ok(!m.phases[0]!.notes!.some((n) => n.includes("deployed over HTTPS")));
  });
  it("never points at the machine that built the site: only the site or the repo", () => {
    // No repo (e.g. --installed): Claude Code uses the site's archives, the skills CLI the site's well-known index.
    const d = data({ repo: null, siteArchives: false });
    for (const a of ["claude", "omp", "opencode", "pi", "cursor"])
      for (const scope of ["global", "project"] as const)
        for (const extra of [{}, { skill: "alpha" }, { plugin: "skills" }])
          for (const m of methods(d, a, { protocol: "https", scope, ...extra }))
            for (const ph of m.phases)
              for (const st of ph.steps) assert.doesNotMatch(st.code, /(^|\s)(~|\/)[^\s]*\//, `${a}/${m.id}: ${st.code}`);
    assert.deepEqual(ids(d, "claude", { protocol: "https", scope: "global" }), ["site-marketplace", "skills-cli"]);
    assert.deepEqual(ids(d, "omp", { protocol: "https", scope: "global" }), ["skills-cli"], "oh-my-pi's site catalog needs git sources");
    const cli = method(d, "cursor", "skills-cli", { protocol: "ssh", scope: "global", skill: "alpha" });
    assert.deepEqual(phases(cli).install, ["DISABLE_TELEMETRY=1 npx skills add https://acme.github.io/skills/ --skill alpha --agent cursor -g -y"]);
    assert.match(cli.phases[0]!.notes![0]!, /^Source: \[\.well-known\/agent-skills\/index\.json\]/);
  });
  it("a local build of a public URL still shows the commands, with a heads-up about deploying", () => {
    const g = { protocol: "https", scope: "global" } as const;
    const local = data({ deploy: { builtBy: "local" } });
    const note = (d: InstallData, agent: string, id: string) => method(d, agent, id, g).phases[0]!.notes!.find((n) => n.startsWith("Heads-up"));
    assert.match(note(local, "claude", "site-marketplace")!, /built on a local machine, not by CI\. These commands work once it's deployed to `https:\/\/acme\.github\.io\/skills\/`/);
    assert.ok(note(local, "opencode", "remote-index"));
    assert.match(note(data({ deploy: { builtBy: "local", noCommits: true } }), "claude", "site-marketplace")!, /no commits yet/);
    assert.equal(note(data({ deploy: { builtBy: "ci" } }), "claude", "site-marketplace"), undefined, "CI builds are assumed deployed");
    assert.equal(note(data({ deploy: { builtBy: "local" }, siteUrl: "http://localhost:4173/" }), "opencode", "remote-index"), undefined, "local previews get no heads-up");
    assert.equal(note(local, "codex", "skills-cli"), undefined, "the repo-based skills CLI doesn't depend on the site");
  });
  it("never hides a method for a configuration gap: it's listed with the reason and the fix", () => {
    const g = { protocol: "https", scope: "global" } as const;
    // Unknown site URL: site-based methods warn instead of giving commands that point at a placeholder.
    const unknown = data({ siteUrlKnown: false, siteUrl: "http://localhost:8080/" });
    for (const [agent, id] of [["claude", "site-marketplace"], ["omp", "site-marketplace"], ["opencode", "remote-index"]] as const) {
      const b = blockedOf(unknown, agent, id, g);
      assert.ok(b?.reason.includes("site URL wasn't known") && b.fix.includes("--base-url"), `${agent}/${id}`);
    }
    assert.deepEqual(ids(unknown, "claude", g), ["skills-cli"], "the repo-based skills CLI still works");
    assert.ok(blockedOf(data({ siteUrlKnown: false, repo: null }), "cursor", "skills-cli", g)?.fix.includes("--base-url"));
    // No repo: git marketplace, oh-my-pi's site catalog and the pi package explain and say how to fix it.
    const norepo = data({ repo: null });
    for (const [agent, id] of [["claude", "git-marketplace"], ["omp", "git-marketplace"], ["omp", "site-marketplace"], ["pi", "pi-package"]] as const)
      assert.ok(blockedOf(norepo, agent, id, g)?.fix.includes("--repo-url"), `${agent}/${id}`);
    // A repo without a marketplace file.
    assert.ok(blockedOf(data(), "claude", "git-marketplace", g)?.fix.includes("--write-repo"));
    // Not fixable by configuration, but still explained.
    // Methods that can't do the job here are listed too, saying what to use instead.
    const one = blockedOf(data(), "pi", "pi-package", { ...g, skill: "alpha" })!;
    assert.equal(one.kind, "instead");
    assert.match(one.reason, /whole repository at a time, so it can't install just alpha/);
    assert.match(one.fix, /skills CLI tab/);
    const inst = data({ repo: null, installed: true });
    const pi = blockedOf(inst, "pi", "pi-package", g)!;
    assert.equal(pi.kind, "instead");
    assert.match(pi.reason, /git repository that pi clones .* collected from the machine that built this site/);
    assert.deepEqual(ids(inst, "pi", g), ["skills-cli"]);
    assert.match(blockedOf(inst, "claude", "git-marketplace", g)!.fix, /Site marketplace tab/);
    assert.match(blockedOf(inst, "omp", "site-marketplace", g)!.reason, /zip files/);
    assert.equal(blockedOf(data({ repo: null }), "claude", "git-marketplace", g)!.kind, "fix", "a missing repo is fixable");
    assert.match(blockedOf(data(), "omp", "site-marketplace", { ...g, skill: "alpha" })!.reason, /single skill only from a marketplace inside the repository/);
    assert.equal(methods(data(), "claude", g).find((m) => !m.blocked)!.id, "site-marketplace", "a working method is the default");
    assert.equal(defaultMethod(methods(data({ repo: null, siteUrlKnown: false }), "claude", g))!.id, "site-marketplace", "when nothing works, the site URL fix is shown first");
  });
  it("Git marketplace warnings describe the actual checkout: not a repo, no origin, or no marketplace file", () => {
    const g = { protocol: "https", scope: "global" } as const;
    const co = (c: Partial<NonNullable<InstallData["checkout"]>>) => ({ isGitRepo: true, hasCommits: true, claudeFile: true, ompFile: false, ...c });
    // A git repo with the marketplace files but no origin (e.g. ai-skills before pushing).
    const noOrigin = blockedOf(data({ repo: null, checkout: co({ hasCommits: false }) }), "claude", "git-marketplace", g)!;
    assert.match(noOrigin.reason, /no `origin` remote, so there's no URL .* Its marketplace file \(`\.claude-plugin\/marketplace\.json`\) is ready\./);
    assert.match(noOrigin.fix, /^Commit, add the remote and push/);
    assert.doesNotMatch(noOrigin.reason, /without a git repository/);
    // No marketplace file either.
    const noFile = blockedOf(data({ repo: null, checkout: co({ claudeFile: false }) }), "claude", "git-marketplace", g)!;
    assert.match(noFile.fix, /^Run `skills-pages repo-files`, then add the remote/);
    // Not a git repository at all.
    assert.match(blockedOf(data({ repo: null, checkout: co({ isGitRepo: false }) }), "claude", "git-marketplace", g)!.reason, /wasn't built from a git repository/);
    // Origin and files, but no commits yet: the commands are shown, with a heads-up to push first.
    const ready = data({ git: gitAll, checkout: co({ hasCommits: false }) });
    assert.ok(method(ready, "claude", "git-marketplace", g).phases[0]!.notes!.some((n) => n.includes("no commits yet. Commit and push `.claude-plugin/marketplace.json`")));
  });
  it("git marketplace uses the repo's marketplace name; oh-my-pi uses upgrade", () => {
    const d = data({ git: gitAll });
    assert.deepEqual(phases(method(d, "claude", "git-marketplace", { protocol: "ssh", scope: "global" })), {
      setup: ["claude plugin marketplace add git@github.com:acme/skills.git"],
      install: ["claude plugin install skills@repo-mkt --scope user"],
      update: ["claude plugin marketplace update repo-mkt\nclaude plugin update skills@repo-mkt"],
    });
    assert.deepEqual(phases(method(d, "omp", "git-marketplace", { protocol: "https", scope: "project", skill: "alpha" })), {
      setup: ["omp plugin marketplace add https://github.com/acme/skills.git"],
      install: ["omp plugin install --scope project alpha@mkt"],
      update: ["omp plugin marketplace update mkt\nomp plugin upgrade --scope project alpha@mkt"],
    });
  });
  it("skills CLI targets only the selected agent", () => {
    assert.deepEqual(phases(method(data(), "cursor", "skills-cli", { protocol: "ssh", scope: "global" })), {
      install: ["DISABLE_TELEMETRY=1 npx skills add git@github.com:acme/skills.git --skill '*' --agent cursor -g -y"],
      update: ["DISABLE_TELEMETRY=1 npx skills update -g -y"],
    });
    assert.deepEqual(phases(method(data(), "omp", "skills-cli", { protocol: "https", scope: "project", skill: "alpha" })), {
      install: ["DISABLE_TELEMETRY=1 npx skills add https://github.com/acme/skills.git --skill alpha --agent pi -y"],
      update: ["DISABLE_TELEMETRY=1 npx skills update alpha -p -y"],
    });
  });
  it("no method has alternatives inside, and none mentions another method", () => {
    for (const a of ["claude", "opencode", "pi", "omp", "codex"])
      for (const m of methods(data({ git: gitAll, mixedLayout: true }), a, https)) {
        const text = JSON.stringify(m);
        assert.doesNotMatch(text, /Or with the skills CLI|Fallback/, `${a}/${m.id}`);
        for (const ph of m.phases) assert.ok(ph.steps.length <= 1, `${a}/${m.id}/${ph.kind} has one path`);
      }
  });
  it("OpenCode remote index: config file per scope, update is automatic", () => {
    const m = method(data(), "opencode", "remote-index", { protocol: "https", scope: "project", skill: "alpha" });
    assert.equal(m.phases[0]!.steps[0]!.file, "opencode.json");
    assert.deepEqual(JSON.parse(m.phases[0]!.steps[0]!.code).skills, { urls: ["https://acme.github.io/skills/opencode/alpha/"] });
    assert.deepEqual(m.phases[1]!.steps, []);
    assert.equal(method(data(), "opencode", "remote-index", https).phases[0]!.steps[0]!.file, "~/.config/opencode/opencode.json");
  });
  it("pi package per protocol and scope", () => {
    assert.deepEqual(phases(method(data(), "pi", "pi-package", { protocol: "ssh", scope: "project" })), { install: ["pi install git:git@github.com:acme/skills -l"], update: ["pi update"] });
    assert.deepEqual(phases(method(data(), "pi", "pi-package", https)).install, ["pi install https://github.com/acme/skills"]);
  });
  it("every method follows the same shape: Source note first, one Global/Project note, Install title names a folder", () => {
    for (const d of [data(), data({ git: gitAll }), data({ repo: null, siteArchives: false })])
      for (const a of ["claude", "opencode", "pi", "omp", "codex"])
        for (const scope of ["global", "project"] as const)
          for (const m of methods(d, a, { protocol: "https", scope })) {
            const where = `${a}/${m.id}/${scope}`;
            if (m.blocked) {
              assert.ok(m.blocked.reason && m.blocked.fix && !m.phases.length, `${where}: blocked = reason + fix, no commands`);
              continue;
            }
            assert.match(m.phases[0]!.notes?.[0] ?? "", /^Source: /, `${where}: source note first`);
            const inst = m.phases.find((p) => p.kind === "install")!;
            assert.match(inst.steps[0]!.title, /^Install .+ into `[^`]+`$/, `${where}: install title`);
            assert.equal(inst.notes!.filter((n) => /^(Global|Project): /.test(n)).length, 1, `${where}: one scope note`);
            assert.ok(inst.notes!.some((n) => n.startsWith(scope === "global" ? "Global: " : "Project: ")), `${where}: scope note matches`);
            const upd = m.phases.find((p) => p.kind === "update")!;
            assert.ok(upd.steps.length ? /^(Update|Refresh the marketplace and update) /.test(upd.steps[0]!.title) : /^Automatic: /.test(upd.notes![0]!), `${where}: update`);
          }
  });
  it("git marketplace links the repo's own marketplace file", () => {
    const note = method(data({ git: gitAll }), "claude", "git-marketplace", { protocol: "ssh", scope: "global" }).phases[0]!.notes![0];
    assert.equal(note, "Source: [.claude-plugin/marketplace.json](https://github.com/acme/skills/blob/HEAD/.claude-plugin/marketplace.json) in [github.com/acme/skills](https://github.com/acme/skills), cloned over SSH.");
  });
  it("plugin scope: install just that plugin", () => {
    const d = data({
      git: { ...gitAll, claudeEntries: ["skills", "docs"] },
      plugins: [{ name: "skills", skills: ["alpha"] }, { name: "docs", skills: ["alpha", "beta"] }, { name: "far", skills: [], external: true }],
    });
    const o = { protocol: "https", scope: "global", plugin: "docs" } as const;
    assert.deepEqual(ids(d, "claude", o), ["git-marketplace", "site-marketplace", "skills-cli"]);
    assert.deepEqual(phases(method(d, "claude", "git-marketplace", o)).install, ["claude plugin install docs@repo-mkt --scope user"]);
    assert.equal(method(d, "claude", "site-marketplace", o).phases[1]!.steps[0]!.title, "Install docs into `~/.claude/plugins/cache/mkt/docs/`");
    assert.deepEqual(phases(method(d, "cursor", "skills-cli", o)), {
      install: ["DISABLE_TELEMETRY=1 npx skills add https://github.com/acme/skills.git --skill alpha beta --agent cursor -g -y"],
      update: ["DISABLE_TELEMETRY=1 npx skills update alpha beta -g -y"],
    });
    assert.equal(method(d, "cursor", "skills-cli", o).phases[0]!.steps[0]!.title, "Install the 2 skills in docs into `~/.cursor/skills/`");
    const oc = JSON.parse(method(d, "opencode", "remote-index", o).phases[0]!.steps[0]!.code);
    assert.deepEqual(oc.skills.urls, ["https://acme.github.io/skills/opencode/alpha/", "https://acme.github.io/skills/opencode/beta/"]);
    assert.deepEqual(ids(d, "pi", o), ["skills-cli"], "no pi package for a plugin");
    // Per-skill methods say what they really install, and that later membership changes aren't followed.
    const snapshot = (m: Method) => m.phases[0]!.notes!.some((n) => n.startsWith("Installs the current skills of docs individually"));
    assert.equal(method(d, "opencode", "remote-index", o).phases[0]!.steps[0]!.title, "Install the 2 skills in docs into `~/.cache/opencode/skills/`");
    assert.ok(snapshot(method(d, "opencode", "remote-index", o)) && snapshot(method(d, "cursor", "skills-cli", o)));
    assert.ok(!snapshot(method(d, "claude", "git-marketplace", o)), "marketplaces install the plugin as a unit");
    assert.ok(!snapshot(method(d, "cursor", "skills-cli", { ...o, plugin: undefined })), "not on the catalog page");
    // A plugin from another repo: only marketplaces can install it.
    assert.deepEqual(ids(d, "opencode", { ...o, plugin: "far" }), []);
    assert.deepEqual(ids(d, "claude", { ...o, plugin: "far" }), ["site-marketplace"]);
  });
  it("install steps name their destination folder (copyable)", () => {
    const title = (agent: string, id: string, o: Opts, d = data({ git: gitAll })) =>
      method(d, agent, id, o).phases.find((p) => p.kind === "install")!.steps[0]!.title;
    const g = { protocol: "https", scope: "global" } as const;
    const p = { protocol: "https", scope: "project" } as const;
    assert.equal(title("claude", "site-marketplace", g), "Install the plugin into `~/.claude/plugins/cache/mkt/`");
    assert.equal(title("claude", "site-marketplace", { ...p, skill: "alpha" }), "Install alpha into `~/.claude/plugins/cache/mkt/alpha/`");
    assert.equal(title("claude", "git-marketplace", g), "Install the plugin into `~/.claude/plugins/cache/repo-mkt/`");
    assert.equal(title("omp", "site-marketplace", g), "Install the plugin into `~/.omp/plugins/cache/plugins/`");
    assert.equal(title("pi", "pi-package", g), "Install the package into `~/.pi/agent/git/github.com/acme/skills/`");
    assert.equal(title("pi", "pi-package", p), "Install the package into `.pi/git/github.com/acme/skills/`");
    assert.equal(title("cursor", "skills-cli", g), "Install every skill into `~/.cursor/skills/`");
    assert.equal(title("cursor", "skills-cli", { ...p, skill: "alpha" }), "Install alpha into `.agents/skills/alpha/`");
    assert.equal(title("claude", "skills-cli", p), "Install every skill into `.claude/skills/`");
    const setup = method(data({ git: gitAll }), "claude", "git-marketplace", g).phases[0]!.steps[0]!.title;
    assert.equal(setup, "Add the marketplace into `~/.claude/plugins/marketplaces/repo-mkt/`");
    assert.equal(method(data(), "claude", "site-marketplace", g).phases[0]!.steps[0]!.title, "Add the marketplace into `~/.claude/plugins/marketplaces/mkt/`");
    assert.equal(method(data(), "omp", "site-marketplace", g).phases[0]!.steps[0]!.title, "Add the marketplace into `~/.omp/plugins/cache/marketplaces/mkt/`");
    assert.equal(method(data(), "opencode", "remote-index", g).phases[0]!.steps[0]!.title, "Install every skill into `~/.cache/opencode/skills/`");
    const proj = method(data(), "claude", "site-marketplace", p).phases.find((x) => x.kind === "install")!.notes!;
    assert.deepEqual(proj, ["Project: enabled in `.claude/settings.json`; commit it to share."]);
  });
  it("skills CLI uses the site when the repo hides skills from it (root skills/ plus plugins/, no repo marketplace)", () => {
    const g = { protocol: "https", scope: "global" } as const;
    const code = (d: InstallData) => phases(method(d, "codex", "skills-cli", g)).install![0]!;
    assert.match(code(data({ mixedLayout: true })), /npx skills add https:\/\/acme\.github\.io\/skills\/ /);
    assert.match(code(data({ mixedLayout: true, git: { ...data().git, claude: true } })), /npx skills add https:\/\/github\.com\/acme\/skills\.git /);
    assert.match(code(data()), /npx skills add https:\/\/github\.com\/acme\/skills\.git /);
  });
});

describe("context estimate", () => {
  it("estimates ~4 characters per token and formats sizes", () => {
    assert.equal(estimateTokens("abcd".repeat(25)), 25);
    assert.equal(estimateTokens("abc"), 1);
    assert.deepEqual(totalSize([{ always: 10, invoke: 100, bytes: 1000 }, { always: 5, invoke: 50, bytes: 24 }]), { always: 15, invoke: 150, bytes: 1024 });
    assert.deepEqual([formatTokens(69), formatTokens(1234), formatTokens(18_400)], ["~69", "~1.2k", "~18k"]);
    assert.deepEqual([formatBytes(900), formatBytes(2048), formatBytes(51_200), formatBytes(2_500_000)], ["900 B", "2.0 KB", "50 KB", "2.4 MB"]);
  });
});

describe("publish", () => {
  it("writes the site, marketplaces and resolvable OpenCode indexes", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "skills-pages-test-"));
    try {
      const src = fixture("root-layout");
      const cat = await discover(src);
      const git = { claude: false, omp: false, claudeSkills: [], ompSkills: [], claudeEntries: [], ompEntries: [] };
      await publish(cat, src, { out, siteUrl: "https://acme.github.io/skills/", git });
      const index = JSON.parse(await readFile(path.join(out, "index.json"), "utf8")) as { skills: { name: string; files: string[]; version: string }[] };
      for (const s of index.skills) for (const f of s.files) await readFile(path.join(out, s.name, f));
      const one = JSON.parse(await readFile(path.join(out, "opencode", "beta", "index.json"), "utf8")) as typeof index;
      for (const f of one.skills[0]!.files) await readFile(path.join(out, "opencode", "beta", "beta", f));
      for (const f of [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json", "claude/marketplace.json", "omp/marketplace.json", "omp/marketplace.ssh.json", "assets/app.js", "assets/install.js", "assets/app.css"])
        await readFile(path.join(out, f));
      // Local marketplace: relative sources to the copies, which exist.
      const localM = JSON.parse(await readFile(path.join(out, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins: { name: string; skills?: string[] }[] };
      for (const e of localM.plugins) for (const sp of e.skills ?? []) await readFile(path.join(out, sp, "SKILL.md"));
      // Archives: valid zips (checked with Python's zipfile), sha256 matches, contents are skills/<name>/….
      const siteM = JSON.parse(await readFile(path.join(out, "claude", "marketplace.json"), "utf8")) as { plugins: { name: string; source: { url: string; sha256: string } }[] };
      for (const e of siteM.plugins) {
        const zipFile = path.join(out, "claude", "archives", `${e.name}.zip`);
        assert.equal(createHash("sha256").update(await readFile(zipFile)).digest("hex"), e.source.sha256, `${e.name} sha256`);
        assert.equal(e.source.url, `https://acme.github.io/skills/claude/archives/${e.name}.zip`);
        const listing = execFileSync("python3", ["-I", "-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))", zipFile], { encoding: "utf8" });
        assert.ok(listing.trim().split("\n").every((n) => /^skills\/(alpha|beta)\//.test(n)), listing);
      }
      // Well-known discovery index for the skills CLI: zip per skill with SKILL.md at its root, digest matches.
      const wk = JSON.parse(await readFile(path.join(out, ".well-known", "agent-skills", "index.json"), "utf8")) as { $schema: string; skills: { name: string; type: string; url: string; digest: string }[] };
      assert.equal(wk.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
      assert.deepEqual(wk.skills.map((x) => [x.name, x.type, x.url]), [["alpha", "archive", "alpha.zip"], ["beta", "archive", "beta.zip"]]);
      for (const e of wk.skills) {
        const z = path.join(out, ".well-known", "agent-skills", e.url);
        assert.equal(`sha256:${createHash("sha256").update(await readFile(z)).digest("hex")}`, e.digest);
        const names = execFileSync("python3", ["-I", "-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(' '.join(sorted(z.namelist())))", z], { encoding: "utf8" }).trim();
        assert.ok(names.split(" ").includes("SKILL.md"), names);
      }
      const betaZip = execFileSync("python3", ["-I", "-c", "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read('skills/beta/scripts/run.sh').decode(), end='')", path.join(out, "claude", "archives", "beta.zip")], { encoding: "utf8" });
      assert.equal(betaZip, "echo hi\n");
      const html = await readFile(path.join(out, "index.html"), "utf8");
      assert.match(html, /Content-Security-Policy/);
      assert.doesNotMatch(html, /__BUILD_TIME__|__COMMIT_URL__/);
      // The footer links to the build page, which links the commit; only the tester may fetch other hosts.
      assert.match(html, /<a id="build-footer-link" href="build\/"/);
      const buildPage = await readFile(path.join(out, "build", "index.html"), "utf8");
      assert.match(buildPage, /https:\/\/github\.com\/acme\/skills\/commit\/0123456789abcdef/);
      assert.match(buildPage, /Built outside CI\/CD/);
      const tester = await readFile(path.join(out, "tester", "index.html"), "utf8");
      assert.match(tester, /connect-src 'self' https: http:/);
      assert.match(html, /connect-src 'self';/);
      assert.match(html, /<a href="tester\/">Tester<\/a>/);
      await readFile(path.join(out, "assets", "vendor", "yaml", "index.js"));
      // skills-pages' install guide is rendered into every site, linked from the navbar and the build page.
      const docs = await readFile(path.join(out, "docs", "install", "index.html"), "utf8");
      assert.match(docs, /<h2 id="requirements">Requirements<\/h2>/);
      assert.match(docs, /<a href="#behind-a-corporate-network">/, "table of contents links the sections");
      assert.match(docs, /<h3 id="preferences-global-defaults-xdg">/, "sub-sections have anchors too");
      assert.doesNotMatch(docs, /<script>|<h1>Installing skills-pages<\/h1>/, "no raw HTML; the page has its own title");
      assert.match(html, /<a href="docs\/install\/">Docs<\/a>/);
      assert.match(buildPage, /href="\.\.\/docs\/install\/">How to install skills-pages/);
      assert.doesNotMatch(html, /<script>/, "no inline executable scripts");
      // One static page per skill, carrying only that skill's data and root-relative assets.
      const page = await readFile(path.join(out, "skill", "beta", "index.html"), "utf8");
      assert.match(page, /href="\.\.\/\.\.\/assets\/app\.css"/);
      assert.match(page, /<h1 class="mono">beta<\/h1>/);
      assert.match(page, /Second test skill\./);
      const pageData = JSON.parse(page.match(/id="catalog-data">(.*?)<\/script>/)![1]!);
      assert.deepEqual(pageData.page, { kind: "skill", skill: "beta", root: "../../" });
      assert.deepEqual(pageData.skills.map((x: { name: string }) => x.name), ["beta"]);
      // Sizes: name+description always, SKILL.md body (no frontmatter) when used, every file on disk.
      const beta = pageData.skills[0].size;
      assert.equal(beta.always, Math.ceil("beta: Second test skill.".length / 4));
      assert.equal(beta.invoke, Math.ceil("# beta\n".length / 4));
      assert.equal(beta.bytes, (await readFile(path.join(here, "fixtures/root-layout/skills/beta/SKILL.md"))).length + (await readFile(path.join(here, "fixtures/root-layout/skills/beta/scripts/run.sh"))).length);
      // The SKILL.md preview comes before the files table; files keep their alphabetical order.
      assert.ok(page.indexOf('id="md-title"') < page.indexOf('id="files-title"'), "SKILL.md preview before Files");
      const fileRows = [...page.matchAll(/<tr><td class="file">.*?<code>([^<]+)<\/code>.*?<\/tr>/g)].map((m) => m[1]);
      assert.deepEqual(fileRows, ["scripts/run.sh", "SKILL.md"]);
      assert.match(page, /<code>SKILL\.md<\/code><\/a> <span class="kind">main<\/span>/);
      assert.match(page, /<nav class="pager" id="files-pager"/);
      const plugins = await readFile(path.join(out, "plugins", "index.html"), "utf8");
      const pluginPage = await readFile(path.join(out, "plugins", "skills", "index.html"), "utf8");
      assert.match(pluginPage, /<li aria-current="page">skills<\/li>/);
      assert.deepEqual(JSON.parse(pluginPage.match(/id="catalog-data">(.*?)<\/script>/)![1]!).page, { kind: "plugin", plugin: "skills", root: "../../" });
      assert.match(plugins, /<a href="\.\.\/plugins\/skills\/">skills<\/a>/);
      assert.doesNotMatch(plugins, /class="tag"/, "no long skill lists in the plugins table");
      assert.match(plugins, /<td class="context">/);
      assert.match(page, /<nav class="topnav"/);
      assert.match(page, /<img class="brand-icon" src="\.\.\/\.\.\/assets\/icons\/icon\.svg"/);
      for (const f of ["manifest.webmanifest", "sw.js", "favicon.ico", "robots.txt", "assets/icons/og.png", "assets/icons/icon-512.png"]) assert.ok(existsSync(path.join(out, f)), f);
      assert.match(page, /<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="\.\.\/\.\.\/">Skills<\/a><\/li><li aria-current="page">beta<\/li><\/ol><\/nav>/);
      assert.doesNotMatch(html, /class="install"|<dialog/, "no install button or dialog");
      const noCommit = (await import("../src/publish.ts")).renderPage(cat, { ...src, commitUrl: undefined, sha: undefined }, { ...JSON.parse("{}") });
      const footer = noCommit.slice(noCommit.indexOf("<footer"));
      assert.match(footer, /href="build\/"/, "the footer always links the build page");
      assert.doesNotMatch(footer, /\/commit\/|href="#"/, "never a commit link it can't back up");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
