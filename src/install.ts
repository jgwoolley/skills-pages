// Pure install-guide logic shared by the CLI and the browser (no Node imports here).
//
// Model: pick an agent → it offers install methods → each method is one path (never alternatives inside),
// split into setup / install / update phases.

export type Protocol = "https" | "ssh";
export type Scope = "global" | "project";

export interface AgentDef {
  id: string;
  label: string;
  /** Agent id for the Vercel skills CLI (`--agent`). */
  skillsCli: string;
  /** Where the skills CLI installs for this agent (from its agents table), with trailing slash. */
  dirs: { project: string; global: string };
  /** Supported natively by this catalog (marketplaces, index, packages); otherwise via the skills CLI only. */
  native: boolean;
  /** Listed so people can find it, but has no install method of its own (see `methods`). */
  unsupported?: boolean;
}

export const AGENTS: AgentDef[] = [
  { id: "claude", label: "Claude Code", skillsCli: "claude-code", dirs: { project: ".claude/skills/", global: "~/.claude/skills/" }, native: true },
  { id: "opencode", label: "OpenCode", skillsCli: "opencode", dirs: { project: ".agents/skills/", global: "~/.config/opencode/skills/" }, native: true },
  { id: "pi", label: "pi", skillsCli: "pi", dirs: { project: ".agents/skills/", global: "~/.agents/skills/" }, native: true },
  { id: "omp", label: "oh-my-pi", skillsCli: "pi", dirs: { project: ".agents/skills/", global: "~/.agents/skills/" }, native: true }, // omp reads the .agents/skills dirs pi uses
  { id: "codex", label: "Codex", skillsCli: "codex", dirs: { project: ".agents/skills/", global: "~/.agents/skills/" }, native: false },
  { id: "cursor", label: "Cursor", skillsCli: "cursor", dirs: { project: ".agents/skills/", global: "~/.cursor/skills/" }, native: false },
  { id: "github-copilot", label: "GitHub Copilot", skillsCli: "github-copilot", dirs: { project: ".agents/skills/", global: "~/.copilot/skills/" }, native: false },
  { id: "gemini-cli", label: "Gemini CLI", skillsCli: "gemini-cli", dirs: { project: ".agents/skills/", global: "~/.gemini/skills/" }, native: false },
  { id: "cline", label: "Cline", skillsCli: "cline", dirs: { project: ".agents/skills/", global: "~/.agents/skills/" }, native: false },
  { id: "roo", label: "Roo Code", skillsCli: "roo", dirs: { project: ".roo/skills/", global: "~/.roo/skills/" }, native: false },
  { id: "goose", label: "Goose", skillsCli: "goose", dirs: { project: ".goose/skills/", global: "~/.config/goose/skills/" }, native: false },
  { id: "amp", label: "Amp", skillsCli: "amp", dirs: { project: ".agents/skills/", global: "~/.config/agents/skills/" }, native: false },
  { id: "t3code", label: "T3 Code", skillsCli: "", dirs: { project: "", global: "" }, native: false, unsupported: true },
];

export type MethodId = "git-marketplace" | "site-marketplace" | "remote-index" | "pi-package" | "pi-npm" | "skills-cli";

/** Serialisable catalog summary embedded in the page. */
export interface InstallData {
  name: string;
  title: string;
  /** Where ./public is served from, with trailing slash. */
  siteUrl: string;
  /** `blob`: web URL prefix for a file in the repo, e.g. https://github.com/o/r/blob/HEAD/ */
  repo: { https: string; ssh: string; web: string; blob: string } | null;
  /** Marketplace files committed in the repo (enables `marketplace add <git url>`). */
  git: { claude: boolean; omp: boolean; claudeSkills: string[]; ompSkills: string[]; claudeEntries: string[]; ompEntries: string[]; claudeName?: string; ompName?: string; ompFile?: string };
  /** The repo's package.json, when it makes the catalog a pi/npm package. `public`: not marked private. */
  npm?: { name: string; public: boolean };
  /** The catalog checkout as git sees it, to explain why the Git marketplace can't be used yet. */
  checkout?: { isGitRepo: boolean; hasCommits: boolean; claudeFile: boolean; ompFile: boolean };
  /** Single-skill entries in the published JSON marketplaces. */
  json: { claudeSkills: string[]; ompSkills: string[] };
  /** The site is HTTPS and not a loopback host, so Claude Code accepts its zip archives (otherwise: a preview). */
  siteArchives: boolean;
  /** False when the CLI couldn't work out where the site is served and fell back to a placeholder URL. */
  siteUrlKnown?: boolean;
  /** The skills are installed on the machine that built the site (`--installed`), not in a repository. */
  installed?: boolean;
  /** Who built the site: CI is assumed to deploy it; a local build may not be deployed yet. */
  deploy?: { builtBy: "ci" | "local"; noCommits?: boolean };
  piPackage: boolean;
  /**
   * Skills in both a root skills/ folder and plugins/<plugin>/skills/. Cloning such a repo, the skills CLI stops at the
   * root skills/ unless .claude-plugin/marketplace.json lists the plugins (checked against skills v1.7). A plugins-only
   * or skills-only repo is fine.
   */
  mixedLayout: boolean;
  /** `external`: lives in another repo (only installable through a marketplace). */
  plugins: { name: string; description?: string; skills: string[]; external?: boolean }[];
  skills: { name: string; entry: string; plugin: string; description: string; tags: string[]; dir: string; files: string[]; url?: string; size: SkillSize; fileInfo?: FileInfo[] }[];
}

/** Context-window estimate for one skill (tokens ≈ characters / 4). */
export interface SkillSize {
  /** Name + description: what agents keep in context from the start. */
  always: number;
  /** SKILL.md body (no frontmatter): loaded when the skill is used. */
  invoke: number;
  /** Every file in the skill, in bytes (other files are only read when the agent needs them). */
  bytes: number;
}

/** Per-file size (only in a skill page's payload). `tokens` is null for binary files. */
export interface FileInfo {
  path: string;
  bytes: number;
  tokens: number | null;
}

/** Rough token estimate: ~4 characters per token for English text and code. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function totalSize(sizes: SkillSize[]): SkillSize {
  return sizes.reduce((a, b) => ({ always: a.always + b.always, invoke: a.invoke + b.invoke, bytes: a.bytes + b.bytes }), { always: 0, invoke: 0, bytes: 0 });
}

export const formatTokens = (n: number) => (n < 1000 ? `~${n}` : `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export interface Step {
  /** Text; `backticked` parts are copyable values (file paths, commands). */
  title: string;
  code: string;
  /** Shell commands vs. a JSON file to merge. */
  lang: "sh" | "json";
  file?: string;
}

export type PhaseKind = "setup" | "install" | "update";

export interface Phase {
  kind: PhaseKind;
  steps: Step[];
  /** Text; `backticked` parts are copyable values, `[label](href)` is a link (href relative to the site). */
  notes?: string[];
}

export interface Method {
  id: MethodId;
  label: string;
  phases: Phase[];
  /** Text, same markup as Phase.notes. */
  notes: string[];
  /**
   * Set when the method can't work as the site was built (e.g. unknown site URL, no repo). It's still listed, with
   * this warning instead of instructions. Text uses the same markup as notes.
   */
  blocked?: {
    reason: string;
    /** What to do: a fix ("fix"), or another method to use because this one can't do the job here ("instead"). */
    fix: string;
    kind?: "fix" | "instead";
  };
}

export interface GuideOptions {
  protocol: Protocol;
  scope: Scope;
  /** Skill name; omit for the whole catalog. */
  skill?: string;
  /** Plugin name: install just this plugin (ignored when `skill` is set). */
  plugin?: string;
}

export const PHASE_TITLES: Record<PhaseKind, string> = { setup: "Setup", install: "Install", update: "Update" };

const NPX = "DISABLE_TELEMETRY=1 npx skills";

function repoUrl(d: InstallData, p: Protocol): string | undefined {
  return d.repo ? (p === "ssh" ? d.repo.ssh : d.repo.https) : undefined;
}

/** A method that can't work as built: listed with the reason and the fix instead of commands. */
const blocked = (id: MethodId, label: string, reason: string, fix: string, kind: "fix" | "instead" = "fix"): Method => ({
  id,
  label,
  phases: [],
  notes: [],
  blocked: { reason, fix, kind },
});
const COLLECTED = "These skills were collected from the machine that built this site";

const SITE_URL_FIX =
  "Rebuild with `--base-url <url>` (or set `SKILLS_PAGES_BASE_URL`), build in GitHub Actions / GitLab CI, or give the repo a GitHub/GitLab `origin` so the Pages URL can be derived.";
const siteUnknown = (d: InstallData, id: MethodId, label: string) =>
  d.siteUrlKnown === false
    ? blocked(id, label, `The site URL wasn't known when this site was built (it fell back to \`${d.siteUrl}\`), so these commands would point at the wrong place.`, SITE_URL_FIX)
    : undefined;
/**
 * Site-based commands work once the site is deployed. A local build of a public URL may not be (yet): say so, but still
 * show the commands, since everything needed to build them is known.
 */
const deployNotes = (d: InstallData): string[] => {
  if (d.deploy?.builtBy !== "local" || d.siteUrlKnown === false || /^https?:\/\/(localhost|127\.|\[::1\])/.test(d.siteUrl)) return [];
  return [
    d.deploy.noCommits
      ? `Heads-up: the repository has no commits yet. Commit and push, then deploy this site to \`${d.siteUrl}\`; these commands work from then on.`
      : `Heads-up: this site was built on a local machine, not by CI. These commands work once it's deployed to \`${d.siteUrl}\`.`,
  ];
};

const REPO_FIX = "Set the repo's `origin` remote (or pass `--repo-url`) and rebuild.";
const MARKETPLACE_FIX = "Run `skills-pages repo-files` (or build with `--write-repo`), commit and push the marketplace files, then rebuild.";

// ---- Shared wording, so every method reads the same way ----
// First phase: a "Source:" note (where it comes from, how it's fetched). Step titles: action + folder chip.
// Install phase: one "Global:"/"Project:" note (what's recorded where, what to commit). Update: "Update …" or "Automatic: …".

const proto = (p: Protocol) => (p === "ssh" ? "SSH" : "HTTPS");
const repoLink = (d: InstallData) => (d.repo ? `[${d.repo.web.replace(/^https:\/\//, "")}](${d.repo.web})` : "the repository");
const scopeNote = (o: GuideOptions, global: string, project: string) => (o.scope === "global" ? `Global: ${global}` : `Project: ${project}`);

/**
 * Claude Code / oh-my-pi marketplace method. Everything it points at can be fetched from elsewhere (the catalog is assumed
 * to be read on another machine): never a path on the machine that built the site.
 * - `git`: the repo's own marketplace;
 * - `site`: this site's catalog (Claude Code: zip archives of the skills; oh-my-pi: git sources).
 */
function marketplaceMethod(d: InstallData, cli: "claude" | "omp", via: "git" | "site", o: GuideOptions): Method | undefined {
  // Claude's site catalog is built from the skill copies; plugins without skills aren't in it.
  const copies = via === "site" && cli === "claude";
  const id: MethodId = `${via}-marketplace`;
  const label = via === "git" ? "Git marketplace" : "Site marketplace";
  // Installed skills never live in a repository: say what the method needs and which tab to use instead.
  if (d.installed && via === "git")
    return blocked(
      id,
      label,
      `A Git marketplace is a repository that ${cli === "claude" ? "Claude Code" : "oh-my-pi"} clones (\`${cli} plugin marketplace add <repo>\`). ${COLLECTED}, not from a repository.`,
      cli === "claude" ? "the Site marketplace tab. It installs the same plugins from this site." : "the skills CLI tab. It installs the same skills for oh-my-pi (via the `pi` agent) from this site.",
      "instead",
    );
  if (d.installed && via === "site" && cli === "omp")
    return blocked(
      id,
      label,
      `oh-my-pi installs plugins from git repositories only, not from the zip files this site provides. ${COLLECTED}, so there's no repository for it to clone.`,
      "the skills CLI tab. It installs the same skills for oh-my-pi (via the `pi` agent) from this site.",
      "instead",
    );
  if (via === "git" && !d.repo) {
    const co = d.checkout;
    // oh-my-pi reads .omp-plugin/ and falls back to .claude-plugin/: name the file that's there.
    const file = cli === "claude" || (!co?.ompFile && co?.claudeFile) ? ".claude-plugin/marketplace.json" : ".omp-plugin/marketplace.json";
    const hasFile = cli === "claude" ? co?.claudeFile : co?.ompFile || co?.claudeFile;
    if (co?.isGitRepo)
      return blocked(
        id,
        label,
        `${cli === "claude" ? "Claude Code" : "oh-my-pi"} adds a Git marketplace by cloning the repository's URL, and this repository has no \`origin\` remote, so there's no URL to give it. ${hasFile ? `Its marketplace file (\`${file}\`) is ready.` : `It also needs \`${file}\` (\`skills-pages repo-files\` writes it).`}`,
        `${hasFile ? "" : "run `skills-pages repo-files`, then "}${co.hasCommits ? "" : "commit, "}add the remote and push (\`git remote add origin <url>\`, \`git push -u origin HEAD\`), then rebuild. Or pass \`--repo-url <url>\` if the repository is already published.`.replace(/^./, (c) => c.toUpperCase()),
      );
    return blocked(id, label, "This catalog wasn't built from a git repository, so there's no repository to add as a marketplace.", REPO_FIX);
  }
  if (via === "site") {
    const unknown = siteUnknown(d, id, label);
    if (unknown) return unknown;
    if (cli === "omp" && !d.repo)
      return blocked(id, label, "oh-my-pi can't install from zip archives, so its site catalog needs git sources, and this catalog was built without a repository.", REPO_FIX);
  }
  const entry = o.skill ? d.skills.find((s) => s.name === o.skill)?.entry : undefined;
  const plugin = !entry && o.plugin ? o.plugin : undefined;
  const inCopies = (p: InstallData["plugins"][number]) => !!p.external || p.skills.length > 0;
  if (copies && plugin && !d.plugins.some((p) => p.name === plugin && inCopies(p)))
    return blocked(id, label, `${plugin} has no skills, and this site's catalog only packages skills.`, "the Git marketplace tab. It installs the plugin from the repository as it is.", "instead");
  let src: string;
  let mkt = d.name;
  let jsonFile = "";
  if (via === "git") {
    if (!(cli === "claude" ? d.git.claude : d.git.omp)) return blocked(id, label, "The repository has no `.claude-plugin/marketplace.json` (or `.omp-plugin/`).", MARKETPLACE_FIX);
    // Only when the repo's own marketplace has every entry we're about to install.
    const entries = cli === "claude" ? d.git.claudeEntries : d.git.ompEntries;
    const singles = cli === "claude" ? d.git.claudeSkills : d.git.ompSkills;
    const missing = entry ? (!singles.includes(entry) ? entry : undefined) : plugin ? (!entries.includes(plugin) ? plugin : undefined) : d.plugins.find((p) => !entries.includes(p.name))?.name;
    if (missing) return blocked(id, label, `The repository's marketplace has no entry for ${missing} (or it differs from this catalog).`, MARKETPLACE_FIX);
    src = repoUrl(d, o.protocol)!;
    mkt = (cli === "claude" ? d.git.claudeName : d.git.ompName) ?? d.name;
  } else {
    if (entry && !(cli === "claude" ? d.json.claudeSkills : d.json.ompSkills).includes(entry))
      return cli === "omp"
        ? blocked(
            id,
            label,
            `oh-my-pi can install a single skill only from a marketplace inside the repository, not from a catalog downloaded from this site.`,
            "the Git marketplace tab (after running `skills-pages repo-files` and pushing), or the skills CLI tab.",
            "instead",
          )
        : blocked(id, label, `This site's catalog has no single-skill entry for ${o.skill}.`, "Rebuild the site.");
    jsonFile = cli === "claude" ? "claude/marketplace.json" : `omp/marketplace${o.protocol === "ssh" ? ".ssh" : ""}.json`;
    src = `${d.siteUrl}${jsonFile}`;
  }
  const names = entry ? [entry] : plugin ? [plugin] : d.plugins.filter((p) => !copies || inCopies(p)).map((p) => p.name);
  const scope = `--scope ${o.scope === "global" ? "user" : "project"}`;
  const install = names.map((n) => (cli === "claude" ? `claude plugin install ${n}@${mkt} ${scope}` : `omp plugin install ${scope} ${n}@${mkt}`));
  const update = [
    `${cli} plugin marketplace update ${mkt}`,
    ...names.map((n) => (cli === "claude" ? `claude plugin update ${n}@${mkt}` : `omp plugin upgrade ${scope} ${n}@${mkt}`)),
  ];
  const what = entry ? o.skill! : plugin ? plugin : names.length > 1 ? "the plugins" : "the plugin";
  // Verified on disk: Claude Code caches plugins per marketplace whatever the scope (project scope only enables them);
  // oh-my-pi caches them as <marketplace>___<plugin>___<version> (default profile, non-XDG).
  const one = entry ?? plugin;
  const dest = cli === "claude" ? `~/.claude/plugins/cache/${mkt}/${one ? `${one}/` : ""}` : "~/.omp/plugins/cache/plugins/";
  // Git and URL marketplaces land in the same folder: a clone, or the downloaded catalog JSON.
  const saved = cli === "claude" ? `~/.claude/plugins/marketplaces/${mkt}/` : `~/.omp/plugins/cache/marketplaces/${mkt}/`;
  const repoFile = cli === "claude" ? ".claude-plugin/marketplace.json" : (d.git.ompFile ?? ".claude-plugin/marketplace.json");
  const source =
    via === "git"
      ? `Source: [${repoFile}](${d.repo!.blob}${repoFile}) in ${repoLink(d)}, cloned over ${proto(o.protocol)}.`
      : cli === "claude"
        ? `Source: [${jsonFile}](${jsonFile}) on this site; plugins are zip archives of the skills, also from this site (the HTTPS/SSH choice doesn't apply).`
        : `Source: [${jsonFile}](${jsonFile}) on this site; plugins are cloned from ${repoLink(d)} over ${proto(o.protocol)}.`;
  // Claude Code only installs archives from HTTPS sites that aren't loopback hosts (e.g. not an http://localhost preview).
  const previewNote = copies && !d.siteArchives ? ["This site isn't served over public HTTPS, so Claude Code won't download its archives yet: these commands work once it's deployed over HTTPS."] : [];
  return {
    id,
    label,
    phases: [
      {
        kind: "setup",
        steps: [{ title: `Add the marketplace into \`${saved}\``, code: `${cli} plugin marketplace add ${src}`, lang: "sh" }],
        notes: [
          source,
          ...previewNote,
          ...(via === "site" ? deployNotes(d) : []),
          ...(via === "git" && d.checkout && !d.checkout.hasCommits
            ? [`Heads-up: the repository has no commits yet. Commit and push \`${repoFile}\` first; this command clones what's on the remote.`]
            : []),
        ],
      },
      {
        kind: "install",
        steps: [{ title: `Install ${what} into \`${dest}\``, code: install.join("\n"), lang: "sh" }],
        notes: [
          scopeNote(
            o,
            "available in every project.",
            cli === "claude" ? "enabled in `.claude/settings.json`; commit it to share." : "recorded in `.omp/plugins/installed_plugins.json`; commit it to share.",
          ),
        ],
      },
      { kind: "update", steps: [{ title: `Refresh the marketplace and update ${what}`, code: update.join("\n"), lang: "sh" }] },
    ],
    notes: [],
  };
}

const noSkillsReason = (d: InstallData, plugin: string) =>
  d.plugins.find((p) => p.name === plugin)?.external
    ? `${plugin} lives in another repository, so its skills aren't part of this catalog.`
    : `${plugin} has no skills (it may provide commands, agents or hooks), and this method only installs skills.`;

/** "the 4 skills in document-skills": what a per-skill method really installs on a plugin page. */
const pluginSkills = (plugin: string, n: number) => `the ${n === 1 ? "skill" : `${n} skills`} in ${plugin}`;

/**
 * Plugins are an install unit only for marketplaces. Per-skill methods install the plugin's current skills one by one,
 * so later changes to the plugin's membership aren't followed.
 */
const snapshotNote = (o: GuideOptions) =>
  o.plugin && !o.skill
    ? [`Installs the current skills of ${o.plugin} individually; skills added to the plugin later aren't picked up, so reinstall from this page. A marketplace method installs the plugin as a whole.`]
    : [];

/** The skills a scope covers: one skill, a plugin's members, or undefined for the whole catalog. */
function scopedSkills(d: InstallData, o: GuideOptions): string[] | undefined {
  if (o.skill) return [o.skill];
  if (o.plugin) return d.plugins.find((p) => p.name === o.plugin)?.skills ?? [];
  return undefined;
}

function remoteIndexMethod(d: InstallData, o: GuideOptions): Method {
  const file = o.scope === "global" ? "~/.config/opencode/opencode.json" : "opencode.json";
  const only = scopedSkills(d, o);
  const unknown = siteUnknown(d, "remote-index", "Remote index");
  if (unknown) return unknown;
  if (only && !only.length) return blocked("remote-index", "Remote index", noSkillsReason(d, o.plugin!), "a Claude Code or oh-my-pi marketplace tab.", "instead");
  // A plugin is its skills' one-skill indexes; a single skill is one; the catalog is the root index.
  const bases = only && (o.skill || only.length) ? only.map((n) => `opencode/${n}/`) : [""];
  const config = { $schema: "https://opencode.ai/config.json", skills: { urls: bases.map((b) => `${d.siteUrl}${b}`) } };
  const what = o.skill ?? (o.plugin ? pluginSkills(o.plugin, only!.length) : "every skill");
  const base = bases.length === 1 ? bases[0]! : "";
  return {
    id: "remote-index",
    label: "Remote index",
    phases: [
      {
        kind: "install",
        steps: [{ title: `Install ${what} into \`~/.cache/opencode/skills/${o.skill ? `${o.skill}/` : ""}\``, code: JSON.stringify(config, null, 2), lang: "json", file }],
        notes: [
          bases.length === 1
            ? `Source: [${base}index.json](${base}index.json) on this site, downloaded over HTTPS (the HTTPS/SSH choice doesn't apply).`
            : `Source: one index per skill on this site (e.g. [${bases[0]}index.json](${bases[0]}index.json)), downloaded over HTTPS (the HTTPS/SSH choice doesn't apply).`,
          ...deployNotes(d),
          `Add this to \`${file}\`, merging \`skills.urls\` into your existing config.`,
          scopeNote(o, "applies to every project.", "applies to this project; commit `opencode.json` to share."),
          ...snapshotNote(o),
        ],
      },
      { kind: "update", steps: [], notes: [`Automatic: each skill has a \`version\` in the index, and OpenCode downloads changed skills on start.`] },
    ],
    notes: [],
  };
}

function piPackageMethod(d: InstallData, o: GuideOptions): Method | undefined {
  const no = (reason: string, fix: string, kind: "fix" | "instead" = "fix") => blocked("pi-package", "pi package", reason, fix, kind);
  // pi installs whole repositories: say so, and point at the skills CLI, which installs single skills for pi.
  if (o.skill || o.plugin)
    return no(
      `A pi package installs a whole repository at a time, so it can't install just ${o.skill ?? `the skills in ${o.plugin}`}.`,
      `the skills CLI tab. It installs only ${o.skill ? "this skill" : "these skills"} for pi.`,
      "instead",
    );
  if (d.installed)
    return no(
      `A pi package is a git repository that pi clones and keeps up to date (\`pi install git:…\`). ${COLLECTED}, so there's no repository for pi to clone.`,
      "the skills CLI tab. It installs the same skills for pi from this site.",
      "instead",
    );
  if (!d.repo) return no("A pi package is installed from a git repository, and this catalog was built without one.", REPO_FIX);
  if (!d.piPackage)
    return no(
      "pi looks for skills in a root `skills/` folder or a `pi` key in `package.json`, and this repository has neither.",
      "add `\"pi\": { \"skills\": [\"./plugins/<plugin>/skills\"] }` to the repo's `package.json`, or use the skills CLI tab.",
    );
  const src = o.protocol === "ssh" ? `git:${d.repo.ssh.replace(/\.git$/, "")}` : d.repo.https.replace(/\.git$/, "");
  // pi clones git packages to <agentDir>/git/<host>/<path> (global) or .pi/git/<host>/<path> (project).
  const repoPath = d.repo.web.replace(/^https:\/\//, "");
  const dest = o.scope === "global" ? `~/.pi/agent/git/${repoPath}/` : `.pi/git/${repoPath}/`;
  return {
    id: "pi-package",
    label: "pi package",
    phases: [
      {
        kind: "install",
        steps: [{ title: `Install the package into \`${dest}\``, code: `pi install ${src}${o.scope === "project" ? " -l" : ""}`, lang: "sh" }],
        notes: [
          `Source: ${repoLink(d)}, cloned over ${proto(o.protocol)}.`,
          scopeNote(o, "recorded in `~/.pi/agent/settings.json`; available in every project.", "recorded in `.pi/settings.json`; commit it to share."),
        ],
      },
      { kind: "update", steps: [{ title: "Update the package", code: "pi update", lang: "sh" }] },
    ],
    notes: [],
  };
}

/** pi from npm: the repo's package.json, once it's published. */
function piNpmMethod(d: InstallData, o: GuideOptions): Method | undefined {
  if (!d.npm) return undefined;
  const id: MethodId = "pi-npm";
  const label = "npm package";
  if (o.skill || o.plugin)
    return blocked(id, label, `pi installs a whole package at a time, so it can't install just ${o.skill ?? `the skills in ${o.plugin}`}.`, `the skills CLI tab. It installs only ${o.skill ? "this skill" : "these skills"} for pi.`, "instead");
  if (!d.npm.public)
    return blocked(
      id,
      label,
      `This repository's package.json (\`${d.npm.name}\`) is marked \`private\`, so it isn't on npm for pi to install.`,
      "set `\"private\": false` (or rerun skills-pages and choose to publish), then `npm publish --access public`.",
    );
  const dest = o.scope === "global" ? "~/.pi/agent/npm/" : ".pi/npm/";
  return {
    id,
    label,
    phases: [
      {
        kind: "install",
        steps: [{ title: `Install the package into \`${dest}\``, code: `pi install npm:${d.npm.name}${o.scope === "project" ? " -l" : ""}`, lang: "sh" }],
        notes: [
          `Source: [${d.npm.name}](https://www.npmjs.com/package/${d.npm.name}) on npm (the HTTPS/SSH choice doesn't apply; npm uses your configured registry).`,
          scopeNote(o, "recorded in `~/.pi/agent/settings.json`; available in every project.", "recorded in `.pi/settings.json`; commit it to share."),
        ],
      },
      { kind: "update", steps: [{ title: "Update the package", code: "pi update", lang: "sh" }] },
    ],
    notes: [],
  };
}

function skillsCliMethod(d: InstallData, a: AgentDef, o: GuideOptions): Method {
  // Source: the repo when the skills CLI can find every skill in it; otherwise this site, whose
  // .well-known/agent-skills/index.json lists every skill (it only finds plugins/*/skills/* through the repo's marketplace).
  const viaSite = !d.repo || (d.mixedLayout && !d.git.claude);
  const url = viaSite ? d.siteUrl : repoUrl(d, o.protocol)!;
  const g = o.scope === "global" ? "-g" : "-p";
  const only = scopedSkills(d, o);
  if (only && !only.length) return blocked("skills-cli", "skills CLI", noSkillsReason(d, o.plugin!), "a Claude Code or oh-my-pi marketplace tab.", "instead");
  if (viaSite) {
    const unknown = siteUnknown(d, "skills-cli", "skills CLI");
    if (unknown) return unknown;
  }
  const dest = `${o.scope === "global" ? a.dirs.global : a.dirs.project}${o.skill ? `${o.skill}/` : ""}`;
  const what = o.skill ?? (o.plugin ? pluginSkills(o.plugin, only!.length) : "every skill");
  const names = only ? only.join(" ") : "'*'";
  return {
    id: "skills-cli",
    label: "skills CLI",
    phases: [
      {
        kind: "install",
        steps: [{ title: `Install ${what} into \`${dest}\``, code: `${NPX} add ${url} --skill ${names} --agent ${a.skillsCli}${o.scope === "global" ? " -g" : ""} -y`, lang: "sh" }],
        notes: [
          viaSite
            ? "Source: [.well-known/agent-skills/index.json](.well-known/agent-skills/index.json) on this site, a zip per skill with a sha256 digest (the HTTPS/SSH choice doesn't apply)."
            : `Source: ${repoLink(d)}, cloned over ${proto(o.protocol)}.`,
          ...(viaSite ? deployNotes(d) : []),
          scopeNote(o, "available in every project.", "recorded in `skills-lock.json`; commit it and the skills folder to share."),
          ...snapshotNote(o),
          ...(a.id === "omp" ? ["oh-my-pi reads `~/.agents/skills` and `.agents/skills`, where the `pi` agent installs."] : []),
        ],
      },
      { kind: "update", steps: [{ title: `Update ${what}`, code: `${NPX} update${only ? ` ${only.join(" ")}` : ""} ${g} -y`, lang: "sh" }] },
    ],
    notes: ["Uses the [Vercel skills CLI](https://github.com/vercel-labs/skills), downloaded from npm via npx; `DISABLE_TELEMETRY=1` turns its usage reporting off."],
  };
}

/**
 * Install methods for an agent, most native first. Each is a single path with setup / install / update phases.
 * A method that can't be used is still listed, with `blocked` instead of commands: either a fix (unknown site URL, no
 * repo, missing marketplace file) or, when the method can't do the job here, which tab to use instead.
 */
export function methods(d: InstallData, agentId: string, o: GuideOptions): Method[] {
  const a = AGENTS.find((x) => x.id === agentId) ?? AGENTS[0]!;
  if (a.unsupported)
    return [
      blocked(
        "skills-cli",
        "Not supported",
        `${a.label} has no skills install of its own. It runs other agents (Claude Code, Codex and others) and they load the skills.`,
        "the Claude Code or Codex tab, run on the machine that runs the T3 Code server, then start a new thread.",
        "instead",
      ),
    ];
  const out: (Method | undefined)[] = [];
  if (a.id === "claude" || a.id === "omp") out.push(marketplaceMethod(d, a.id, "git", o), marketplaceMethod(d, a.id, "site", o));
  if (a.id === "opencode") out.push(remoteIndexMethod(d, o));
  if (a.id === "pi") out.push(piPackageMethod(d, o), piNpmMethod(d, o));
  out.push(skillsCliMethod(d, a, o));
  return out.filter((m): m is Method => !!m);
}

/**
 * The first method that works. If none does, prefer the site's own method, whose fix (the site URL) is usually the
 * actionable one, over repo-based ones.
 */
export function defaultMethod(list: Method[]): Method | undefined {
  return list.find((m) => !m.blocked) ?? list.find((m) => m.id === "site-marketplace" || m.id === "remote-index") ?? list[0];
}
