// The repository's own icon, used as the site's favicon.
//
// Build time only: the image is downloaded from the repository's own host (github.com or the GitLab server the
// repo lives on), saved into the site, and served from there, so visitors never contact the forge for it.
//   GitHub  has no per-repository icon, so this is the avatar of the owner (user or organisation).
//   GitLab  uses the project avatar, else the avatar of the group the project is in.
// Anonymous requests only (no tokens), so private repositories keep the generated icon. Any failure is reported
// and the build carries on with the default icon.
import { pngSize } from "./pwa.ts";
import type { RemoteInfo } from "./types.ts";

export interface RepoIcon {
  bytes: Uint8Array;
  ext: "png" | "jpg" | "gif" | "webp";
  mime: string;
  /** Only known for PNG. */
  width?: number;
  height?: number;
  /** The URL it came from (no credentials), for the build log. */
  from: string;
}

export type RepoIconResult = { icon: RepoIcon } | { skipped: string };

/** Largest image accepted: avatars are tens of KB, so anything bigger is not an icon. */
export const MAX_ICON_BYTES = 1024 * 1024;

/** Image format from the first bytes (never from the Content-Type, so an HTML error page can't pass as an icon). */
export function sniffImage(b: Uint8Array): Pick<RepoIcon, "ext" | "mime"> | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: "png", mime: "image/png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { ext: "gif", mime: "image/gif" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: "webp", mime: "image/webp" };
  return undefined;
}

type Fetch = typeof fetch;

export interface FetchIconOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

/** Anonymous GET with a timeout; HTTPS only (also after redirects). Returns why it failed instead of throwing. */
async function get(url: string, o: Required<FetchIconOptions>, accept: string): Promise<{ res: Response } | { error: string }> {
  try {
    const res = await o.fetch(url, { redirect: "follow", headers: { accept, "user-agent": "skills-pages" }, signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.url && !res.url.startsWith("https://")) return { error: `redirected away from HTTPS (${new URL(res.url).origin})` };
    return { res };
  } catch (err) {
    const e = err as Error;
    return { error: e.name === "TimeoutError" ? `no answer within ${o.timeoutMs / 1000}s` : (e.cause as Error | undefined)?.message ?? e.message };
  }
}

async function image(url: string, o: Required<FetchIconOptions>): Promise<RepoIconResult> {
  const r = await get(url, o, "image/*");
  if ("error" in r) return { skipped: `${url}: ${r.error}` };
  const { res } = r;
  if (!res.ok) return { skipped: `${url}: HTTP ${res.status}${res.status === 404 ? " (none set, or the project is private)" : ""}` };
  const length = Number(res.headers.get("content-length"));
  if (length > MAX_ICON_BYTES) return { skipped: `${url}: ${length} bytes is too big for an icon` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_ICON_BYTES) return { skipped: `${url}: ${bytes.length} bytes is too big for an icon` };
  const kind = sniffImage(bytes);
  if (!kind) return { skipped: `${url}: not a PNG, JPEG, GIF or WebP image` };
  return { icon: { bytes, ...kind, ...(kind.ext === "png" ? pngSize(bytes) : {}), from: url } };
}

/** Download the icon for a repository on github.com or a GitLab server. */
export async function fetchRepoIcon(remote: RemoteInfo, opts: FetchIconOptions = {}): Promise<RepoIconResult> {
  const o = { fetch: opts.fetch ?? fetch, timeoutMs: opts.timeoutMs ?? 10_000 };
  if (remote.host === "github.com") return image(`https://github.com/${encodeURIComponent(remote.owner)}.png?size=256`, o);
  if (!remote.isGitLab) return { skipped: `${remote.host} isn't github.com or a GitLab server, so there is no known place to get an icon` };

  const api = `https://${remote.host}/api/v4/projects/${encodeURIComponent(`${remote.owner}/${remote.repo}`)}`;
  const project = await image(`${api}/avatar`, o);
  if ("icon" in project) return project;
  // No project avatar: the group's (a user's own namespace has one too). The project record says where it is.
  const meta = await get(api, o, "application/json");
  if ("error" in meta) return { skipped: `${project.skipped}; ${api}: ${meta.error}` };
  if (!meta.res.ok) return { skipped: project.skipped };
  let avatar: unknown;
  try {
    avatar = ((await meta.res.json()) as { namespace?: { avatar_url?: unknown } }).namespace?.avatar_url;
  } catch {
    return { skipped: project.skipped };
  }
  if (typeof avatar !== "string" || !avatar) return { skipped: `${project.skipped}; the group has no avatar either` };
  // Same server only: GitLab falls back to Gravatar for users without an upload, and that would be a third-party request.
  let url: URL;
  try {
    url = new URL(avatar, `https://${remote.host}/`);
  } catch {
    return { skipped: project.skipped };
  }
  if (url.origin !== `https://${remote.host}`) return { skipped: `${project.skipped}; the group avatar is hosted on ${url.host}, not ${remote.host}` };
  return image(url.href, o);
}
