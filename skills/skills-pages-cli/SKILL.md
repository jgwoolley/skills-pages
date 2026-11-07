---
name: skills-pages-cli
description: "Use the skills-pages CLI (@nf3t/skills-pages) to turn an agent skills repository into a static site with install guides and Claude Code, oh-my-pi, OpenCode and pi marketplaces. Use when asked to publish, preview, build, validate or check a skills repo, or to write its marketplace.json files."
metadata:
  tags: [skills, marketplace, cli, static-site]
---

# Using the skills-pages CLI

`skills-pages` builds a static site from a repo of agent skills (folders with a `SKILL.md`). The site has install guides,
per-skill zips and ready-made marketplaces. Run it with `npx --yes @nf3t/skills-pages <command>` (Node >= 22.18).

## Repo layout it understands

- `skills/<name>/SKILL.md` at the root: one plugin holding all of them.
- `plugins/<plugin>/skills/<name>/SKILL.md`: one plugin per folder, optional `plugins/<plugin>/.claude-plugin/plugin.json`.
- An existing `.claude-plugin/marketplace.json` or `.omp-plugin/marketplace.json` is the source of truth when present.

Each `SKILL.md` needs YAML frontmatter with a kebab-case `name` equal to its folder name and a `description` under 1024
characters. Quote descriptions that contain `: `, or the skills CLI will skip the skill.

## Commands

| Goal | Command |
| --- | --- |
| Validate before publishing | `npx --yes @nf3t/skills-pages check . --strict` (exit 1 on problems; `--verbose` shows passing checks) |
| Build the site into `./public` | `npx --yes @nf3t/skills-pages build --no-interactive` |
| Build and preview locally | `npx --yes @nf3t/skills-pages serve . --no-interactive` (http://localhost:4173) |
| Commit marketplaces into the repo | `npx --yes @nf3t/skills-pages repo-files . --yes` (or `build --write-repo --yes`) |
| Add a CI workflow | `npx --yes @nf3t/skills-pages init --ci github` (or `gitlab`) |
| Show effective preferences | `npx --yes @nf3t/skills-pages config` |

## Rules of thumb for agents

1. **Always pass `--no-interactive` (or `--yes`)** when running non-interactively; otherwise the CLI prompts and blocks.
2. Run `check . --strict` first and fix every warning (bad frontmatter, name/folder mismatch, long descriptions).
3. Set the site URL with `--base-url https://<owner>.github.io/<repo>/` if it can't be derived from the `origin` remote.
4. `--write-repo` modifies `.claude-plugin/` and `.omp-plugin/` in the repo and never commits; review the diff and commit yourself.
5. `public/` is build output. Do not commit it.
6. Useful options: `--out <dir>`, `--name <marketplace-name>`, `--title <text>`, `--ref <branch>`, `--repo-url <git-url>`,
   `--package-json` (make the repo a pi package), `--port <n>`.
7. Settings can also come from `.env` (`SKILLS_PAGES_*` variables) or global preferences; `config` shows which apply.

## Publishing the skills to npm (recommended for pi)

pi installs whole npm packages, so shipping the skills on npm is the most native way for pi users to get them:

```console
npx --yes @nf3t/skills-pages build --package-json --npm-name @scope/my-skills --npm-public --yes
npm publish --access public      # you run this; skills-pages never publishes
```

`--package-json` writes or merges `package.json` with the `pi-package` keyword, `pi.skills` (every folder holding skills)
and a `files` list that includes those folders and the marketplace folders. Without `--npm-public` the package is marked
`"private": true`. Check the tarball with `npm pack --dry-run`. Users then run `pi install npm:@scope/my-skills` and
`pi update`; the site's pi guide shows the same commands once the package is public.

## Installing from a published site

- Claude Code (git): `claude plugin marketplace add <owner>/<repo>` then `claude plugin install <plugin>@<marketplace>`.
- Claude Code (site): `claude plugin marketplace add https://<site>/claude/marketplace.json`.
- pi (npm, if published as above): `pi install npm:<package>`.
- Any agent via the skills CLI: `npx skills add <owner>/<repo> --skill <name>`.

The site itself lists the exact commands for every supported agent.
