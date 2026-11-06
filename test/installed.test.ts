import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverInstalled } from "../src/installed.ts";

let home: string;
let project: string;
const skill = async (dir: string, name: string, description = `The ${name} skill.`) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
};

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "installed-home-"));
  project = path.join(home, "work", "proj");
  await skill(path.join(home, ".claude/skills/alpha"), "alpha");
  await skill(path.join(home, ".agents/skills/beta"), "beta");
  // The skills CLI symlinks agent folders to the shared copy: one skill, listed under both.
  await symlink(path.join(home, ".agents/skills/beta"), path.join(home, ".claude/skills/beta"));
  // Same name, different content elsewhere: kept once, with a warning.
  await skill(path.join(home, ".config/opencode/skills/alpha"), "alpha", "A different alpha.");
  // A Claude Code plugin, found through its own install record.
  const pluginDir = path.join(home, ".claude/plugins/cache/mkt/tools/1.0.0");
  await skill(path.join(pluginDir, "skills/gamma"), "gamma");
  await writeFile(
    path.join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "tools@mkt": [{ scope: "user", installPath: pluginDir }], "other@mkt": [{ scope: "project", installPath: "/nope", projectPath: "/elsewhere" }] } }),
  );
  await skill(path.join(project, ".claude/skills/delta"), "delta");
});
after(() => rm(home, { recursive: true, force: true }));

describe("--installed", () => {
  it("collects global and project skills across agents, grouped by location", async () => {
    const { catalog, locations, src } = await discoverInstalled({ home, cwd: project, env: {} });
    assert.equal(src.dir, "/");
    assert.equal(catalog.name, "installed-skills");
    const groups = Object.fromEntries(catalog.plugins.map((p) => [p.name, p.skills.map((s) => s.name).sort()]));
    assert.deepEqual(groups, { "claude-code": ["alpha", "beta"], agents: ["beta"], tools: ["gamma"], "project-claude": ["delta"] });
    assert.deepEqual(catalog.skills.map((s) => s.name).sort(), ["alpha", "beta", "delta", "gamma"]);
    assert.ok(catalog.warnings.some((w) => w.includes('another skill named "alpha"')), "conflicting duplicate warned");
    assert.ok(locations.every((l) => l.dir.startsWith(home)), "only folders under the fake home");
    assert.equal(locations.find((l) => l.group === "tools")!.description, "Claude Code plugin tools@mkt (~/.claude/plugins/cache/mkt/tools/1.0.0)");
    assert.ok(!locations.some((l) => l.group === "other"), "project-scoped plugin for another directory is ignored");
    // The site is read on other machines: plugin descriptions carry no paths from this one.
    for (const p of catalog.plugins) assert.ok(!p.description!.includes(home) && !p.description!.includes("~/"), String(p.description));
    // Skill dirs are relative to "/", so the normal publish pipeline can copy them.
    assert.equal(catalog.skills.find((s) => s.name === "gamma")!.dir, path.relative("/", path.join(home, ".claude/plugins/cache/mkt/tools/1.0.0/skills/gamma")));
  });
  it("respects CLAUDE_CONFIG_DIR", async () => {
    const alt = path.join(home, "alt-claude");
    await skill(path.join(alt, "skills/epsilon"), "epsilon");
    const { catalog } = await discoverInstalled({ home, cwd: home, env: { CLAUDE_CONFIG_DIR: alt } });
    assert.deepEqual(catalog.plugins.find((p) => p.name === "claude-code")!.skills.map((s) => s.name), ["epsilon"]);
  });
});
