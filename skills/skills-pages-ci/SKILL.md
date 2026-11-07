---
name: skills-pages-ci
description: "Integrate skills-pages into a CI/CD pipeline so a skills repository is validated and its site and Claude Code marketplace are deployed to GitHub Pages or GitLab Pages on every push. Use when asked to automate publishing of a skills repo, add a pages workflow, or gate a deploy on skill checks."
metadata:
  tags: [ci, cd, github-pages, gitlab-pages]
---

# Publishing a skills repo from CI/CD

Goal: every push to the default branch validates the skills, builds the site with `skills-pages` and deploys it to
GitHub Pages or GitLab Pages. See the `skills-pages-cli` skill for the CLI itself.

## Fastest path

```console
npx --yes @nf3t/skills-pages init --ci github    # writes .github/workflows/skills-pages.yml
npx --yes @nf3t/skills-pages init --ci gitlab    # adds a `pages` job to .gitlab-ci.yml
```

It never overwrites an existing file. Extra options: `--image <docker image>`, `--npm-registry <url>` (internal mirror),
`--package <spec>` (pin, e.g. `@nf3t/skills-pages@1`).

Then, once: GitHub: Settings > Pages > Source: **GitHub Actions**. GitLab needs nothing.

## GitHub Actions, written by hand

```yaml
name: skills-pages
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    env:
      DO_NOT_TRACK: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npx --yes @nf3t/skills-pages check . --strict
      - id: pages
        uses: actions/configure-pages@v5
      - run: npx --yes @nf3t/skills-pages build --no-interactive --out public --base-url "${{ steps.pages.outputs.base_url }}/"
      - uses: actions/upload-pages-artifact@v3
        if: github.event_name != 'pull_request'
        with: { path: public }
      - id: deployment
        if: github.event_name != 'pull_request'
        uses: actions/deploy-pages@v4
```

## GitLab CI

```yaml
pages:
  image: node:22
  variables:
    DO_NOT_TRACK: "1"
  script:
    - npx --yes @nf3t/skills-pages check . --strict
    - npx --yes @nf3t/skills-pages build --no-interactive --out public
  artifacts:
    paths: [public]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

## Guidance

- Always `--no-interactive`; CI has no terminal.
- Run `check --strict` before `build` so broken skills fail the pipeline instead of shipping.
- Pass `--base-url` explicitly when using a custom domain or a project path the CLI can't infer.
- Checkout needs full history only for commit info on the Source page; the default shallow clone works.
- For the git-based Claude Code marketplace (`claude plugin marketplace add owner/repo`), commit the output of
  `skills-pages repo-files . --yes` (`.claude-plugin/marketplace.json`, `.omp-plugin/marketplace.json`). Do that locally, not
  in the deploy job, so the pipeline never needs write access.
- Never put tokens in the workflow: Pages deployment uses the built-in `GITHUB_TOKEN`/OIDC permissions shown above.
- Inside a custom container image add `git config --global --add safe.directory "$GITHUB_WORKSPACE"` after checkout.
