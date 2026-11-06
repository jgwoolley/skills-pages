#!/usr/bin/env node
import * as p from "@clack/prompts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import pc from "picocolors";
import { ciInfo, isCiWorkspace, pick, resolveBaseUrl, resolveOut, resolveSourceArg, type CiInfo, type Env, type Resolved } from "./defaults.ts";
import { discover } from "./discover.ts";
import { adoptLegacyEnv, loadDotEnv, saveDotEnv, truthy } from "./envfile.ts";
import { discoverInstalled } from "./installed.ts";
import { serve } from "./serve.ts";
import { methods, type InstallData } from "./install.ts";
import { buildMarketplace, matchRepoMarketplace, mergeMarketplace, reservedMarketplaceName, reservedPluginName } from "./marketplace.ts";
import { packageRoot, publish } from "./publish.ts";
import { isGitUrl, parseRemote, resolveSource } from "./source.ts";
import { writeWorkflow } from "./ci-workflow.ts";
import { mergePackageJson, readPackageJson, skillRoots, validNpmName, type PackageJson, type PackageJsonOptions } from "./packagejson.ts";
import { applyEnvDefaults, loadPrefs, saveUserPrefs, systemConfigFiles, userConfigFile, type LoadedPrefs } from "./prefs.ts";
import type { Catalog, Marketplace, SourceInfo } from "./types.ts";

const HELP = `${pc.bold("skills-pages")} — publish an agent skills repo as a static site with install guides and marketplaces

${pc.bold("Commands")}
  build [source]        Build the site into ./public; this is what CI runs (the default command: \`skills-pages ./repo\` works too)
  serve [source]        Build, then serve it on http://localhost:<port>/ to preview (same options as build)
                        serve --no-build [dir] serves an existing build without rebuilding
  check <url|path…>     Check SKILL.md files, zips, indexes, marketplaces, a built site or a skills repo
                        the way agents would read them; exits 1 when something would break
  init                  Ask every question, save the answers to ./.env, and optionally add a CI workflow
                        that deploys the site to GitHub Pages or GitLab Pages
  repo-files [source]   Only write .claude-plugin/ and .omp-plugin/marketplace.json into the repo
  config                Show the global preferences in effect and the files they come from

${pc.bold("Examples")}
  skills-pages                                 ${pc.dim("# interactive: asks for what it needs")}
  skills-pages serve ~/skills                  ${pc.dim("# build and preview")}
  skills-pages serve --installed               ${pc.dim("# browse every skill installed on this machine")}
  skills-pages check https://you.github.io/skills/
  skills-pages check ./my-skills --strict      ${pc.dim("# in CI, before deploying")}

${pc.bold("Source")}
  A local path or git URL (https/ssh) of a repo with skills/<name>/SKILL.md
  and/or plugins/<plugin>/skills/<name>/SKILL.md. Default: the CI checkout, else "."

${pc.bold("Options")}  ${pc.dim("(each also reads SKILLS_PAGES_<NAME>, e.g. SKILLS_PAGES_BASE_URL, from the environment or ./.env)")}
  Interactive by default: it asks for anything not given by a flag or variable and saves the answers to ./.env.
  -o, --out <dir>       Output directory (default: public)
  -b, --base-url <url>  URL ./public is served from. Default: GitLab CI_PAGES_URL, GitHub Actions
                        https://<owner>.github.io/<repo>/, else the Pages URL of the origin remote
  -n, --name <name>     Marketplace name (default: existing marketplace name, else repo name)
  -t, --title <title>   Site title (default: GitLab CI_PROJECT_TITLE, else the name)
      --repo-url <url>  Git URL instead of the origin remote (default: origin, else CI_PROJECT_URL /
                        GITHUB_SERVER_URL/GITHUB_REPOSITORY)
      --ref <ref>       Branch/tag to pin in marketplace sources (and to clone)
  -w, --write-repo      Also write .claude-plugin/ and .omp-plugin/ marketplace.json into the repo
      --package-json    Also write/merge package.json so pi (and npm) can install the repo as a package
      --npm-name <name> Package name for --package-json (default: existing, else @<npm.scope>/<name>)
      --npm-public      Will be published to npm (otherwise package.json is marked private)
  -i, --installed       Use the skills installed on this machine (all agents: global + this project) as the source
  -s, --serve           build: also serve afterwards (same as the serve command)
      --no-build        serve: serve an existing build instead of building first
  -p, --port <port>     Port for serve (default: 4173)
      --prompt          Ask every question, even when a flag/variable/.env gives the value (Enter keeps it)
      --no-interactive  Don't ask anything (also when not on a terminal, or in CI)
  -y, --yes             Like --no-interactive, and confirm repo writes without asking
      --strict          check: treat warnings as failures
      --verbose         check: show passing checks too
      --ci <provider>   init: add a CI workflow without asking (github | gitlab | none)
      --image <image>   init: Docker image the CI job runs in (default: from preferences, else node:22)
      --npm-registry <url>  init: npm registry/mirror the CI job installs skills-pages from
      --package <spec>  init: package the CI job runs (default: @nf3t/skills-pages)

${pc.bold("Preferences")}  ${pc.dim("(XDG; flags > environment > ./.env > user file > system files > built-in)")}
  user:   $XDG_CONFIG_HOME/skills-pages/config.json   (default ~/.config/skills-pages/config.json)
  system: $XDG_CONFIG_DIRS/skills-pages/config.json   (default /etc/xdg/skills-pages/config.json)
  e.g. { "ci": { "provider": "gitlab", "image": "registry.corp/node:22", "npmRegistry": "https://npm.corp/" },
         "env": { "SKILLS_PAGES_PORT": "4173" } }
  -h, --help            Show this help
  -v, --version         Show the version
`;

const run = promisify(execFile);
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** clack spinner on a TTY; plain step lines when piped (no animation frames in logs). */
function spinner() {
  if (process.stdout.isTTY) return p.spinner();
  return { start: (_msg?: string) => {}, stop: (msg?: string) => p.log.step(msg ?? "") };
}

async function main() {
  // Answers from a previous interactive run (never overrides real environment variables).
  const dotenv = loadDotEnv(process.cwd());
  const legacy = adoptLegacyEnv(); // SKILLS_CATALOG_* still works after the rename
  // Global preferences (XDG): system files from packagers, then the user's file. Their `env` fills unset variables.
  prefs = await loadPrefs();
  const prefEnv = applyEnvDefaults(prefs);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      out: { type: "string", short: "o" },
      "base-url": { type: "string", short: "b" },
      name: { type: "string", short: "n" },
      title: { type: "string", short: "t" },
      "repo-url": { type: "string" },
      ref: { type: "string" },
      "write-repo": { type: "boolean", short: "w", default: false },
      "package-json": { type: "boolean" },
      "npm-name": { type: "string" },
      "npm-public": { type: "boolean" },
      installed: { type: "boolean", short: "i", default: false },
      serve: { type: "boolean", short: "s", default: false },
      port: { type: "string", short: "p" },
      yes: { type: "boolean", short: "y", default: false },
      interactive: { type: "boolean", default: true },
      build: { type: "boolean", default: true },
      prompt: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      ci: { type: "string" },
      image: { type: "string" },
      "npm-registry": { type: "string" },
      package: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) {
    const pkg = JSON.parse(await readFile(path.join(packageRoot(), "package.json"), "utf8")) as { version: string };
    return void console.log(pkg.version);
  }
  // Subcommand: build is the default, so `skills-pages ./repo` still builds. Anything else that isn't a path is an error.
  let command: Command = "build";
  let args = positionals;
  const first = positionals[0];
  if (first && (COMMANDS as readonly string[]).includes(first)) {
    command = first as Command;
    args = positionals.slice(1);
  } else if (first && !looksLikeSource(first)) {
    throw new Error(`Unknown command "${first}". Commands: ${COMMANDS.join(", ")}. To build from a folder named "${first}", use ./${first}`);
  }
  const env = process.env;
  const ci = ciInfo(env);
  // Interactive by default on a terminal; never in CI or with --no-interactive / --yes.
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;

  for (const e of prefs.errors) console.error(pc.yellow(`Ignoring preferences ${e}`));
  if (command === "config") return configCommand();
  if (command === "check") return checkCommand(args, values);
  // `serve --no-build [dir]`: serve an existing build. Plain `serve` builds first (below), like `build`.
  if (command === "serve" && values.build === false) return serveCommand(args, values, env);
  if (command === "repo-files") return repoFilesCommand(args, values, env, tty && values.interactive && !values.yes && !ci);
  if (command === "init" && !tty) {
    if (!values.ci) throw new Error("init asks questions, so it needs a terminal (or pass --ci github|gitlab to only add the CI workflow)");
    return ciOnly(values.ci, values.out ?? env.SKILLS_PAGES_OUT ?? "public", values);
  }

  // --prompt (and init): ask everything; each question defaults to the value that would be used otherwise (blank = keep it).
  const promptAll = values.prompt || command === "init";
  if (promptAll && !tty) throw new Error("--prompt needs an interactive terminal");
  const interactive = promptAll || (values.interactive && !values.yes && tty && !ci);
  const answers: Answers = {};
  const fromEnv = (key: string) => (dotenv.has(key) ? ".env" : key);

  p.intro(
    `${pc.bgMagenta(pc.black(" skills-pages "))} ${pc.dim(command === "init" ? "init: answers for later builds" : command === "serve" ? "serve: build, then preview locally" : "static site · marketplaces · OpenCode index")}`,
  );
  if (dotenv.size) p.log.info(pc.dim(`Loaded ${[...dotenv].join(", ")} from .env`));
  if (prefEnv.length) p.log.info(pc.dim(`Defaults from preferences: ${prefEnv.map((k) => `${k} (${prefs.env[k]!.from})`).join(", ")}`));
  if (legacy.length) p.log.info(pc.dim(`Using the old names ${legacy.join(", ")} as SKILLS_PAGES_*; rename them when convenient.`));

  // What to build from: a repo, or the skills installed on this machine.
  let installed = values.installed || truthy(env.SKILLS_PAGES_INSTALLED) === true;
  if (interactive && (promptAll || (!values.installed && env.SKILLS_PAGES_INSTALLED === undefined && !args[0] && !env.SKILLS_PAGES_SOURCE))) {
    const kind = await ask(
      p.select({
        message: "What should the catalog be built from?",
        initialValue: installed ? "installed" : "repo",
        options: [
          { value: "repo", label: "A skills repository", hint: "local path or git URL" },
          { value: "installed", label: "Skills installed on this machine", hint: "all agents: global + this project" },
        ],
      }),
    );
    installed = kind === "installed";
    answers.SKILLS_PAGES_INSTALLED = installed ? "1" : "0";
  }

  // `serve` builds, then serves; `build` only builds (it's what CI runs). `build --serve` is kept as an alias.
  const serveOn = command === "serve" || !!values.serve;
  if (command === "build" && values.serve) p.log.info(pc.dim("`build --serve` still works; `skills-pages serve` is the same thing."));
  if (command === "build" && truthy(env.SKILLS_PAGES_SERVE) === true)
    p.log.info(pc.dim(`SKILLS_PAGES_SERVE${fromEnv("SKILLS_PAGES_SERVE") === ".env" ? " (from .env)" : ""} is ignored: \`build\` only builds now; run \`skills-pages serve\` to build and preview.`));
  let portText = values.port ?? env.SKILLS_PAGES_PORT;
  if (interactive && serveOn && (promptAll || !portText)) {
    const def = portText ?? "4173";
    portText = await ask(p.text({ message: "Port", placeholder: def, defaultValue: def, validate: (v) => (!v || /^\d{2,5}$/.test(v) ? undefined : "Enter a port number") }));
    answers.SKILLS_PAGES_PORT = portText;
  }
  const port = Number(portText ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port: ${portText}`);
  const opts = { ...values, serve: serveOn };

  if (installed) {
    if (args[0]) throw new Error("--installed collects skills from this machine; don't pass a source as well");
    if (values["write-repo"]) throw new Error("--write-repo needs a repository; it can't be used with --installed");
    const s = spinner();
    s.start("Collecting installed skills");
    const { catalog, src, locations } = await discoverInstalled({ name: values.name ?? nonEmpty(env.SKILLS_PAGES_NAME), title: values.title ?? nonEmpty(env.SKILLS_PAGES_TITLE) });
    s.stop(`Found ${pc.bold(String(catalog.skills.length))} installed skill${catalog.skills.length === 1 ? "" : "s"} in ${locations.length} location${locations.length === 1 ? "" : "s"}`);
    p.note(locations.map((l) => `${pc.dim(l.scope === "global" ? "global " : "project")}  ${l.description}`).join("\n") || "none", "Locations");
    // The repo this runs in hosts the site: its origin gives the Pages URL, its commit goes on the build page.
    const ciHost = isCiWorkspace(ci, process.cwd()) ? ci : undefined;
    const host = await resolveSource(process.cwd(), {
      repoUrl: values["repo-url"] ?? nonEmpty(env.SKILLS_PAGES_REPO_URL),
      fallback: ciHost ? { repoUrl: ciHost.repoUrl, sha: ciHost.sha, from: ci?.provider === "gitlab" ? "GitLab CI" : "GitHub Actions" } : undefined,
    }).catch(() => undefined);
    if (host && (host.remote || host.sha)) {
      src.host = host;
      p.log.info(`Site repository: ${host.remote?.webUrl ?? host.dir}${host.sha ? pc.dim(` @ ${host.sha.slice(0, 7)}`) : pc.dim(" (no commits yet)")}`);
    }
    await build(src, opts, interactive, { env, ci, input: { value: "installed skills", from: values.installed ? "--installed" : answers.SKILLS_PAGES_INSTALLED ? "prompt" : fromEnv("SKILLS_PAGES_INSTALLED") }, port, catalog, answers, fromEnv, promptAll, mode: command === "init" ? "init" : "build", ciFlag: values.ci, flags: values });
    return;
  }

  let inputR = resolveSourceArg(args[0], env, ci);
  if (interactive && (promptAll || !inputR)) {
    const def = inputR?.value ?? ".";
    const answer = await ask(p.text({ message: "Catalog repository (local path or git URL)", placeholder: def, defaultValue: def }));
    inputR = answer === inputR?.value ? inputR : { value: answer, from: "prompt" };
    answers.SKILLS_PAGES_SOURCE = answer;
  }
  inputR ??= { value: ".", from: "default" };
  const input = inputR.value;
  const repoUrlR = pick([values["repo-url"], "--repo-url"], [env.SKILLS_PAGES_REPO_URL, "SKILLS_PAGES_REPO_URL"]);
  const ciHere = isCiWorkspace(ci, input) ? ci : undefined;
  const ciLabel = ci?.provider === "gitlab" ? "GitLab CI" : "GitHub Actions";

  const s = spinner();
  s.start(`Resolving ${pc.cyan(input)}`);
  const src = await resolveSource(input, {
    ref: values.ref ?? nonEmpty(env.SKILLS_PAGES_REF),
    repoUrl: repoUrlR?.value,
    repoUrlFrom: repoUrlR?.from,
    fallback: ciHere ? { repoUrl: ciHere.repoUrl, sha: ciHere.sha, from: ciLabel } : undefined,
  });
  try {
    s.stop(`Source ${pc.cyan(src.local ? src.dir : input)}${src.sha ? pc.dim(` @ ${src.sha.slice(0, 7)}`) : ""}`);
    if (!src.commitUrl)
      p.log.info(pc.dim(`Source page: ${src.sha ? "no origin" : "no commit yet"} (from git or CI variables), so it can't link the commit on GitHub/GitLab`));
    if (!src.remote)
      p.log.info(pc.dim(`No git remote: git-based install methods are off (set ${pc.bold("origin")} or pass ${pc.bold("--repo-url")} to enable them).`));
    // No remote detected: ask for the repo URL (optional), which enables the git-based install methods.
    // An empty saved value means "asked, skipped": don't ask again.
    if (interactive && (promptAll || (!src.remote && !repoUrlR && env.SKILLS_PAGES_REPO_URL === undefined))) {
      const def = repoUrlR?.value ?? src.remote?.httpsUrl ?? "";
      const url = await ask(
        p.text({ message: `Git URL of the repository (${def ? "Enter keeps it" : "optional, Enter to skip"})`, placeholder: def || "https://github.com/you/skills.git", defaultValue: def }),
      );
      const remote = url ? parseRemote(url) : undefined;
      if (url && !remote) p.log.warn(`Not a git URL I understand: ${url}`);
      if (remote && url !== def) Object.assign(src, { remote, remoteFrom: "prompt" });
      answers.SKILLS_PAGES_REPO_URL = remote ? url : "";
    }
    await build(src, opts, interactive, { env, ci, input: inputR, port, answers, fromEnv, promptAll, mode: command === "init" ? "init" : "build", ciFlag: values.ci, flags: values });
  } finally {
    await src.cleanup();
  }
}

interface Values {
  serve?: boolean;
  "package-json"?: boolean;
  "npm-name"?: string;
  "npm-public"?: boolean;
  ci?: string;
  out?: string;
  "base-url"?: string;
  name?: string;
  title?: string;
  ref?: string;
  "write-repo"?: boolean;
}

type Answers = Record<string, string>;

interface Ctx {
  env: Env;
  ci: CiInfo | undefined;
  input: Resolved;
  port: number;
  /** Interactive answers, saved to ./.env. */
  answers: Answers;
  /** "SKILLS_PAGES_X" → ".env" when the value came from the .env file (for the settings box). */
  fromEnv: (key: string) => string;
  /** --prompt: ask every question, defaulting to the value that would be used otherwise. */
  promptAll: boolean;
  /** init: ask and save, then offer a CI workflow instead of building. */
  mode: "build" | "init";
  /** init --ci <provider>. */
  ciFlag?: string;
  /** All flags (init's --image / --npm-registry / --package). */
  flags: Flags;
  /** Pre-built catalog (--installed) instead of discovering a repo. */
  catalog?: Catalog;
}

async function build(src: SourceInfo, values: Values, interactive: boolean, ctx: Ctx) {
  const { env, ci } = ctx;
  const ciHere = isCiWorkspace(ci, src.dir) ? ci : undefined;
  const nameR = pick([values.name, "--name"], [env.SKILLS_PAGES_NAME, "SKILLS_PAGES_NAME"]);
  const titleR = pick([values.title, "--title"], [env.SKILLS_PAGES_TITLE, "SKILLS_PAGES_TITLE"], [ciHere?.title, "CI_PROJECT_TITLE"]);
  const outR = resolveOut(values.out, env);
  values = { ...values, name: nameR?.value, title: titleR?.value, out: outR.value };

  const s = spinner();
  let cat = ctx.catalog;
  if (!cat) {
    s.start("Discovering skills");
    cat = await discover(src, { name: values.name, title: values.title });
    s.stop(`Found ${pc.bold(String(cat.skills.length))} skill${cat.skills.length === 1 ? "" : "s"} in ${cat.plugins.length} plugin${cat.plugins.length === 1 ? "" : "s"}`);
  }
  if (!cat.skills.length) throw new Error("No skills found (expected skills/<name>/SKILL.md or plugins/<plugin>/skills/<name>/SKILL.md)");
  const { answers } = ctx;

  // Name and title: ask unless given by a flag or variable.
  if (interactive && (ctx.promptAll || !nameR)) {
    const name = await ask(
      p.text({
        message: "Marketplace name (used as <plugin>@<name>)",
        defaultValue: cat.name,
        placeholder: cat.name,
        validate: (v) => {
          const n = v || cat!.name;
          if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) return "Lowercase letters, digits and hyphens";
          const bad = reservedMarketplaceName(n);
          return bad ? `Claude Code refuses this name: ${bad}` : undefined;
        },
      }),
    );
    if (name !== cat.name) {
      values = { ...values, name };
      cat = ctx.catalog ? Object.assign(cat, { name }) : await discover(src, { name, title: values.title });
    }
    answers.SKILLS_PAGES_NAME = name;
  }
  if (interactive && (ctx.promptAll || !titleR)) {
    const title = await ask(p.text({ message: "Site title", defaultValue: cat.title, placeholder: cat.title }));
    cat.title = title;
    answers.SKILLS_PAGES_TITLE = title;
  }
  const repoName = cat.existing.claude?.name ?? cat.existing.omp?.name;
  if (repoName && repoName !== cat.name)
    p.log.warn(`Marketplace name ${pc.bold(cat.name)} differs from the repo's ${pc.bold(repoName)}${values["write-repo"] ? "; --write-repo renames it" : ""}`);
  for (const w of cat.warnings) p.log.warn(w);
  // A reserved marketplace name breaks every generated marketplace: Claude Code refuses to add it (outside Anthropic's
  // own GitHub repos). Reserved plugin names only trip `claude plugin validate`; Claude Code installs them anyway.
  const badName = reservedMarketplaceName(cat.name);
  if (badName)
    throw new Error(
      `Marketplace name "${cat.name}" can't be used: ${badName}, so Claude Code would refuse to add the generated marketplaces. Pass --name <name> (or set SKILLS_PAGES_NAME).`,
    );
  const reserved = [...new Set([...cat.plugins.map((x) => x.name), ...cat.skills.map((x) => x.entry)])].filter(reservedPluginName);
  if (reserved.length)
    p.log.info(
      pc.dim(`${reserved.join(", ")}: names Claude Code calls reserved for Anthropic. It installs and loads them fine; only \`claude plugin validate\` flags them.`),
    );
  const preserved = cat.plugins.filter((x) => x.entry);
  if (preserved.length) {
    const file = cat.existing.claude ? ".claude-plugin/marketplace.json" : ".omp-plugin/marketplace.json";
    const ext = preserved.filter((x) => x.external).length;
    p.log.info(`Preserved ${preserved.length} plugin${preserved.length === 1 ? "" : "s"} from ${file}: ${preserved.map((x) => x.name).join(", ")}${ext ? pc.dim(` (${ext} from other repos, passed through)`) : ""}`);
  }

  p.note(skillTable(cat), "Skills");

  // The site's repository: the catalog repo, or (installed skills) the repo the site is built in.
  const siteRepo = src.remote ? src : src.host;
  let baseR = resolveBaseUrl(values["base-url"], env, ci, siteRepo?.remote, src.host ? src.host.dir : src.dir, values.serve ? `http://localhost:${ctx.port}/` : undefined);
  // Ask unless a flag, variable, --serve or CI decided it (a URL derived from the origin is offered as the default).
  if (interactive && (ctx.promptAll || ((!baseR || baseR.from === "git origin") && env.SKILLS_PAGES_BASE_URL === undefined))) {
    const answer = await ask(
      p.text({
        message: "Where will the site be served from? (Enter to skip)",
        placeholder: baseR?.value ?? "https://you.github.io/skills/",
        defaultValue: baseR?.value ?? "",
        validate: (v) => (!v || /^https?:\/\//.test(v) ? undefined : "Enter an http(s) URL"),
      }),
    );
    if (answer) baseR = { value: answer.endsWith("/") ? answer : `${answer}/`, from: answer === baseR?.value ? baseR.from : "prompt" };
    answers.SKILLS_PAGES_BASE_URL = answer ? baseR!.value : ""; // empty: asked and skipped
  }
  if (!baseR) {
    baseR = { value: "http://localhost:8080/", from: "fallback" };
    p.log.warn(
      `Could not work out where the site is served; using ${baseR.value} as a placeholder. Site-based install methods show a warning until you rebuild with --base-url or SKILLS_PAGES_BASE_URL.`,
    );
  }
  const siteUrl = baseR.value;

  if (interactive && (ctx.promptAll || outR.from === "default")) {
    const out = await ask(p.text({ message: "Output folder", defaultValue: outR.value, placeholder: outR.value }));
    values = { ...values, out };
    if (out !== outR.value) Object.assign(outR, { value: out, from: "prompt" });
    answers.SKILLS_PAGES_OUT = out;
  }

  // Git marketplace files in the repo: --write-repo, SKILLS_PAGES_WRITE_REPO, or ask (local repos only).
  let writeRepoFiles = !!values["write-repo"] || truthy(env.SKILLS_PAGES_WRITE_REPO) === true;
  const writeDecided = !!values["write-repo"] || env.SKILLS_PAGES_WRITE_REPO !== undefined;
  if (interactive && (ctx.promptAll || !writeDecided) && src.local && !ctx.catalog) {
    writeRepoFiles = await ask(
      p.confirm({
        message: "Create the git marketplace files for Claude Code and oh-my-pi in the repo (.claude-plugin/ and .omp-plugin/marketplace.json)?",
        initialValue: writeDecided ? writeRepoFiles : !cat.existing.claude,
      }),
    );
    answers.SKILLS_PAGES_WRITE_REPO = writeRepoFiles ? "1" : "0";
  }

  // package.json for pi / npm: --package-json, SKILLS_PAGES_PACKAGE_JSON, or ask (local repos only).
  const repoOnly = src.local && !ctx.catalog;
  const repoPkg = repoOnly ? await readPackageJson(src.dir) : undefined;
  let pkgChoice: PackageJsonOptions | undefined;
  if (repoOnly) {
    const pkgDecided = values["package-json"] !== undefined || env.SKILLS_PAGES_PACKAGE_JSON !== undefined;
    let wantPkg = values["package-json"] ?? truthy(env.SKILLS_PAGES_PACKAGE_JSON) === true;
    if (interactive && (ctx.promptAll || !pkgDecided)) {
      wantPkg = await ask(
        p.confirm({
          message: "Create a package.json so pi can install these skills as a package (and npm can publish them)?",
          initialValue: pkgDecided ? wantPkg : !!repoPkg?.pi,
        }),
      );
      answers.SKILLS_PAGES_PACKAGE_JSON = wantPkg ? "1" : "0";
    }
    if (wantPkg) {
      const nameGiven = values["npm-name"] ?? nonEmpty(env.SKILLS_PAGES_NPM_NAME);
      let npmName = nameGiven ?? repoPkg?.name ?? (prefs.npmScope ? `@${prefs.npmScope.value}/${cat.name}` : cat.name);
      if (interactive && (ctx.promptAll || !nameGiven)) {
        npmName = await ask(
          p.text({
            message: `npm package name${prefs.npmScope && !repoPkg?.name ? pc.dim(` (scope from ${prefs.npmScope.from})`) : ""}`,
            defaultValue: npmName,
            placeholder: npmName,
            validate: (v) => (validNpmName(v || npmName) ? undefined : "Lowercase; optionally @scope/name"),
          }),
        );
        answers.SKILLS_PAGES_NPM_NAME = npmName;
      }
      const publicGiven = values["npm-public"] ?? truthy(env.SKILLS_PAGES_NPM_PUBLIC);
      let isPublic = publicGiven ?? (repoPkg ? repoPkg.private !== true : false);
      if (interactive && (ctx.promptAll || publicGiven === undefined)) {
        isPublic = await ask(p.confirm({ message: "Will you publish it to npm? (No marks it private, so it can't be published by accident)", initialValue: isPublic }));
        answers.SKILLS_PAGES_NPM_PUBLIC = isPublic ? "1" : "0";
      }
      pkgChoice = { name: npmName, public: isPublic };
    }

    // CI/CD that builds and deploys the site: asked once per repo (remembered in .env), or every time with init/--prompt.
    const ciGiven = (values.ci as string | undefined) ?? nonEmpty(env.SKILLS_PAGES_CI);
    const hasWorkflow = existsSync(path.join(src.dir, ".github", "workflows", "skills-pages.yml")) || existsSync(path.join(src.dir, ".gitlab-ci.yml"));
    if (interactive && (ctx.promptAll || (!ciGiven && !hasWorkflow))) {
      answers.SKILLS_PAGES_CI = (await initWorkflow(src.dir, values.out ?? "public", true, { ...ctx.flags, ci: values.ci }, src.remote?.isGitLab)) ?? "none";
    } else if (ciGiven && ciGiven !== "none" && !hasWorkflow) {
      await initWorkflow(src.dir, values.out ?? "public", false, { ...ctx.flags, ci: ciGiven });
    }
  }

  if (Object.keys(answers).length) {
    const saved = await saveDotEnv(process.cwd(), answers);
    p.log.success(`Saved your answers to ${pc.cyan(path.relative(process.cwd(), saved.file) || ".env")}${saved.ignoredNow ? " and added it to .gitignore" : " (git-ignored)"}; the next run won't ask again.`);
  }
  if (ctx.mode === "init") {
    p.outro(`Ready. Run ${pc.cyan("skills-pages build")} to build with these settings.`);
    return;
  }

  const existingName = cat.existing.claude?.name ?? cat.existing.omp?.name;
  const from = (t: string) => pc.dim(`(${t})`);
  const label = (f: string) => (f.startsWith("SKILLS_PAGES_") ? ctx.fromEnv(f) : f);
  p.note(
    [
      ["source", ctx.input.value, ctx.input.from],
      ["repo", src.remote?.webUrl ?? pc.yellow("none"), src.remoteFrom ?? "not found"],
      ["commit", src.sha?.slice(0, 12) ?? pc.yellow("none"), src.shaFrom ?? "not found"],
      ["base-url", siteUrl, label(baseR.from)],
      ["name", cat.name, answers.SKILLS_PAGES_NAME ? "prompt" : nameR ? label(nameR.from) : ctx.catalog ? "default" : existingName ? "existing marketplace" : "repo name"],
      ["title", cat.title, answers.SKILLS_PAGES_TITLE ? "prompt" : titleR ? label(titleR.from) : ctx.catalog ? "default" : existingName ? "existing marketplace" : "repo name"],
      ["out", outR.value, label(outR.from)],
    ]
      .map(([k, v, f]) => `${pc.bold(k!.padEnd(9))}${v}  ${from(f!)}`)
      .join("\n"),
    ci ? `Settings · ${ci.provider === "gitlab" ? "GitLab CI" : "GitHub Actions"}` : "Settings",
  );

  // Marketplaces committed in the repo (written now with --write-repo, or already there).
  let repoFiles: string[] = [];
  if (writeRepoFiles) {
    if (!src.local) throw new Error("--write-repo needs a local checkout; clone the repo and pass its path");
    repoFiles = await writeRepo(cat, src, values.ref, interactive, !!values.name);
    if (!repoFiles.length) p.log.info(pc.dim("Repo marketplace files: nothing to change."));
  }
  if (pkgChoice) {
    if (await writePackageJson(cat, src, pkgChoice, interactive)) repoFiles.push("package.json");
  }
  // A package.json with a `pi` key makes the repo a pi package (git), and an npm package once published.
  const pkgNow = src.local && !ctx.catalog ? await readPackageJson(src.dir) : undefined;
  if (pkgNow?.pi) cat.piPackage = true;
  const npm = pkgNow?.pi && pkgNow.name ? { name: pkgNow.name, public: pkgNow.private !== true } : undefined;
  const git = await gitMarketplaces(cat, src);
  const checkout = src.local && !ctx.catalog
    ? {
        isGitRepo: !!src.isGitRepo,
        hasCommits: !!src.sha,
        claudeFile: existsSync(path.join(src.dir, ".claude-plugin", "marketplace.json")),
        ompFile: existsSync(path.join(src.dir, ".omp-plugin", "marketplace.json")),
      }
    : undefined;

  s.start(`Writing ${pc.cyan(values.out ?? "public")}`);
  const res = await publish(cat, src, {
    out: values.out ?? "public",
    siteUrl,
    siteUrlKnown: baseR.from !== "fallback",
    ref: values.ref,
    git,
    ...(checkout ? { checkout } : {}),
    ...(npm ? { npm } : {}),
    ...(ci?.run ? { ci: { provider: ci.provider, ...ci.run } } : {}),
    // Built by CI is assumed deployed; a local build may not be (the pages say so).
    deploy: { builtBy: ci ? "ci" : "local", noCommits: !!siteRepo?.remote && !siteRepo.sha },
  });
  s.stop(`Wrote ${pc.cyan(path.resolve(values.out ?? "public"))}`);
  for (const w of res.warnings) p.log.warn(w);

  p.note(
    [
      `${pc.bold("site")}        index.html, assets/, plugins/, skill/`,
      `${pc.bold("folder")}      .claude-plugin/, .omp-plugin/ ${pc.dim("(git/folder marketplace)")}`,
      `${pc.bold("claude")}      claude/marketplace.json ${pc.dim("(zip archives in claude/archives/)")}`,
      `${pc.bold("skills CLI")}  .well-known/agent-skills/index.json ${pc.dim("(npx skills add <site>)")}`,
      ...(src.remote ? [`${pc.bold("oh-my-pi")}    omp/marketplace.json ${pc.dim("(+ .ssh.json, git sources)")}`] : []),
      `${pc.bold("opencode")}    index.json, <skill>/…, opencode/<skill>/index.json`,
      `${pc.dim("served at")}   ${siteUrl}`,
    ].join("\n"),
    "Generated",
  );
  if (repoFiles.length) p.log.info(`Repo files to commit and push:\n${repoFiles.map((f) => `  ${pc.green(f)}`).join("\n")}`);
  const first = methods(res.data, "claude", { protocol: "https", scope: "global" }).find((m) => !m.blocked);
  if (first) p.note(quickStart(res.data), `Install · Claude Code · ${first.label}`);
  if (values.serve) {
    const out = path.resolve(values.out ?? "public");
    await serve(out, ctx.port).catch((err: NodeJS.ErrnoException) => {
      throw new Error(err.code === "EADDRINUSE" ? `Port ${ctx.port} is in use; pass --port` : String(err));
    });
    p.outro(`Serving ${pc.cyan(out)} at ${pc.underline(`http://localhost:${ctx.port}/`)} ${pc.dim("(local only · Ctrl+C to stop)")}`);
    await new Promise(() => {}); // keep serving until interrupted
  }
  p.outro(`Done. Deploy ${pc.cyan(values.out ?? "public")} to ${pc.underline(siteUrl)}`);
}

function skillTable(cat: Catalog): string {
  const rows = cat.skills.map((s) => [s.name, cat.plugins.filter((p) => p.skills.includes(s)).map((p) => p.name).join(", "), s.description]);
  const w0 = Math.max(5, ...rows.map((r) => r[0]!.length));
  const w1 = Math.max(6, ...rows.map((r) => r[1]!.length));
  const cols = Math.max(20, Math.min(process.stdout.columns || 80, 120) - w0 - w1 - 12);
  const cut = (t: string) => (t.length > cols ? `${t.slice(0, cols - 1)}…` : t);
  return [
    pc.dim(`${"skill".padEnd(w0)}  ${"plugin".padEnd(w1)}  description`),
    ...rows.map(([n, pl, d]) => `${pc.cyan(n!.padEnd(w0))}  ${pc.magenta(pl!.padEnd(w1))}  ${cut(d!)}`),
  ].join("\n");
}

function quickStart(d: InstallData): string {
  const m = methods(d, "claude", { protocol: "https", scope: "global" }).find((x) => !x.blocked);
  if (!m) return "";
  return m.phases
    .filter((ph) => ph.kind !== "update")
    .flatMap((ph) => ph.steps.map((st) => st.code))
    .join("\n");
}

async function gitMarketplaces(cat: Catalog, src: SourceInfo): Promise<InstallData["git"]> {
  const read = async (f: string) => {
    try {
      return JSON.parse(await readFile(path.join(src.dir, f), "utf8")) as Marketplace;
    } catch {
      return undefined;
    }
  };
  const claude = await read(".claude-plugin/marketplace.json");
  const ompOwn = await read(".omp-plugin/marketplace.json");
  const omp = ompOwn ?? claude; // omp falls back to .claude-plugin
  const c = matchRepoMarketplace(cat, claude);
  const o = matchRepoMarketplace(cat, omp);
  return {
    claude: !!claude && !!src.remote,
    omp: !!omp && !!src.remote,
    claudeSkills: c.skills,
    ompSkills: o.skills,
    claudeEntries: c.plugins,
    ompEntries: o.plugins,
    claudeName: claude?.name,
    ompFile: ompOwn ? ".omp-plugin/marketplace.json" : ".claude-plugin/marketplace.json",
    ompName: omp?.name,
  };
}

async function writeRepo(cat: Catalog, src: SourceInfo, ref: string | undefined, interactive: boolean, rename: boolean): Promise<string[]> {
  const written: string[] = [];
  const gen = buildMarketplace(cat, src, { mode: "relative", ref });
  for (const w of gen.warnings) p.log.warn(w);
  for (const [dir, existing] of [
    [".claude-plugin", cat.existing.claude],
    [".omp-plugin", cat.existing.omp],
  ] as const) {
    const file = path.join(src.dir, dir, "marketplace.json");
    const next = `${JSON.stringify(mergeMarketplace(existing, gen.marketplace, gen.skillEntries, { rename }), null, 2)}\n`;
    const prev = await readFile(file, "utf8").catch(() => undefined);
    const rel = path.join(dir, "marketplace.json");
    if (prev === next) {
      p.log.info(`${rel} is up to date`);
      continue;
    }
    if (prev !== undefined) {
      p.log.message(`${pc.bold(rel)}\n${await diff(prev, next)}`);
      if (interactive) {
        const ok = await p.confirm({ message: `Update ${rel} in the repo?` });
        if (p.isCancel(ok)) return cancel();
        if (!ok) continue;
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, next);
    written.push(rel);
    p.log.success(`${prev === undefined ? "Created" : "Updated"} ${rel}`);
  }
  return written;
}

/** Coloured unified diff via `git diff --no-index` (git is required anyway). */
async function diff(a: string, b: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skills-pages-diff-"));
  try {
    await writeFile(path.join(dir, "current"), a);
    await writeFile(path.join(dir, "new"), b);
    const r = await run("git", ["diff", "--no-index", "--color=always", "--no-prefix", "-U2", "current", "new"], { cwd: dir }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
    return r.stdout.split("\n").slice(4).join("\n").trimEnd();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const COMMANDS = ["build", "serve", "check", "init", "repo-files", "config"] as const;

/** Loaded once at startup. */
let prefs: LoadedPrefs;
type Command = (typeof COMMANDS)[number];

/** A first argument that isn't a command still builds when it looks like a path or git URL. */
const looksLikeSource = (x: string) => isGitUrl(x) || /[/\\.~]/.test(x) || existsSync(x);

type Flags = Record<string, string | boolean | undefined>;

/** `skills-pages check <url|path…>`: exit 1 when something would break (or warns, with --strict). */
async function checkCommand(targets: string[], values: Flags): Promise<void> {
  if (!targets.length) throw new Error("Usage: skills-pages check <url|path…>");
  const { checkTarget, printReport, tally } = await import("./check-cli.ts");
  let failed = false;
  for (const t of targets) {
    const r = await checkTarget(t);
    console.log(printReport(r, !!values.verbose).join("\n"));
    const n = tally(r);
    console.log(pc.dim(`  ${n.fail} problem${n.fail === 1 ? "" : "s"}, ${n.warn} warning${n.warn === 1 ? "" : "s"}, ${n.ok} passed\n`));
    if (n.fail || (values.strict && n.warn)) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

/** `skills-pages serve [dir]`: preview an already-built site with the same headers as build --serve. */
async function serveCommand(args: string[], values: Flags, env: Env): Promise<void> {
  const dir = path.resolve(args[0] ?? resolveOut(values.out as string | undefined, env).value);
  if (!existsSync(path.join(dir, "index.html"))) throw new Error(`No built site in ${dir} (run skills-pages build first, or pass the folder)`);
  const port = Number(values.port ?? env.SKILLS_PAGES_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port: ${values.port}`);
  p.intro(`${pc.bgMagenta(pc.black(" skills-pages "))} ${pc.dim("serve")}`);
  // The install commands on the pages point at the URL the site was built for.
  const m = /id="catalog-data">(.*?)<\/script>/s.exec(await readFile(path.join(dir, "index.html"), "utf8"));
  const builtFor = m ? (JSON.parse(m[1]!) as { siteUrl?: string }).siteUrl : undefined;
  const here = `http://localhost:${port}/`;
  if (builtFor && builtFor !== here)
    p.log.warn(`This site was built for ${builtFor}, so its install commands point there. To try them against this server, run ${pc.cyan("skills-pages serve")} (it builds first).`);
  await serve(dir, port).catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === "EADDRINUSE" ? `Port ${port} is in use; pass --port` : String(err));
  });
  p.outro(`Serving ${pc.cyan(dir)} at ${pc.underline(here)} ${pc.dim("(local only · Ctrl+C to stop)")}`);
  await new Promise(() => {});
}

/** `skills-pages repo-files [source]`: only the git marketplace files, no site. */
async function repoFilesCommand(args: string[], values: Flags, env: Env, interactive: boolean): Promise<void> {
  p.intro(`${pc.bgMagenta(pc.black(" skills-pages "))} ${pc.dim("repo-files")}`);
  const input = args[0] ?? env.SKILLS_PAGES_SOURCE ?? ".";
  if (isGitUrl(input)) throw new Error("repo-files writes into a local checkout; clone the repo and pass its path");
  const src = await resolveSource(input, { repoUrl: (values["repo-url"] as string | undefined) ?? nonEmpty(env.SKILLS_PAGES_REPO_URL) });
  const name = (values.name as string | undefined) ?? nonEmpty(env.SKILLS_PAGES_NAME);
  const cat = await discover(src, { name });
  if (!cat.skills.length) throw new Error("No skills found (expected skills/<name>/SKILL.md or plugins/<plugin>/skills/<name>/SKILL.md)");
  const bad = reservedMarketplaceName(cat.name);
  if (bad) throw new Error(`Marketplace name "${cat.name}" can't be used: ${bad}. Pass --name <name>.`);
  for (const w of cat.warnings) p.log.warn(w);
  const files = await writeRepo(cat, src, values.ref as string | undefined, interactive, !!name);
  // package.json: --package-json / SKILLS_PAGES_PACKAGE_JSON, or ask.
  let wantPkg = (values["package-json"] as boolean | undefined) ?? truthy(env.SKILLS_PAGES_PACKAGE_JSON);
  const repoPkg = await readPackageJson(src.dir);
  if (wantPkg === undefined && interactive) wantPkg = await ask(p.confirm({ message: "Also create a package.json so pi can install these skills as a package?", initialValue: !!repoPkg?.pi }));
  if (wantPkg) {
    const npmName = (values["npm-name"] as string | undefined) ?? nonEmpty(env.SKILLS_PAGES_NPM_NAME) ?? repoPkg?.name ?? (prefs.npmScope ? `@${prefs.npmScope.value}/${cat.name}` : cat.name);
    const isPublic = (values["npm-public"] as boolean | undefined) ?? truthy(env.SKILLS_PAGES_NPM_PUBLIC) ?? (repoPkg ? repoPkg.private !== true : false);
    if (await writePackageJson(cat, src, { name: npmName, public: isPublic }, interactive)) files.push("package.json");
  }
  p.outro(files.length ? `Commit and push: ${files.join(", ")}` : "Nothing to change.");
}

/** init: offer a CI workflow (GitHub Pages / GitLab Pages) in a chosen Docker image; optionally save the choices as defaults. */
async function initWorkflow(repoDir: string, out: string, interactive: boolean, values: Flags, gitlab?: boolean): Promise<string | undefined> {
  const ci = prefs.ci;
  let provider = values.ci as string | undefined;
  if (!provider && interactive)
    provider = await ask(
      p.select({
        message: "Add a CI workflow that builds and deploys the site?",
        initialValue: gitlab ? "gitlab" : ci.provider.from === "built-in" ? "github" : ci.provider.value,
        options: [
          { value: "github", label: "GitHub Actions → GitHub Pages", hint: ".github/workflows/skills-pages.yml" },
          { value: "gitlab", label: "GitLab CI → GitLab Pages", hint: ".gitlab-ci.yml" },
          { value: "none", label: "No" },
        ],
      }),
    );
  if (!provider || provider === "none") return provider;
  if (provider !== "github" && provider !== "gitlab") throw new Error(`--ci must be github, gitlab or none (got ${provider})`);
  const fromPref = (k: keyof typeof ci) => (ci[k].from === "built-in" ? "" : ` (from ${ci[k].from})`);
  let image = (values.image as string | undefined) ?? ci.image.value;
  let npmRegistry = (values["npm-registry"] as string | undefined) ?? ci.npmRegistry.value;
  let pkg = (values.package as string | undefined) ?? ci.package.value;
  if (interactive) {
    image = await ask(p.text({ message: `Docker image for the CI job${values.image ? "" : fromPref("image")}`, placeholder: image, defaultValue: image }));
    npmRegistry = await ask(
      p.text({ message: `npm registry to install skills-pages from (Enter for ${npmRegistry ? "this one" : "the default registry"})${fromPref("npmRegistry")}`, placeholder: npmRegistry || "https://registry.npmjs.org/", defaultValue: npmRegistry }),
    );
    pkg = await ask(p.text({ message: `Package to run${fromPref("package")}`, placeholder: pkg, defaultValue: pkg }));
  }
  const r = await writeWorkflow(provider, repoDir, { out, image, npmRegistry: npmRegistry || undefined, pkg });
  if (r.written) p.log.success(`Created ${pc.cyan(path.relative(process.cwd(), r.file) || r.file)} (image ${image}); commit it to deploy on every push.`);
  else p.log.warn(`${path.relative(process.cwd(), r.file) || r.file} already exists, so I didn't change it. Merge this in:\n${pc.dim(r.content)}`);

  // Remember the choices for every project (XDG user config), if they differ from what's already in effect.
  const changed = provider !== ci.provider.value || image !== ci.image.value || npmRegistry !== ci.npmRegistry.value || pkg !== ci.package.value;
  if (interactive && changed && (await ask(p.confirm({ message: `Save these as your defaults for every project (${userConfigFile()})?`, initialValue: true })))) {
    const file = await saveUserPrefs({ provider, image, npmRegistry: npmRegistry || undefined, package: pkg });
    p.log.success(`Saved to ${pc.cyan(file)}`);
  }
  return provider;
}

/** Write/merge the repo's package.json (pi package / npm). Shows a diff and asks before changing an existing file. */
async function writePackageJson(cat: Catalog, src: SourceInfo, o: PackageJsonOptions, interactive: boolean): Promise<boolean> {
  const file = path.join(src.dir, "package.json");
  const before = await readFile(file, "utf8").catch(() => undefined);
  const next = `${JSON.stringify(mergePackageJson(before ? (JSON.parse(before) as PackageJson) : undefined, cat, src, o), null, 2)}\n`;
  if (before === next) {
    p.log.info(pc.dim("package.json is up to date"));
    return false;
  }
  if (before !== undefined) {
    p.log.message(`${pc.bold("package.json")}\n${await diff(before, next)}`);
    if (interactive && !(await ask(p.confirm({ message: "Update package.json?" })))) return false;
  }
  await writeFile(file, next);
  p.log.success(`${before === undefined ? "Created" : "Updated"} package.json ${pc.dim(`(${o.name}${o.public ? "" : ", private"}; pi.skills: ${skillRoots(cat).join(", ")})`)}`);
  return true;
}

/** init without a terminal: only the CI workflow (--ci), with preferences and flags as the settings. */
async function ciOnly(provider: string, out: string, values: Flags): Promise<void> {
  p.intro(`${pc.bgMagenta(pc.black(" skills-pages "))} ${pc.dim("init --ci")}`);
  await initWorkflow(process.cwd(), out, false, { ...values, ci: provider });
  p.outro("Done.");
}

/** \`skills-pages config\`: the preferences in effect and where each comes from. */
async function configCommand(): Promise<void> {
  const row = (k: string, v: string, from: string) => `  ${k.padEnd(12)} ${v || pc.dim("(none)")}  ${pc.dim(`(${from})`)}`;
  console.log(pc.bold("CI defaults for init"));
  for (const [k, v] of Object.entries(prefs.ci)) console.log(row(k, String(v.value), v.from));
  const envs = Object.entries(prefs.env);
  if (envs.length) {
    console.log(pc.bold("\nVariable defaults"));
    for (const [k, v] of envs) console.log(row(k, v.value, `${v.from}${process.env[k] !== v.value ? `; overridden: ${process.env[k]}` : ""}`));
  }
  console.log(pc.bold("\nFiles") + pc.dim(" (most important first)"));
  console.log(`  user    ${userConfigFile()}${existsSync(userConfigFile()) ? "" : pc.dim("  (not created yet)")}`);
  for (const f of systemConfigFiles()) console.log(`  system  ${f}${existsSync(f) ? "" : pc.dim("  (absent)")}`);
}

/** Await a clack prompt; Ctrl+C / Esc cancels the whole run. */
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await prompt;
  if (p.isCancel(v)) cancel();
  return v as Exclude<T, symbol>;
}

function cancel(): never {
  p.cancel("Cancelled");
  process.exit(130);
}

main().catch((err: unknown) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.outro(pc.red("Failed"));
  process.exit(1);
});
