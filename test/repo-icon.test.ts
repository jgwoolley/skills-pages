import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchRepoIcon, MAX_ICON_BYTES, sniffImage } from "../src/repo-icon.ts";
import { parseRemote } from "../src/source.ts";

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

/** A fake network: url → response (or a thrown error). Records every URL asked for. */
function net(routes: Record<string, () => Response | Error>) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    asked.push(u);
    const r = routes[u]?.() ?? new Response("nope", { status: 404 });
    if (r instanceof Error) throw r;
    // Response.url is empty for constructed responses; mimic a real fetch.
    return Object.defineProperty(r, "url", { value: u });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const gh = parseRemote("git@github.com:acme/skills.git")!;
const gl = parseRemote("https://gitlab.example.com/team/sub/skills.git")!;
const api = "https://gitlab.example.com/api/v4/projects/team%2Fsub%2Fskills";

describe("repo icon", () => {
  it("recognises images by their bytes, not their headers", () => {
    assert.equal(sniffImage(png(1, 1))?.ext, "png");
    assert.equal(sniffImage(jpeg)?.ext, "jpg");
    assert.equal(sniffImage(new TextEncoder().encode("<!doctype html>")), undefined);
    assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))?.ext, "webp");
  });

  it("GitHub: the owner's avatar", async () => {
    const n = net({ "https://github.com/acme.png?size=256": () => new Response(png(256, 256)) });
    const r = await fetchRepoIcon(gh, { fetch: n.fetch });
    assert.ok("icon" in r);
    assert.deepEqual([r.icon.ext, r.icon.mime, r.icon.width, r.icon.height], ["png", "image/png", 256, 256]);
    assert.deepEqual(n.asked, ["https://github.com/acme.png?size=256"]);
  });

  it("GitLab: the project avatar, from the project's own server", async () => {
    const n = net({ [`${api}/avatar`]: () => new Response(jpeg) });
    const r = await fetchRepoIcon(gl, { fetch: n.fetch });
    assert.ok("icon" in r);
    assert.equal(r.icon.ext, "jpg");
    assert.equal(r.icon.width, undefined);
  });

  it("GitLab: falls back to the group avatar, but only from the same server", async () => {
    const group = (avatar: string) => net({ [api]: () => Response.json({ namespace: { avatar_url: avatar } }), "https://gitlab.example.com/uploads/g.png": () => new Response(png(64, 64)) });
    const ok = group("/uploads/g.png");
    assert.ok("icon" in (await fetchRepoIcon(gl, { fetch: ok.fetch })));
    const gravatar = group("https://secure.gravatar.com/avatar/abc");
    const r = await fetchRepoIcon(gl, { fetch: gravatar.fetch });
    assert.ok("skipped" in r);
    assert.match(r.skipped, /hosted on secure\.gravatar\.com/);
    assert.ok(!gravatar.asked.some((u) => u.includes("gravatar")), "never requests a third-party host");
  });

  it("says why it gave up", async () => {
    const reason = async (remote: typeof gh, routes: Parameters<typeof net>[0]) => {
      const r = await fetchRepoIcon(remote, { fetch: net(routes).fetch });
      assert.ok("skipped" in r);
      return r.skipped;
    };
    assert.match(await reason(gl, {}), /HTTP 404 \(none set, or the project is private\)/);
    assert.match(await reason(gh, { "https://github.com/acme.png?size=256": () => new Response("<html>") }), /not a PNG, JPEG, GIF or WebP/);
    assert.match(await reason(gh, { "https://github.com/acme.png?size=256": () => new Response(new Uint8Array(MAX_ICON_BYTES + 1)) }), /too big/);
    assert.match(await reason(gh, { "https://github.com/acme.png?size=256": () => new Error("getaddrinfo ENOTFOUND") }), /ENOTFOUND/);
    assert.match(await reason(parseRemote("git@git.example.com:team/skills.git")!, {}), /isn't github\.com or a GitLab server/);
  });
});
