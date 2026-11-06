import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { adoptLegacyEnv, ensureIgnored, loadDotEnv, saveDotEnv, truthy } from "../src/envfile.ts";

describe(".env answers", () => {
  it("merges answers into .env, keeps other lines, and git-ignores it once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "envfile-"));
    try {
      await writeFile(path.join(dir, ".env"), "# mine\nOTHER=1\nSKILLS_PAGES_NAME=old\n");
      await writeFile(path.join(dir, ".gitignore"), "node_modules/");
      const r = await saveDotEnv(dir, { SKILLS_PAGES_NAME: "new", SKILLS_PAGES_TITLE: "My skills", SKILLS_PAGES_BASE_URL: "" });
      assert.equal(r.ignoredNow, true);
      assert.equal(await readFile(path.join(dir, ".env"), "utf8"), '# mine\nOTHER=1\nSKILLS_PAGES_NAME=new\nSKILLS_PAGES_TITLE="My skills"\nSKILLS_PAGES_BASE_URL=\n');
      assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules/\n.env\n");
      assert.equal(await ensureIgnored(dir, ".env"), false, "not added twice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("loads .env without overriding real environment variables", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "envfile-"));
    const keys = ["SC_TEST_A", "SC_TEST_B"];
    try {
      await writeFile(path.join(dir, ".env"), 'SC_TEST_A="from file"\nSC_TEST_B=file\n');
      process.env.SC_TEST_B = "real";
      const loaded = loadDotEnv(dir);
      assert.equal(process.env.SC_TEST_A, "from file");
      assert.equal(process.env.SC_TEST_B, "real");
      assert.deepEqual([...loaded], ["SC_TEST_A"]);
    } finally {
      for (const k of keys) delete process.env[k];
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps the old SKILLS_CATALOG_* names working, and replaces them when saving", async () => {
    const env: NodeJS.ProcessEnv = { SKILLS_CATALOG_NAME: "old", SKILLS_CATALOG_OUT: "site", SKILLS_PAGES_OUT: "new-site" };
    assert.deepEqual(adoptLegacyEnv(env), ["SKILLS_CATALOG_NAME"]);
    assert.equal(env.SKILLS_PAGES_NAME, "old");
    assert.equal(env.SKILLS_PAGES_OUT, "new-site", "the new name wins");
    const dir = await mkdtemp(path.join(tmpdir(), "envfile-"));
    try {
      await writeFile(path.join(dir, ".env"), "SKILLS_CATALOG_NAME=old\nSKILLS_CATALOG_TITLE=Keep\n");
      await saveDotEnv(dir, { SKILLS_PAGES_NAME: "new" });
      assert.equal(await readFile(path.join(dir, ".env"), "utf8"), "SKILLS_CATALOG_TITLE=Keep\nSKILLS_PAGES_NAME=new\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reads yes/no values", () => {
    assert.deepEqual(["1", "true", "YES", "0", "no", "", "maybe", undefined].map(truthy), [true, true, true, false, false, false, undefined, undefined]);
  });
});
