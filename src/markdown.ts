// Build-time Markdown rendering for the SKILL.md preview on skill pages.
// Skills come from repositories you may not control, so raw HTML is never passed through (it's escaped),
// unsafe link schemes are dropped by markdown-it, and remote images (which the CSP would block anyway) become links.
import MarkdownIt from "markdown-it";

/** SKILL.md without its leading `--- … ---` frontmatter block. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").replace(/^\s*\n/, "");
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

export interface RenderOptions {
  /** Prefix for relative links/images, i.e. where the skill's files are published relative to the page (e.g. "../../pdf/"). */
  fileBase: string;
}

export function renderSkillMarkdown(markdown: string, opts: RenderOptions): string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const resolve = (href: string) => (isExternal(href) || href.startsWith("#") || href.startsWith("/") ? href : `${opts.fileBase}${href.replace(/^\.\//, "")}`);

  // Links: resolve relative paths to the published skill files; open in a new tab like every other link on the site.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]!;
    const href = String(t.attrGet("href") ?? "");
    t.attrSet("href", resolve(href));
    if (!href.startsWith("#")) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
    }
    return self.renderToken(tokens, idx, options);
  };

  // Images: relative ones load from the published files; remote ones are shown as a link instead (no third-party requests).
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx]!;
    const src = String(t.attrGet("src") ?? "");
    const text = self.renderInlineAsText(t.children ?? [], options, env);
    const alt = text || src;
    if (isExternal(src)) {
      const safe = /^https?:/i.test(src) ? md.utils.escapeHtml(src) : "#";
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="remote-image">🖼 ${md.utils.escapeHtml(alt)}</a>`;
    }
    t.attrSet("src", resolve(src));
    t.attrSet("alt", text); // markdown-it's default image rule fills this in; we replaced that rule
    t.attrSet("loading", "lazy");
    return self.renderToken(tokens, idx, options);
  };

  // Wide tables scroll instead of breaking the layout.
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";

  return md.render(stripFrontmatter(markdown));
}

/** GitHub-style heading slug ("Preferences: global defaults (XDG)" → "preferences-global-defaults-xdg"). */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
}

/**
 * A documentation page (e.g. skills-pages' install guide): same safety rules as the SKILL.md preview, plus heading
 * anchors so sections can be linked. Relative links to other docs aren't resolvable on the site, so they become text.
 */
export function renderDoc(markdown: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const seen = new Map<string, number>();
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const id = slug(tokens[idx + 1]?.content ?? "");
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    tokens[idx]!.attrSet("id", n ? `${id}-${n}` : id);
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]!;
    const href = String(t.attrGet("href") ?? "");
    if (!href.startsWith("#")) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md.render(markdown);
}
