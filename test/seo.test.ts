import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InstallData } from "../src/install.ts";
import { ico, manifest, pngSize, serviceWorker, shortName } from "../src/pwa.ts";
import { absUrl, clip, headTags, pagePath, robotsTxt, sitemapXml } from "../src/seo.ts";

const data = (over: Partial<InstallData> = {}) =>
  ({ siteUrl: "https://acme.github.io/skills/", skills: [{ name: "alpha", description: "A", tags: ["git"], url: "https://github.com/acme/skills/tree/main/skills/alpha" }], ...over }) as unknown as InstallData;
const image = { path: "assets/icons/og.png", width: 1200, height: 630, alt: "card" };

describe("seo", () => {
  it("builds canonical page URLs below the site path", () => {
    assert.equal(pagePath({ kind: "catalog", root: "" }), "");
    assert.equal(pagePath({ kind: "skill", skill: "alpha", root: "../../" }), "skill/alpha/");
    assert.equal(pagePath({ kind: "docs", root: "../../" }), "docs/skills-pages/");
    assert.equal(absUrl("https://acme.github.io/skills/", "plugins/"), "https://acme.github.io/skills/plugins/");
    assert.equal(absUrl(undefined, "plugins/"), "plugins/");
  });

  it("clips long descriptions on a word boundary", () => {
    assert.equal(clip("short"), "short");
    const c = clip("word ".repeat(100), 50);
    assert.ok(c.length <= 50 && c.endsWith("…"), c);
  });

  it("writes Open Graph, Twitter, icons, manifest and JSON-LD", () => {
    const head = headTags({ title: "alpha · Skills", description: "Does alpha things", siteTitle: "Skills", page: { kind: "skill", skill: "alpha", root: "../../" }, data: data(), indexable: true, image });
    assert.match(head, /<link rel="canonical" href="https:\/\/acme\.github\.io\/skills\/skill\/alpha\/">/);
    assert.match(head, /<meta property="og:image" content="https:\/\/acme\.github\.io\/skills\/assets\/icons\/og\.png">/);
    assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(head, /<link rel="manifest" href="\.\.\/\.\.\/manifest\.webmanifest">/);
    assert.match(head, /<link rel="icon" href="\.\.\/\.\.\/assets\/icons\/icon\.svg"/);
    assert.match(head, /content="index, follow/);
    const ld = JSON.parse(head.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    assert.equal(ld["@graph"][0]["@type"], "SoftwareSourceCode");
    assert.equal(ld["@graph"][0].keywords, "git");
    assert.equal(ld["@graph"][1]["@type"], "BreadcrumbList");
  });

  it("keeps previews and tool pages out of search results", () => {
    const head = (kind: "catalog" | "tester", indexable: boolean) => headTags({ title: "t", description: "d", siteTitle: "S", page: { kind, root: "" }, data: data(), indexable, image });
    assert.match(head("catalog", false), /noindex/);
    assert.match(head("tester", true), /noindex/);
    assert.match(robotsTxt("http://localhost:4173/", false), /Disallow: \//);
    assert.match(robotsTxt("https://acme.github.io/skills/", true), /Sitemap: https:\/\/acme\.github\.io\/skills\/sitemap\.xml/);
    assert.match(sitemapXml("https://acme.github.io/skills/", ["", "skill/alpha/"], "2026-11-06T10:00:00Z"), /<loc>https:\/\/acme\.github\.io\/skills\/skill\/alpha\/<\/loc><lastmod>2026-11-06<\/lastmod>/);
  });

  it("--no-index and --no-follow reach the robots meta and robots.txt", () => {
    const head = (indexable: boolean, follow?: boolean) => headTags({ title: "t", description: "d", siteTitle: "S", page: { kind: "catalog", root: "" }, data: data(), indexable, follow, image });
    assert.match(head(true), /content="index, follow, max-image-preview:large"/);
    assert.match(head(true, false), /content="index, nofollow, max-image-preview:large"/);
    assert.match(head(false, false), /content="noindex, nofollow"/);
    assert.match(head(false), /content="noindex, follow"/);
    assert.match(robotsTxt("https://acme.github.io/skills/", false, "Built with --no-index"), /^# Built with --no-index: .*\nUser-agent: \*\nDisallow: \/\n$/);
  });

  it("uses the repository icon for the favicon links when there is one", () => {
    const icon = { path: "assets/icons/repo.png", mime: "image/png", width: 256, height: 256 };
    const head = headTags({ title: "t", description: "d", siteTitle: "S", page: { kind: "skill", skill: "alpha", root: "../../" }, data: data({ icon }), indexable: true, image });
    assert.match(head, /<link rel="icon" href="\.\.\/\.\.\/assets\/icons\/repo\.png" type="image\/png" sizes="256x256">/);
    assert.match(head, /<link rel="apple-touch-icon" href="\.\.\/\.\.\/assets\/icons\/repo\.png">/);
    assert.doesNotMatch(head, /icon\.svg/);
  });

  it("escapes JSON-LD so it can't close its script tag", () => {
    const head = headTags({ title: "t", description: "</script><b>", siteTitle: "S", page: { kind: "catalog", root: "" }, data: data(), indexable: true, image });
    assert.equal(head.match(/<\/script>/g)!.length, 1);
  });
});

describe("pwa", () => {
  it("writes a manifest with relative start URL and maskable icon", () => {
    const m = JSON.parse(manifest({ title: "nf3t-skills", description: "d" }));
    assert.equal(m.start_url, "./");
    assert.equal(m.display, "standalone");
    assert.ok(m.icons.some((i: { purpose: string }) => i.purpose === "maskable"));
    assert.equal(shortName("A very long catalog title"), "Skills");
    assert.equal(shortName("Acme agent skills"), "Acme");
  });

  it("lists the repository icon in the manifest only when it is a PNG with a size", () => {
    const icons = (icon?: { path: string; mime: string; width?: number; height?: number }) => JSON.parse(manifest({ title: "t", description: "d", icon })).icons as { src: string; sizes: string }[];
    assert.deepEqual(icons({ path: "assets/icons/repo.png", mime: "image/png", width: 460, height: 460 })[0], { src: "assets/icons/repo.png", sizes: "460x460", type: "image/png", purpose: "any" });
    assert.equal(icons({ path: "assets/icons/repo.jpg", mime: "image/jpeg" }).length, icons().length);
  });

  it("service worker scopes its caches to the site and skips archives", () => {
    const sw = serviceWorker("abc-1", ["./", "assets/app.js"]);
    assert.match(sw, /const PREFIX = "skills-pages:" \+ SCOPE/);
    assert.match(sw, /\.well-known\//);
    assert.match(sw, /\\\.zip\$/);
    assert.match(sw, /"abc-1"/);
  });

  it("wraps a PNG in favicon.ico", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 32);
    new DataView(png.buffer).setUint32(20, 32);
    assert.deepEqual(pngSize(png), { width: 32, height: 32 });
    const out = ico(png);
    assert.deepEqual([...out.slice(0, 8)], [0, 0, 1, 0, 1, 0, 32, 32]);
    assert.equal(new DataView(out.buffer).getUint32(18, true), 22);
    assert.throws(() => ico(new Uint8Array(10)));
  });
});
