# skills-pages

A CLI (`@nf3t/skills-pages`, command `skills-pages`) that turns an agent skills repository into a static site. The site
has install guides and ready-made marketplaces for **Claude Code**, **oh-my-pi**, **OpenCode**, **pi** and every agent
the Vercel skills CLI supports.

```console
npx @nf3t/skills-pages                       # interactive: asks for what it needs, saves answers to .env
npx @nf3t/skills-pages serve ~/skills       # build and preview
```

**Installing:** see [docs/install.md](docs/install.md). It covers npm/pnpm/bun, internal registries, global preferences,
and an RPM example for corporate networks.

## Use it from an agent (this repo's own marketplace)

This repo publishes itself with its own CLI at <https://jgwoolley.github.io/skills-pages/> (`.github/workflows/pages.yml`).
It ships two skills that teach an agent to use the CLI and wire it into CI/CD:

- `skills-pages-cli`: build, serve, check and write marketplaces.
- `skills-pages-ci`: GitHub Pages / GitLab Pages pipelines with a `check --strict` gate.

```console
claude plugin marketplace add jgwoolley/skills-pages
claude plugin install skills-pages@skills-pages
```

Other agents: `npx skills add jgwoolley/skills-pages`. After changing a skill, refresh the committed marketplaces with
`node dist/src/cli.js repo-files . --yes`. Enable Pages once under Settings > Pages > Source: **GitHub Actions**.

## Commands

| Command | What it does |
| --- | --- |
| `build [source]` | Build the site into `./public`. This is what CI runs; it never serves. It's the default command, so `skills-pages ./repo` works too |
| `serve [source]` | Build, then serve on `http://localhost:<port>/` (same options and prompts as `build`; the site URL is the local server, so its commands work). `serve --no-build [dir]` serves an existing build, and warns if it was built for another URL |
| `check <url\|path…>` | The tester's checks in the terminal, for a SKILL.md, zip, index, marketplace, skill folder, built site (read offline) or whole skills repo. Exits 1 on problems (`--strict`: also on warnings), so it can gate a deploy |
| `init` | Ask every question, save the answers to `.env`, and optionally add a CI workflow that deploys to GitHub Pages (`.github/workflows/skills-pages.yml`) or GitLab Pages (`.gitlab-ci.yml`). It never overwrites an existing file. Without a terminal: `init --ci github\|gitlab` |
| `repo-files [source]` | Only write `.claude-plugin/` and `.omp-plugin/marketplace.json` into the repo |
| `config` | Show the global preferences in effect (CI defaults, variable defaults) and the XDG files they come from |

An unknown first word is an error, not a path: use `./serve` to build from a folder named `serve`.

Renamed from `skills-catalog`: the old `SKILLS_CATALOG_*` variables still work, and are replaced in `.env` the next
time answers are saved.

## What it reads

A local path or a git URL (https or ssh; it is cloned shallowly into a temp dir, and nothing from it is executed) containing:

- `skills/<name>/SKILL.md`: root skills, published as one plugin, **and/or**
- `plugins/<plugin>/skills/<name>/SKILL.md`: one plugin per directory (its `.claude-plugin/plugin.json` is used if present).

**Reserved names.** If the marketplace name is one Claude Code reserves (e.g. `anthropic-agent-skills`, `claude-plugins-…`,
`…official…`, `claudeai-…`), the build fails: Claude Code would refuse to add any generated marketplace. Pass `--name`.
Plugin names such as `claude-api` are kept. Claude Code installs and loads them; only `claude plugin validate` flags them.

**Plugins are preserved.** If the repo already has a `.claude-plugin/marketplace.json` (or `.omp-plugin/marketplace.json`),
its entries are the plugins: names, descriptions, skill membership (the entry's `skills`, else `plugin.json` `skills`, else
`<dir>/skills/`) and every other field are kept. Entries pointing at other repos, or without skills, are passed through.
Skills the marketplace doesn't mention are grouped by convention (`plugins/<plugin>/`, then root `skills/` as one plugin).
A skill can belong to several plugins.

The generated marketplaces point at the skill copies in `./public`, so each plugin installs exactly its skills. Incoming
entries keep their other fields; entries from other repos pass through unchanged. Plugins without skills (commands or hooks
only) can't be built from the copies and are skipped with a warning.

Frontmatter `name` / `description` come from each `SKILL.md`. Tags come from frontmatter `tags`, `keywords`, `metadata.tags`
or `metadata.keywords` (list or comma-separated), plus the plugin's `plugin.json` `keywords`. An existing `.claude-plugin/marketplace.json` supplies the
marketplace name, the owner and plugin descriptions.

**Folders that aren't read** are reported, not skipped silently: each one gets a warning (build output, and `check`) with the
cause and the fix. For example a `skill.md` that must be `SKILL.md`, a skill nested one level too deep, a folder with no
`SKILL.md`, a hidden (`.`-prefixed) folder, a symlink, a `plugins/<plugin>/` without a `skills/` folder, a `SKILL.md` at the
repo root, or a marketplace entry whose `skills` path doesn't exist. If nothing is found at all, the error lists them.

## What it writes (`./public`, or `--out`)

| Path | For |
| --- | --- |
| `index.html`, `assets/` | Catalog page: install guides for the whole catalog per harness, HTTPS/SSH and global/project toggles, and a searchable, paginated skills table with clickable tag and plugin filters. The view lives in the URL: `?q=…&tag=a&tag=b&plugin=…&page=…&size=…` (tags are AND-ed; Back undoes filter clicks) |
| `plugins/index.html` | Plugins table: kind (repo marketplace / folder / root `skills/` / other repo), description, skill count with a link to the filtered skills table, and context size |
| `plugins/<name>/index.html` | One page per plugin: details, install guides for just that plugin (marketplace `<plugin>@<marketplace>`, OpenCode with its skills' indexes, skills CLI with `--skill a b c`), context estimate and its skills |
| `build/index.html` | **Source** (in the navbar's ☰ menu, and the footer's "Built … ago"): build date, the commit linked on GitHub/GitLab with its date and branch, a ⚠ flag when the working tree had uncommitted changes, and the CI/CD run (GitHub Actions run / GitLab job and pipeline, from their environment variables) |
| `tester/index.html` | **Tester**: paste the URL of a SKILL.md, skill zip, skills index, Claude Code / oh-my-pi marketplace or catalog site, or pick a file. The browser reads it like an agent would and reports problems: spec rules, invalid YAML, descriptions over 1024 characters, reserved names, archive URLs, sha256 digests and zip contents. Git repositories can't be read from a browser. This is the only page allowed to fetch other hosts, only when you press Validate, and the host must allow CORS |
| `docs/skills-pages/index.html` | **Docs**: skills-pages' install guide (`docs/install.md`, shipped with the CLI), with section anchors and a table of contents. Linked from the navbar and the Source page |
| `skill/<name>/index.html` | One page per skill: description, install guides for just that skill, a formatted `SKILL.md` preview, then its files (a paginated table with size and ≈ tokens per file; `?page=&size=` in the URL). The preview is rendered at build time without the frontmatter; raw HTML in the file is escaped, relative links point to the published files, and remote images become links |
| `.claude-plugin/marketplace.json`, `.omp-plugin/marketplace.json` | The published folder as a marketplace, with relative sources to the skill copies. Useful when the site is deployed from a git branch or cloned. The guides never offer a path on the build machine |
| `.well-known/agent-skills/index.json` + `*.zip` | Agent-skills discovery index (v0.2.0) for the skills CLI: `npx skills add <site>` finds it. One zip per skill with `SKILL.md` at its root, plus a sha256 digest |
| `claude/marketplace.json`, `claude/archives/*.zip` | **Claude Code site marketplace**: each plugin and skill as a zip of exactly its skills (`archive` source, with sha256), served from the site. Archive sources must be HTTPS and not loopback, so this is offered on hosted (HTTPS) sites only |
| `omp/marketplace.json` (`.ssh.json`) | oh-my-pi site marketplace. oh-my-pi has no archive source, so this uses git sources and is only generated when there's a repo |
| `index.json`, `<skill>/…` | OpenCode remote skills index (`skills.urls`) |
| `opencode/<skill>/index.json` | One-skill OpenCode index, for installing a single skill |
| `manifest.webmanifest`, `sw.js`, `favicon.ico`, `assets/icons/` | **Installable app (PWA)**: name, icons (incl. maskable) and shortcuts; a service worker for offline browsing. It only handles this site's own path, so sibling Pages sites on one origin keep separate caches. Pages and JSON are network-first, assets cache-first, and zips and `.well-known/` always come from the network. It registers on HTTPS and localhost only |
| `robots.txt`, `sitemap.xml` | **Search**: the sitemap lists the catalog, plugin, skill and docs pages, with the commit date as `lastmod`. Preview builds (loopback or unknown site URL) get `Disallow: /`, no sitemap, and `noindex` on every page |

Every page has a canonical URL, a meta description (clipped to 200 characters), Open Graph and Twitter `summary_large_image` cards, light/dark `theme-color`, and schema.org JSON-LD:
- the home page: `WebSite` plus an `ItemList` of skills;
- skill pages: `SoftwareSourceCode` with keywords and repo;
- plugin and docs pages: a page entry with breadcrumbs;
- the Source and Tester pages are `noindex`.

The social card is `assets/icons/og.png`. Put a 1200×630 `og-image.png` (or `.github/og-image.png`) in the catalog repo to use your own. The SVG sources for the icons and card live in `assets/icons/`; re-render the PNGs with `node scripts/render-brand.cjs` (dev only; needs Playwright).

The site URL defaults to the GitHub/GitLab Pages URL of the repo's `origin` (`https://owner.github.io/repo/`); override it with `--base-url`.

### `--installed`: your installed skills, whatever the agent

`skills-pages serve --installed` builds the site from the skills installed on this machine instead of a repo:
- **Global locations:**
  - Claude Code: `~/.claude/skills`, plus plugins read from `installed_plugins.json`; respects `CLAUDE_CONFIG_DIR`.
  - `~/.agents/skills`.
  - OpenCode: `~/.config/opencode/skills` and its remote-index cache.
  - pi and oh-my-pi: their skill folders, plugin caches and git packages.
  - Cursor, GitHub Copilot, Gemini CLI, Roo Code, Goose and Amp.
- **Project locations:** the same folders inside the current directory (`.claude/skills`, `.agents/skills`, …).

Each location becomes a plugin. The same skill reached twice (e.g. the skills CLI's symlinks) is listed once, under both
locations. A different skill with an already-used name is skipped with a warning.

The site's repository is the git repo you build in. Its origin gives the Pages URL, and its commit shows on the
Source page. It's labelled as the site's repository, not where the skills come from.

Everything installs from the published site, never from paths on the machine that built it:
- Claude Code uses the site marketplace (zip archives, once the site is on HTTPS).
- The skills CLI uses the site's well-known index.
- OpenCode uses the site's index.

The site doesn't show where the skills live on this machine; the CLI's terminal output does. `serve` binds to 127.0.0.1 only. The output contains copies of your
installed skills, and `public/` is git-ignored.

### `--package-json` (or `SKILLS_PAGES_PACKAGE_JSON=1`, or answer yes when asked)

Writes or merges a `package.json` that makes the skills repo a **pi package**. It fills in, among other fields:
- `pi.skills`: every folder that holds skills;
- the `pi-package` keyword;
- `files`, `repository`, `name` and `version`.

Existing fields are kept, and changes to an existing file are shown and confirmed. `pi install git:<repo>` then works for
any layout. Choose to publish (`--npm-public`) and the site also offers `pi install npm:<name>`. Otherwise the package is
marked `"private": true` so it can't be published by accident. The name comes from `--npm-name`, the existing
`package.json`, or `@<npm.scope>/<catalog>` from your preferences. The tool never runs `npm publish`; that's up to you.

### `--write-repo` (or `SKILLS_PAGES_WRITE_REPO=1`, or answer yes when asked)

This also writes `.claude-plugin/marketplace.json` and `.omp-plugin/marketplace.json` **into the catalog repo**, using relative
sources, so the repo works as a git marketplace (`claude plugin marketplace add owner/repo`) alongside the HTTPS JSON:

- Each skill gets a `{"source": "./", "strict": false, "skills": ["./path/to/skill"]}` entry. Claude Code and oh-my-pi both
  load exactly that one skill.
- Existing files are merged: hand-written entries and top-level fields are kept, and nothing is deleted. A diff is shown, and
  you're asked before writing unless you pass `--yes`.
- Nothing is committed; commit and push the two files yourself.

Once the repo has these files, the site's Claude Code and oh-my-pi guides use the git marketplace. They only do so for entries
the repo file really has with the same paths; anything else uses the published JSON.

## Install guides: agent → install method → setup / install / update

The install panel (on the catalog page and on every skill page) has an **Agent** dropdown next to the HTTPS/SSH and
Global/Project toggles. Each agent offers one or more **install methods**. A method is a single path with no
alternatives inside, split into **Setup**, **Install** and **Update** commands. Every method reads the same way:
- the first phase starts with a **Source** note: a link to the marketplace file or index on this site, or to the repo's own
  file, and whether it's fetched over HTTPS or SSH;
- the Install phase has one **Global/Project** note saying where the choice is recorded and what to commit;
- Update is an "Update …" step, or "Automatic: …" for OpenCode.

Above the methods, a **context estimate** shows what the install adds to an agent's context window: the name and
description tokens that are always loaded, the `SKILL.md` body tokens loaded when a skill is used, and the size on disk.
It's estimated at ~4 characters per token, which matches Claude Code's `plugin details` (e.g. `pdf` ≈ 110 / ≈ 1.9k).
The plugins page shows the same per plugin.

Every page has a top navbar (Skills, Plugins, the repo link); skill pages have a breadcrumb. Site navigation stays in the
same tab, and every other link opens a new one.

Every Install step names the folder it
installs into, as a click-to-copy chip. The folders below were verified on disk or in each tool's source:
`~/.claude/plugins/cache/<marketplace>/`, `~/.omp/plugins/cache/plugins/`, `~/.cache/opencode/skills/`,
`~/.pi/agent/git/<host>/<repo>/` (`.pi/git/…` for the project), and the skills CLI's per-agent folders (e.g. `~/.cursor/skills/`).

| Agent | Methods (most native first) |
| --- | --- |
| Claude Code | **Git marketplace** (when the repo's own marketplace has the entries) · **Site marketplace** (zip archives; Claude Code needs the site on public HTTPS) · skills CLI |
| oh-my-pi | **Git marketplace** · **Site marketplace** (git sources, whole catalog only, needs a repo) · skills CLI (`--agent pi`; omp reads `.agents/skills`) |
| OpenCode | **Remote index** (`skills.urls` in `opencode.json`; updates itself via each skill's `version`) · skills CLI |
| pi | **pi package** (`pi install`, `pi update`; whole catalog, root `skills/` layout) · skills CLI |
| Codex, Cursor, GitHub Copilot, Gemini CLI, Cline, Roo Code, Goose, Amp | skills CLI |
| T3 Code | Not supported: it has no skills install of its own. The tab says to install for the agent it runs (Claude Code, Codex) and start a new thread |

When the site URL is known but the site was built locally, not by CI, the site-based commands are still shown, with a
heads-up that they work once the site is deployed there. A repository with an origin but no commits gets a "commit and push
first" note.

A method that can't be used here is still listed, marked ⚠, with one of two kinds of warning:
- **"isn't set up for this site" + How to fix:** something you can change. Examples: the site URL couldn't be determined,
  there's no git repo, or the repo has no marketplace file.
- **"can't install these skills" + Use instead:** the method can't do this job, so it names the tab that can. Examples:
  a pi package (pi installs whole repositories) for a single skill, or repo-based methods for `--installed` skills.

A working method is selected by default. A method remembered from an earlier visit gives way to a working one if it's
blocked here, but a tab you click always opens.

The guides assume the catalog is read on another machine. Every command points at the published site or the public
repo, never at a path on the machine that built the site.

The **skills CLI** method uses the [Vercel skills CLI](https://github.com/vercel-labs/skills) for the selected agent only:
`DISABLE_TELEMETRY=1 npx skills add <git url | site url> --skill <name|'*'> --agent <id> [-g] -y`, then `npx skills update [name] -g|-p -y`.
It uses the repo when it can find every skill there. Otherwise, including with no repo, it uses the site's
`.well-known/agent-skills/` index.
`npx` downloads `skills` from npm.

Limits of the skills CLI that skills-pages works around or warns about (checked against v1.7):
- From a repo with **both** a root `skills/` folder and `plugins/<plugin>/skills/`, it stops at the root `skills/` unless
  `.claude-plugin/marketplace.json` lists the plugins. The guides switch to the site's well-known index in that case.
  Plugins-only and skills-only repos work as they are.
- It silently skips skills whose frontmatter isn't valid YAML. skills-pages warns about those (usually an unquoted `: `
  in `description`).
- It drops well-known entries whose description is over 1024 characters (the Agent Skills limit). The index shortens them,
  the zip keeps the full `SKILL.md`, and skills-pages warns.

## Interactive by default

On a terminal, the CLI asks for anything not given by a flag or a `SKILLS_PAGES_*` variable:
- the source (a repo, or your installed skills), and whether to serve it (and on which port);
- the marketplace name and title;
- the repo URL, if none was detected;
- the site URL and the output folder;
- whether to create the git marketplace files for Claude Code and oh-my-pi in the repo;
- whether to create a `package.json` for pi / npm (its name, and whether you'll publish it);
- whether to add a **GitHub Actions or GitLab CI** workflow that deploys the site to Pages, and the job's Docker image,
  npm registry and package. It's asked once per repo: the answer is saved as `SKILLS_PAGES_CI`, and an existing workflow
  file is never overwritten.

Answers are saved to `./.env`, which is added to `.gitignore` if needed, and loaded on the next run, so it doesn't ask
again. Real environment variables and flags always win over `.env`. `--no-interactive` (or `--yes`) turns prompts off, and
CI never prompts.

`--prompt` asks **every** question, even ones a flag, variable or `.env` already answers. Each question defaults to the value
that would otherwise be used, so a blank answer keeps it. It's handy for reviewing or changing saved answers. It needs a
terminal.

## Options

```
skills-pages build [source] [-o public] [-b base-url] [-n name] [-t title] [--repo-url url] [--ref ref] [-w] [-y]
                    [--no-index] [--no-follow] [--no-repo-icon]
skills-pages serve --installed [--port 4173]        # build and preview your installed skills
skills-pages build --no-interactive ...      # no prompts (CI is never interactive)
skills-pages build --prompt ...              # ask everything; Enter keeps the current value
```

Every option can be left out. Each value is resolved in this order, and the CLI prints a **Settings** box showing what it
picked and where it came from:

| Setting | Flag → env | then automatically |
| --- | --- | --- |
| source | argument → `SKILLS_PAGES_SOURCE` | CI checkout (`CI_PROJECT_DIR` / `GITHUB_WORKSPACE`), else `.` |
| base-url | `--base-url` → `SKILLS_PAGES_BASE_URL` | GitLab `CI_PAGES_URL` · GitHub `https://<owner>.github.io/<repo>/` from `GITHUB_REPOSITORY` · Pages URL of the origin remote |
| repo-url | `--repo-url` → `SKILLS_PAGES_REPO_URL` | `git remote get-url origin`, else `CI_PROJECT_URL` / `GITHUB_SERVER_URL`+`GITHUB_REPOSITORY` |
| commit (footer) | | `git rev-parse HEAD`, else `CI_COMMIT_SHA` / `GITHUB_SHA` |
| name | `--name` → `SKILLS_PAGES_NAME` | existing marketplace name, else repo name |
| title | `--title` → `SKILLS_PAGES_TITLE` | GitLab `CI_PROJECT_TITLE`, else the name |
| out | `--out` → `SKILLS_PAGES_OUT` | `public` |
| description | the repo marketplace's description | GitLab `CI_PROJECT_DESCRIPTION` (the project description), else the built-in text |
| index / follow | `--no-index` / `--no-follow` → `SKILLS_PAGES_INDEX=0` / `SKILLS_PAGES_FOLLOW=0` | both on (a preview or placeholder URL is always noindex) |
| repo icon | `--no-repo-icon` → `SKILLS_PAGES_REPO_ICON=0` | on |

- CI variables are only used when the source is the job's own checkout.
- GitHub Pages URLs are only derived on github.com. On GitHub Enterprise Server, or with a custom domain, pass
  `--base-url ${{ steps.pages.outputs.base_url }}` from `actions/configure-pages`.
- Without a TTY (CI) or with `--yes` there are no prompts.

### Search engines: `--no-index`, `--no-follow`

By default a site on a real public URL is indexable and followable. To keep it out of search results, build with
`--no-index` (or `SKILLS_PAGES_INDEX=0`): every page gets `noindex`, `robots.txt` says `Disallow: /`, and there's no
`sitemap.xml`. `--no-follow` (or `SKILLS_PAGES_FOLLOW=0`) adds `nofollow` to every page. They combine, and the Settings box
shows what's on. These are requests that well-behaved crawlers honour; they don't make a site private. `robots.txt` is
only read at an origin's root, so under a project path (`user.github.io/repo/`) the per-page meta tags do the work.

### Favicon: the repository's icon

When the repo is on github.com or a GitLab server, the build downloads its icon once and serves it from the site as the
favicon, apple-touch-icon, navbar logo and web-app icon (the social card stays the default). GitHub repos have no icon of
their own, so it's the **owner's avatar**; on GitLab it's the **project avatar**, else the **group's**. It's an anonymous
request to the repo's own host (never a token, never Gravatar or another host), limited to PNG/JPEG/GIF/WebP under 1 MB.
Private repositories and anything that fails fall back to the generated icon, and the build log says why. `--no-repo-icon`
(or `SKILLS_PAGES_REPO_ICON=0`) turns it off.

### Private Pages

**Private GitHub Pages and GitLab Pages can't serve a catalog.** Claude Code, oh-my-pi, OpenCode and the skills CLI
download the marketplace, index and zips without signing in, and a catalog has no way to give them credentials. For a
private repository, prefer the **git** methods (Git marketplace, pi package, skills CLI from the repo): they use your own
git credentials. The site-based install steps say so. The site is still fine to browse by people who can sign in.

### CI

`skills-pages init` writes the workflow for you (or `skills-pages init --ci github|gitlab` without prompts). It asks for
the job's Docker image (default `node:22`), an optional npm registry/mirror, and the package to run, and can save those as
defaults in `~/.config/skills-pages/config.json`. Packagers can ship defaults in `/etc/xdg/skills-pages/config.json`; see
[docs/install.md](docs/install.md#preferences-global-defaults-xdg).

**GitHub Actions** builds with `--base-url` from `actions/configure-pages`, so custom domains work, and deploys with
`actions/deploy-pages`. Enable Pages with "Source: GitHub Actions".

**GitLab CI** uses a `pages` job; the site URL comes from `CI_PAGES_URL`. Either way the run is linked from the site's
Source page. Before deploying, `skills-pages check public --strict` fails the job if anything would break.

## Privacy

- The site loads nothing from other hosts: system fonts, no analytics.
- A strict CSP (`default-src 'none'`, no inline script) and `no-referrer` are set.
- Settings are stored in `localStorage`.
- The build downloads the repository's icon from github.com / its GitLab server (see [Favicon](#favicon-the-repositorys-icon));
  `--no-repo-icon` makes the build fully offline. The icon is then served from the site itself.
- The build footer ("Built … ago", linking to the catalog commit) is filled in at generation time.

## Development

```console
npm test                # builds, then runs node:test (Node ≥ 22.18 runs the .ts tests directly)
npm run installed         # build ./public from every skill installed on this machine
npm run installed:serve   # build and serve it at http://localhost:4173 (local only, Ctrl+C to stop)
```

Any catalog can be previewed the same way: `npm start -- serve <path|git-url>`, or `npm start -- serve --no-build` for an
already-built `public/`. With `serve` the site URL
defaults to `http://localhost:<port>/`, so the install commands work against the local server.
