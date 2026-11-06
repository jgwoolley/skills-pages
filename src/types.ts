/** Normalised view of a git remote (credentials stripped). */
export interface RemoteInfo {
  host: string;
  /** Everything between the host and the repo name, e.g. `owner` or `group/subgroup`. */
  owner: string;
  repo: string;
  httpsUrl: string; // https://host/owner/repo.git
  sshUrl: string; // git@host:owner/repo.git
  webUrl: string; // https://host/owner/repo
  isGitLab: boolean;
  /** GitHub/GitLab Pages URL when it can be derived (github.com / gitlab.com), with trailing slash. */
  pagesUrl?: string;
}

export interface SourceInfo {
  /** Absolute path of the catalog checkout. */
  dir: string;
  /** True when the user gave a local path (so --write-repo is allowed). */
  local: boolean;
  remote?: RemoteInfo;
  /** Where `remote` came from, e.g. "git origin", "--repo-url", "GITHUB_REPOSITORY". */
  remoteFrom?: string;
  sha?: string;
  shaFrom?: string;
  /** Link to `sha` on the repo's real git origin (never the --repo-url override); unset if either is unknown. */
  commitUrl?: string;
  /** Committer date of `sha` (ISO 8601), when git knows it. */
  commitDate?: string;
  /** Subject line of the commit. */
  commitSubject?: string;
  /** Branch (or CI ref) the commit was built from. */
  branch?: string;
  /** The working tree had uncommitted changes at build time, so the site may differ from the commit. */
  dirty?: boolean;
  /** The source folder is a git work tree (it may still have no commits and no remote). */
  isGitRepo?: boolean;
  /**
   * `--installed`: the git repository the site is built in (and published from), e.g. the folder you run skills-pages in.
   * It gives the Pages URL and the build page's commit; it's not where the skills come from.
   */
  host?: Pick<SourceInfo, "dir" | "remote" | "sha" | "commitUrl" | "commitDate" | "commitSubject" | "branch" | "dirty">;
  ref?: string;
  cleanup: () => Promise<void>;
}

export interface Skill {
  /** Name from SKILL.md frontmatter. */
  name: string;
  description: string;
  /** From frontmatter `tags`/`keywords`/`metadata.tags`/`metadata.keywords` and the plugin's `keywords`. */
  tags: string[];
  /** Repo-relative POSIX path of the skill directory. */
  dir: string;
  /** Skill-relative POSIX paths of every file to publish. */
  files: string[];
  /** Name of the first plugin the skill belongs to (a skill can be in several; see Plugin.skills). */
  plugin: string;
  /** Marketplace entry name for installing this skill on its own. */
  entry: string;
  /** `entry` is an existing plugin that is exactly this skill, so no extra single-skill entry is generated. */
  entryIsPlugin?: boolean;
  /** The skill dir has its own .claude-plugin/plugin.json. */
  hasPluginJson: boolean;
}

export interface Plugin {
  name: string;
  description?: string;
  /** Repo-relative dir, `.` for the synthetic root plugin. */
  dir: string;
  skills: Skill[];
  hasPluginJson: boolean;
  /** Plugin rooted at the repo root (`./`). */
  root: boolean;
  /** The incoming marketplace entry this plugin was read from; published with every field preserved. */
  entry?: MarketplaceEntry;
  /** Incoming entry whose source is another repository: passed through, its skills aren't listed. */
  external?: boolean;
}

export interface Owner {
  name: string;
  email?: string;
  url?: string;
}

export interface Catalog {
  /** Marketplace name (kebab-case). */
  name: string;
  title: string;
  description?: string;
  owner: Owner;
  plugins: Plugin[];
  skills: Skill[];
  /** Root `.claude-plugin/plugin.json` exists. */
  rootPluginJson: boolean;
  /** Root has `skills/` or a package.json with a `pi` key, so `pi install` works. */
  piPackage: boolean;
  existing: { claude?: Marketplace; omp?: Marketplace };
  warnings: string[];
}

export type PluginSource =
  | string
  | { source: "url"; url: string; ref?: string }
  | { source: "git-subdir"; url: string; path: string; ref?: string }
  | { source: "archive"; url: string; sha256: string };

export interface MarketplaceEntry {
  name: string;
  source: PluginSource;
  description?: string;
  strict?: boolean;
  skills?: string[];
  [key: string]: unknown;
}

export interface Marketplace {
  $schema?: string;
  name: string;
  owner: Owner;
  metadata?: { description?: string; version?: string; [key: string]: unknown };
  plugins: MarketplaceEntry[];
  [key: string]: unknown;
}
