import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciInfo, resolveBaseUrl, resolveOut, resolveSourceArg } from "../src/defaults.ts";
import { parseRemote } from "../src/source.ts";

const gitlab = {
  GITLAB_CI: "true",
  CI_PROJECT_DIR: "/builds/team/skills",
  CI_PROJECT_URL: "https://gitlab.example.com/team/skills",
  CI_COMMIT_SHA: "a".repeat(40),
  CI_PAGES_URL: "https://team.pages.example.com/skills",
  CI_PROJECT_TITLE: "Team Skills",
};
const github = {
  GITHUB_ACTIONS: "true",
  GITHUB_WORKSPACE: "/home/runner/work/skills/skills",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "Acme/skills",
  GITHUB_SHA: "b".repeat(40),
};

describe("CI detection", () => {
  it("reads GitLab predefined variables", () => {
    assert.deepEqual(ciInfo(gitlab), {
      provider: "gitlab",
      workspace: "/builds/team/skills",
      repoUrl: "https://gitlab.example.com/team/skills",
      sha: "a".repeat(40),
      pagesUrl: "https://team.pages.example.com/skills/",
      pagesFrom: "CI_PAGES_URL",
      title: "Team Skills",
    });
  });
  it("reads the GitLab project description", () => {
    assert.equal(ciInfo({ ...gitlab, CI_PROJECT_DESCRIPTION: " Our skills " })!.description, "Our skills");
    assert.equal(ciInfo(gitlab)!.description, undefined);
    assert.equal(ciInfo(github)!.description, undefined);
  });
  it("derives the github.com Pages URL from GITHUB_REPOSITORY", () => {
    const ci = ciInfo(github)!;
    assert.equal(ci.repoUrl, "https://github.com/Acme/skills");
    assert.equal(ci.pagesUrl, "https://acme.github.io/skills/");
  });
  it("does not guess Pages URLs on GitHub Enterprise Server", () => {
    assert.equal(ciInfo({ ...github, GITHUB_SERVER_URL: "https://ghe.corp.example" })!.pagesUrl, undefined);
  });
  it("is undefined outside CI", () => assert.equal(ciInfo({}), undefined));
});

describe("resolution order", () => {
  const remote = parseRemote("git@github.com:other/repo.git");
  it("base-url: flag > env > CI (for the CI checkout) > origin", () => {
    const ci = ciInfo(gitlab);
    const dir = gitlab.CI_PROJECT_DIR;
    assert.deepEqual(resolveBaseUrl("https://x.test/a", { SKILLS_PAGES_BASE_URL: "https://env.test" }, ci, remote, dir), { value: "https://x.test/a/", from: "--base-url" });
    assert.deepEqual(resolveBaseUrl(undefined, { SKILLS_PAGES_BASE_URL: "https://env.test" }, ci, remote, dir), { value: "https://env.test/", from: "SKILLS_PAGES_BASE_URL" });
    assert.deepEqual(resolveBaseUrl(undefined, {}, ci, remote, dir), { value: "https://team.pages.example.com/skills/", from: "CI_PAGES_URL" });
    // A different directory than the CI checkout: CI variables don't describe it.
    assert.deepEqual(resolveBaseUrl(undefined, {}, ci, remote, "/tmp/other"), { value: "https://other.github.io/repo/", from: "git origin" });
    assert.equal(resolveBaseUrl(undefined, {}, undefined, undefined, "/tmp/other"), undefined);
  });
  it("source: argument > env > CI workspace", () => {
    assert.deepEqual(resolveSourceArg("./x", { SKILLS_PAGES_SOURCE: "./y" }, ciInfo(github)), { value: "./x", from: "argument" });
    assert.deepEqual(resolveSourceArg(undefined, { SKILLS_PAGES_SOURCE: "./y" }, ciInfo(github)), { value: "./y", from: "SKILLS_PAGES_SOURCE" });
    assert.deepEqual(resolveSourceArg(undefined, {}, ciInfo(github)), { value: github.GITHUB_WORKSPACE, from: "GITHUB_WORKSPACE" });
    assert.equal(resolveSourceArg(undefined, {}, undefined), undefined);
  });
  it("out defaults to public (GitLab Pages' required dir)", () => {
    assert.deepEqual(resolveOut(undefined, {}), { value: "public", from: "default" });
    assert.deepEqual(resolveOut(undefined, { SKILLS_PAGES_OUT: "site" }), { value: "site", from: "SKILLS_PAGES_OUT" });
  });
});
