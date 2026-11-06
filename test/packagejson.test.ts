import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discover } from "../src/discover.ts";
import { methods, type InstallData } from "../src/install.ts";
import { mergePackageJson, skillRoots, validNpmName } from "../src/packagejson.ts";
import { parseRemote } from "../src/source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = { dir: path.join(here, "fixtures", "example-catalog"), local: true, remote: parseRemote("git@github.com:acme/skills.git"), cleanup: async () => {} };

describe("package.json for pi / npm", () => {
  it("lists every folder that holds skills (pi.skills) and makes the repo a pi package", async () => {
    const cat = await discover(src);
    assert.deepEqual(skillRoots(cat), ["./plugins/data/skills", "./plugins/web/skills", "./skills"]);
    const pkg = mergePackageJson(undefined, cat, src, { name: "@acme/skills", public: false });
    assert.equal(pkg.name, "@acme/skills");
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.private, true, "private unless it'll be published");
    assert.deepEqual(pkg.keywords, ["pi-package", "agent-skills"]);
    assert.deepEqual(pkg.pi, { skills: ["./plugins/data/skills", "./plugins/web/skills", "./skills"] });
    assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/acme/skills.git" });
    assert.deepEqual(pkg.files, ["plugins/data/skills", "plugins/web/skills", "skills"]);
  });
  it("merges into an existing package.json without overwriting it", async () => {
    const cat = await discover(src);
    const existing = { name: "mine", version: "2.3.0", scripts: { test: "x" }, keywords: ["custom"], pi: { skills: ["./only-these"], extensions: ["./ext"] }, private: true };
    const pkg = mergePackageJson(existing, cat, src, { name: "@acme/skills", public: true });
    assert.equal(pkg.name, "mine");
    assert.equal(pkg.version, "2.3.0");
    assert.deepEqual(pkg.scripts, { test: "x" });
    assert.deepEqual(pkg.keywords, ["custom", "pi-package", "agent-skills"]);
    assert.deepEqual(pkg.pi, { skills: ["./only-these"], extensions: ["./ext"] }, "an existing pi.skills is kept");
    assert.equal("private" in pkg, false, "choosing to publish removes private");
  });
  it("validates npm names", () => {
    for (const n of ["nf3t-skills", "@nf3t/nf3t-skills", "a.b_c"]) assert.ok(validNpmName(n), n);
    for (const n of ["NF3T", "@nf3t/", "-x", "has space"]) assert.ok(!validNpmName(n), n);
  });
});

describe("pi from npm", () => {
  const base: InstallData = {
    name: "mkt", title: "Mkt", siteUrl: "https://acme.github.io/skills/", siteArchives: true,
    repo: { https: "https://github.com/acme/skills.git", ssh: "git@github.com:acme/skills.git", web: "https://github.com/acme/skills", blob: "https://github.com/acme/skills/blob/HEAD/" },
    git: { claude: false, omp: false, claudeSkills: [], ompSkills: [], claudeEntries: [], ompEntries: [] },
    json: { claudeSkills: [], ompSkills: [] }, piPackage: true, mixedLayout: false, plugins: [], skills: [],
  };
  const g = { protocol: "https", scope: "project" } as const;
  it("published: pi install npm:<name>", () => {
    const m = methods({ ...base, npm: { name: "@acme/skills", public: true } }, "pi", g).find((x) => x.id === "pi-npm")!;
    assert.equal(m.phases[0]!.steps[0]!.code, "pi install npm:@acme/skills -l");
    assert.equal(m.phases[0]!.steps[0]!.title, "Install the package into `.pi/npm/`");
  });
  it("private: listed with how to publish; absent without a package.json", () => {
    const m = methods({ ...base, npm: { name: "@acme/skills", public: false } }, "pi", g).find((x) => x.id === "pi-npm")!;
    assert.match(m.blocked!.reason, /marked `private`/);
    assert.match(m.blocked!.fix, /npm publish/);
    assert.equal(methods(base, "pi", g).find((x) => x.id === "pi-npm"), undefined);
  });
});
