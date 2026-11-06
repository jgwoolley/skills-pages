# Installing skills-pages

`skills-pages` is published on npm as **`@nf3t/skills-pages`**, and installs a command named `skills-pages`.

## Requirements

- **Node.js 22.18 or newer**: `node --version`.
- **git**: it's used to read the catalog repo, its commit and its origin. To build from a git URL, git clones it.
- **Optional:** `npx skills`, the Vercel skills CLI. The generated install guides use it, but skills-pages itself doesn't need it.

## Run it without installing

```console
npx @nf3t/skills-pages            # interactive: asks what to build, saves the answers to ./.env
npx @nf3t/skills-pages serve ~/my-skills   # build and preview
```

`pnpm dlx @nf3t/skills-pages` and `bunx @nf3t/skills-pages` work the same way.

## Install the command

```console
npm install --global @nf3t/skills-pages      # or: pnpm add -g … / bun add -g …
skills-pages --version
skills-pages --help
```

Pin a major version to avoid surprises: `npm install -g @nf3t/skills-pages@1`.
Update with `npm update -g @nf3t/skills-pages`, and remove it with `npm uninstall -g @nf3t/skills-pages`.

### As a project dev dependency

```console
npm install --save-dev @nf3t/skills-pages
npx skills-pages build
```

## First run

```console
cd my-skills-repo
skills-pages init        # every question once; answers go to ./.env (git-ignored); optionally adds a CI workflow
skills-pages serve       # build and preview locally
skills-pages check public --strict
```

`skills-pages init` can write a GitHub Actions (`.github/workflows/skills-pages.yml`) or GitLab CI (`.gitlab-ci.yml`)
workflow that builds the site and deploys it to Pages. It asks:
- which **Docker image** the job runs in (default `node:22`);
- which **npm registry** to install skills-pages from (default: npm's own);
- which **package** to run (default `@nf3t/skills-pages`; pin it, e.g. `@nf3t/skills-pages@1`).

It then offers to save those choices as your defaults (see below). Without a terminal, use
`skills-pages init --ci github|gitlab [--image …] [--npm-registry …] [--package …]`.

## Behind a corporate network

### Installing from an internal npm registry

```ini
# ~/.npmrc (or the project's .npmrc)
@nf3t:registry=https://npm.corp.example/
```

The generated CI workflows pick the registry up from your preferences (`NPM_CONFIG_REGISTRY`), so CI also installs from
the mirror.

### Preferences: global defaults (XDG)

skills-pages reads preferences from the XDG Base Directory locations:

| Scope | File | Default path |
| --- | --- | --- |
| user | `$XDG_CONFIG_HOME/skills-pages/config.json` | `~/.config/skills-pages/config.json` |
| system | `$XDG_CONFIG_DIRS/skills-pages/config.json` (first directory wins) | `/etc/xdg/skills-pages/config.json` |

Precedence: **flags > environment variables > `./.env` > user file > system files > built-in defaults**.

```json
{
  "ci": {
    "provider": "gitlab",
    "image": "registry.corp.example/mirror/node:22",
    "npmRegistry": "https://npm.corp.example/",
    "package": "@nf3t/skills-pages@1"
  },
  "npm": {
    "scope": "nf3t"
  },
  "env": {
    "SKILLS_PAGES_PORT": "8080"
  }
}
```

- `ci.*` are the defaults for `skills-pages init`: the CI provider, the job's Docker image, its npm registry, and the
  package it runs.
- `npm.scope` sets the suggested package name for `--package-json`: `@<scope>/<catalog>`.
- `env` gives defaults for any `SKILLS_PAGES_*` variable (`SKILLS_PAGES_PORT`, `SKILLS_PAGES_OUT`, …). They apply only when
  neither the environment nor `./.env` sets the variable.
- `skills-pages config` prints what's in effect and which file each value comes from.

### Shipping it in an internal RPM

Package the CLI and a system-wide preferences file. Everyone who installs the RPM gets your image and registry by default,
and can still override them per user or per run.

```spec
Name:           skills-pages
Version:        1.0.0
Release:        1%{?dist}
Summary:        Publish agent skills repos as static sites
License:        MIT
Requires:       nodejs >= 22.18, git
Source0:        nf3t-skills-pages-%{version}.tgz
Source1:        config.json

%install
mkdir -p %{buildroot}%{_prefix}/lib/node_modules/@nf3t
tar -xzf %{SOURCE0} -C %{buildroot}%{_prefix}/lib/node_modules/@nf3t
mv %{buildroot}%{_prefix}/lib/node_modules/@nf3t/package %{buildroot}%{_prefix}/lib/node_modules/@nf3t/skills-pages
(cd %{buildroot}%{_prefix}/lib/node_modules/@nf3t/skills-pages && npm install --omit=dev --ignore-scripts)
mkdir -p %{buildroot}%{_bindir}
ln -s ../lib/node_modules/@nf3t/skills-pages/dist/src/cli.js %{buildroot}%{_bindir}/skills-pages
install -D -m 0644 %{SOURCE1} %{buildroot}%{_sysconfdir}/xdg/skills-pages/config.json

%files
%{_prefix}/lib/node_modules/@nf3t/skills-pages
%{_bindir}/skills-pages
%config(noreplace) %{_sysconfdir}/xdg/skills-pages/config.json
```

`nf3t-skills-pages-<version>.tgz` comes from `npm pack @nf3t/skills-pages@<version>`. To build fully offline, run the
`npm install --omit=dev` step when preparing the tarball instead. `%config(noreplace)` keeps local edits to the file
across upgrades.

## Privacy

- skills-pages makes no telemetry or analytics calls.
- Building from a git URL clones it.
- The generated install guides call `npx skills` with `DISABLE_TELEMETRY=1`.
- Generated CI jobs set `DO_NOT_TRACK=1`.
