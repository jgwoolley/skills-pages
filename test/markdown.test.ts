import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSkillMarkdown, stripFrontmatter } from "../src/markdown.ts";

const render = (md: string) => renderSkillMarkdown(md, { fileBase: "../../pdf/" });

describe("SKILL.md preview", () => {
  it("strips the frontmatter", () => {
    assert.equal(stripFrontmatter("---\nname: pdf\ndescription: x: y\n---\n\n# PDF\n"), "# PDF\n");
    assert.equal(stripFrontmatter("# No frontmatter\n"), "# No frontmatter\n");
    const html = render("---\nname: pdf\ndescription: Secret\n---\n# PDF tools\n");
    assert.doesNotMatch(html, /name: pdf|Secret|<hr/);
    assert.match(html, /<h1>PDF tools<\/h1>/);
  });
  it("formats Markdown", () => {
    const html = render("# T\n\n**bold** `code`\n\n- a\n- b\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<ul>\n<li>a<\/li>/);
    assert.match(html, /<pre><code class="language-py">print\(1\)/);
    assert.match(html, /<div class="table-scroll"><table>/);
  });
  it("never passes raw HTML or unsafe links through", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n');
    assert.doesNotMatch(html, /<script|<img src=x|href="javascript:/i);
    assert.match(html, /&lt;script&gt;/);
  });
  it("resolves relative links and images to the published skill files; links open in a new tab", () => {
    const html = render("[ref](reference.md) [s](./scripts/run.py) [ext](https://example.com) [top](#usage)\n\n![diagram](img/d.png)\n");
    assert.match(html, /<a href="\.\.\/\.\.\/pdf\/reference\.md" target="_blank" rel="noopener noreferrer">ref<\/a>/);
    assert.match(html, /href="\.\.\/\.\.\/pdf\/scripts\/run\.py"/);
    assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">ext<\/a>/);
    assert.match(html, /<a href="#usage">top<\/a>/);
    assert.match(html, /<img src="\.\.\/\.\.\/pdf\/img\/d\.png" alt="diagram" loading="lazy">/);
  });
  it("shows remote images as links (no third-party requests)", () => {
    const html = render("![logo](https://cdn.example.com/logo.png)\n");
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<a href="https:\/\/cdn\.example\.com\/logo\.png" target="_blank" rel="noopener noreferrer" class="remote-image">🖼 logo<\/a>/);
  });
});
