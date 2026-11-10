// Search and social metadata for every page: canonical URL, robots, Open Graph, Twitter cards, icons, the web app
// manifest link and JSON-LD structured data. Plus robots.txt and sitemap.xml. Everything is static and same-site;
// JSON-LD is a data block (never executed), so the strict CSP still holds.
import type { InstallData } from "./install.ts";
import type { PageInfo } from "./publish.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page's path below the site root ("" for the home page). */
export function pagePath(p: PageInfo): string {
  switch (p.kind) {
    case "catalog":
      return "";
    case "skill":
      return `skill/${encodeURIComponent(p.skill ?? "")}/`;
    case "plugin":
      return `plugins/${encodeURIComponent(p.plugin ?? "")}/`;
    case "plugins":
      return "plugins/";
    case "build":
      return "build/";
    case "tester":
      return "tester/";
    case "docs":
      return "docs/skills-pages/";
  }
}

/** Absolute URL on the site; just the path when the site URL is missing or invalid. */
export function absUrl(siteUrl: string | undefined, rel: string): string {
  try {
    return new URL(rel, siteUrl).href;
  } catch {
    return rel || "./";
  }
}

/** Shorten to `max` characters on a word boundary, for meta descriptions (search engines show ~160). */
export function clip(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[\s,.;:]+$/, "")}…`;
}

export interface SocialImage {
  /** Path below the site root. */
  path: string;
  width: number;
  height: number;
  alt: string;
}

export interface HeadOptions {
  title: string;
  description: string;
  siteTitle: string;
  page: PageInfo;
  data: InstallData;
  /** False for previews (loopback or unknown site URL) or `--no-index`: every page gets noindex. */
  indexable: boolean;
  /** False for `--no-follow`: every page asks crawlers not to follow its links. */
  follow?: boolean;
  image: SocialImage;
  /** When the content last changed (the catalog's commit date), if known. */
  modified?: string;
}

/** Pages that are tools rather than content: kept out of search results (but their links are still followed). */
const UTILITY: PageInfo["kind"][] = ["build", "tester"];

export function headTags(o: HeadOptions): string {
  const r = o.page.root;
  const site = o.data.siteUrl;
  const url = absUrl(site, pagePath(o.page));
  const desc = clip(o.description);
  const img = absUrl(site, o.image.path);
  const noindex = !o.indexable || UTILITY.includes(o.page.kind);
  const ld = JSON.stringify(jsonLd(o, url, desc)).replace(/</g, "\\u003c");
  return [
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="robots" content="${[noindex ? "noindex" : "index", o.follow === false ? "nofollow" : "follow", ...(noindex ? [] : ["max-image-preview:large"])].join(", ")}">`,
    `<meta name="generator" content="skills-pages">`,
    // Open Graph (Facebook, LinkedIn, Slack, Discord, Mastodon, …)
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(o.siteTitle)}">`,
    `<meta property="og:title" content="${esc(o.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="${o.image.width}">`,
    `<meta property="og:image:height" content="${o.image.height}">`,
    `<meta property="og:image:alt" content="${esc(o.image.alt)}">`,
    // Twitter / X
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(o.title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(img)}">`,
    `<meta name="twitter:image:alt" content="${esc(o.image.alt)}">`,
    // Icons, installable app
    ...iconLinks(r, o.data.icon),
    `<link rel="manifest" href="${r}manifest.webmanifest">`,
    `<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="#151821" media="(prefers-color-scheme: dark)">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="application-name" content="${esc(o.siteTitle)}">`,
    `<meta name="apple-mobile-web-app-title" content="${esc(o.siteTitle)}">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<script type="application/ld+json">${ld}</script>`,
  ].join("\n");
}

/**
 * Favicon links. The repository's own icon (see repo-icon.ts) replaces the generated one, including the
 * apple-touch-icon (browsers accept any raster format for both).
 */
export function iconLinks(root: string, icon: InstallData["icon"]): string[] {
  if (!icon) {
    return [
      `<link rel="icon" href="${root}assets/icons/icon.svg" type="image/svg+xml">`,
      `<link rel="icon" href="${root}assets/icons/icon-32.png" type="image/png" sizes="32x32">`,
      `<link rel="apple-touch-icon" href="${root}assets/icons/apple-touch-icon.png">`,
    ];
  }
  return [
    `<link rel="icon" href="${esc(root + icon.path)}" type="${esc(icon.mime)}"${icon.width ? ` sizes="${icon.width}x${icon.height}"` : ""}>`,
    `<link rel="apple-touch-icon" href="${esc(root + icon.path)}">`,
  ];
}

/** schema.org structured data: the site, the skill list, each skill as source code, breadcrumbs. */
export function jsonLd(o: HeadOptions, url: string, desc: string): object {
  const site = o.data.siteUrl;
  const website = { "@type": "WebSite", "@id": `${site}#website`, name: o.siteTitle, url: site, inLanguage: "en" };
  const crumbs = (items: [string, string][]) => ({
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, rel], i) => ({ "@type": "ListItem", position: i + 1, name, item: absUrl(site, rel) })),
  });
  const graph: object[] = [];
  switch (o.page.kind) {
    case "catalog":
      graph.push(
        { ...website, description: desc, ...(o.data.repo?.web ? { sameAs: [o.data.repo.web] } : {}) },
        {
          "@type": "ItemList",
          name: `Skills in ${o.siteTitle}`,
          numberOfItems: o.data.skills?.length ?? 0,
          itemListElement: (o.data.skills ?? []).map((s, i) => ({ "@type": "ListItem", position: i + 1, name: s.name, url: absUrl(site, `skill/${encodeURIComponent(s.name)}/`) })),
        },
      );
      break;
    case "skill": {
      const s = o.data.skills?.find((x) => x.name === o.page.skill);
      graph.push(
        {
          "@type": "SoftwareSourceCode",
          name: o.page.skill,
          description: desc,
          url,
          isPartOf: { "@id": `${site}#website` },
          ...(s?.tags?.length ? { keywords: s.tags.join(", ") } : {}),
          ...(s?.url ? { codeRepository: s.url } : o.data.repo?.web ? { codeRepository: o.data.repo.web } : {}),
          ...(o.modified ? { dateModified: o.modified } : {}),
        },
        crumbs([
          ["Skills", ""],
          [o.page.skill ?? "", pagePath(o.page)],
        ]),
      );
      break;
    }
    case "plugin":
      graph.push(
        { "@type": "CollectionPage", name: o.title, description: desc, url, isPartOf: { "@id": `${site}#website` } },
        crumbs([
          ["Plugins", "plugins/"],
          [o.page.plugin ?? "", pagePath(o.page)],
        ]),
      );
      break;
    case "docs":
      graph.push(
        { "@type": "TechArticle", headline: o.title, description: desc, url, isPartOf: { "@id": `${site}#website` } },
        crumbs([
          ["Skills", ""],
          ["skills-pages", pagePath(o.page)],
        ]),
      );
      break;
    default:
      graph.push({ "@type": "WebPage", name: o.title, description: desc, url, isPartOf: { "@id": `${site}#website` } });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * robots.txt. Crawlers only read it at the origin root, so it takes effect on a custom domain or a user/org Pages
 * site, not under a project path; the per-page robots meta covers that case.
 */
export function robotsTxt(siteUrl: string, indexable: boolean, why = "Preview build (no public site URL)"): string {
  if (!indexable) return `# ${why}: keep it out of search engines.\nUser-agent: *\nDisallow: /\n`;
  return `User-agent: *\nAllow: /\n\nSitemap: ${absUrl(siteUrl, "sitemap.xml")}\n`;
}

/** sitemap.xml for the content pages (paths below the site root). */
export function sitemapXml(siteUrl: string, paths: string[], lastmod?: string): string {
  const mod = lastmod ? `<lastmod>${esc(lastmod.slice(0, 10))}</lastmod>` : "";
  const urls = paths.map((p) => `  <url><loc>${esc(absUrl(siteUrl, p))}</loc>${mod}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
