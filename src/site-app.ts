// Browser entry for the generated site. Everything runs locally; settings live in localStorage.
import { AGENTS, defaultMethod, formatBytes, formatTokens, methods, PHASE_TITLES, totalSize, type InstallData, type Method, type MethodId, type Protocol, type Scope } from "./install.ts";

interface Settings {
  agent: string;
  /** Preferred install method; falls back to the agent's first available one. */
  method: MethodId | "";
  protocol: Protocol;
  scope: Scope;
}

interface PageInfo {
  kind: "catalog" | "skill" | "plugins" | "plugin";
  skill?: string;
  plugin?: string;
  /** Relative path back to the site root ("" or "../../"). */
  root: string;
}

const KEY = "skills-pages:settings";
const LEGACY_KEY = "skills-catalog:settings"; // before the rename
const data = JSON.parse(document.getElementById("catalog-data")!.textContent!) as InstallData & { page: PageInfo };
const page = data.page;

/** Site-relative href → page-relative (skill pages live two levels down). */
const siteHref = (href: string) => (/^([a-z]+:|\/|#)/i.test(href) ? href : `${page.root}${href}`);

function load(): Settings {
  const def: Settings = { agent: "claude", method: "", protocol: "https", scope: "global" };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? "{}") as Partial<Settings>;
    return {
      agent: AGENTS.some((a) => a.id === s.agent) ? s.agent! : def.agent,
      method: typeof s.method === "string" ? (s.method as MethodId) : "",
      protocol: s.protocol === "ssh" ? "ssh" : "https",
      scope: s.scope === "project" ? "project" : "global",
    };
  } catch {
    return def;
  }
}

const settings = load();

/** Every link opens in a new tab, without leaking the opener or referrer. */
function link(href: string, text: string): HTMLAnchorElement {
  return el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** Copy to the clipboard, with a fallback for non-secure origins (plain http on a LAN host). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { value: text, readOnly: true, class: "sr" });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// Toast: a manual popover, so it sits in the top layer (above everything else on the page).
const toastEl = el("div", { class: "toast", role: "status" });
toastEl.setAttribute("popover", "manual");
toastEl.setAttribute("aria-live", "polite");
document.body.append(toastEl);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(message: string, detail?: string, ok = true) {
  toastEl.replaceChildren(
    el("span", { class: "toast-icon", textContent: ok ? "✓" : "!" }),
    el("span", {}, message, ...(detail ? [" ", el("code", { textContent: detail })] : [])),
  );
  toastEl.classList.toggle("error", !ok);
  if (toastEl.matches(":popover-open")) toastEl.hidePopover(); // restart the entry animation
  toastEl.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.hidePopover(), 2200);
}

const short = (t: string) => {
  const line = t.split("\n")[0]!;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line + (t.includes("\n") ? " …" : "");
};

async function copy(text: string, label: string, btn?: HTMLButtonElement) {
  const ok = await writeClipboard(text);
  toast(ok ? `Copied ${label}` : "Couldn't copy; select it manually", ok ? short(text) : undefined, ok);
  if (!btn || !ok) return;
  btn.classList.add("done");
  if (btn.classList.contains("copy")) btn.textContent = "Copied";
  setTimeout(() => {
    btn.classList.remove("done");
    if (btn.classList.contains("copy")) btn.textContent = "Copy";
  }, 1500);
}

function kind(v: string): string {
  if (/^https?:\/\//.test(v)) return "URL";
  if (/\s/.test(v)) return "command";
  if (/^[~./]/.test(v) || v.includes("/") || /\.json$/.test(v)) return "path";
  return "value";
}

function chip(value: string): HTMLButtonElement {
  const label = kind(value);
  const b = el("button", { type: "button", class: "chip", title: `Copy ${label}` }, el("code", { textContent: value }));
  b.setAttribute("aria-label", `Copy ${label} ${value}`);
  b.addEventListener("click", () => copy(value, label, b));
  return b;
}

/** Render guide text: `backticked` parts become click-to-copy chips, `[label](href)` becomes a link. */
function rich(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); last = re.lastIndex) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(chip(m[1]));
    else {
      const href = m[3]!;
      const external = /^[a-z]+:/i.test(href);
      // Only http(s) or relative links; anything else is shown as text.
      if (external && !/^https?:/i.test(href)) out.push(m[2]!);
      else out.push(link(siteHref(href), m[2]!));
    }
  }
  out.push(text.slice(last));
  return out;
}

function renderSteps(steps: Method["phases"][number]["steps"]) {
  return steps.map((st, i) => {
    const btn = el("button", { type: "button", class: "copy", textContent: "Copy" });
    btn.addEventListener("click", () => copy(st.code, st.lang === "json" ? "config" : st.code.includes("\n") ? "commands" : "command", btn));
    return el(
      "li",
      { class: "step" },
      el("div", { class: "step-title" }, ...(steps.length > 1 ? [el("span", { class: "num", textContent: String(i + 1) })] : []), el("span", {}, ...rich(st.title))),
      el("div", { class: `code ${st.lang}` }, el("pre", {}, el("code", { textContent: st.code })), btn),
    );
  });
}

const notesList = (notes: string[] | undefined) => (notes?.length ? [el("ul", { class: "notes" }, ...notes.map((n) => el("li", {}, ...rich(n))))] : []);

function renderMethod(target: HTMLElement, m: Method) {
  if (m.blocked) {
    // Can't work as built: say why and how to fix it, instead of commands that wouldn't work.
    target.replaceChildren(
      el(
        "div",
        { class: "blocked", role: "note" },
        el(
          "p",
          { class: "blocked-title" },
          el("span", { class: "blocked-icon", textContent: "⚠" }),
          m.blocked.kind === "instead" ? `${m.label} can't install ${page.kind === "catalog" ? "these skills" : page.kind === "plugin" ? "this plugin" : "this skill"}` : `${m.label} isn't set up for this site`,
        ),
        el("p", {}, ...rich(m.blocked.reason)),
        el(
          "p",
          { class: "blocked-fix" },
          el("strong", { textContent: m.blocked.kind === "instead" ? "Use instead: " : "How to fix: " }),
          ...rich(m.blocked.kind === "instead" ? m.blocked.fix.charAt(0).toUpperCase() + m.blocked.fix.slice(1) : m.blocked.fix),
        ),
      ),
      ...notesList(m.notes),
    );
    return;
  }
  target.replaceChildren(
    ...m.phases.map((ph) =>
      el(
        "section",
        { class: `phase phase-${ph.kind}` },
        el("h3", { textContent: PHASE_TITLES[ph.kind] }),
        ...(ph.steps.length ? [el("ol", { class: "steps" }, ...renderSteps(ph.steps))] : []),
        ...notesList(ph.notes),
      ),
    ),
    ...notesList(m.notes),
  );
}

type Choice = "protocol" | "scope";
const CHOICES: Record<Choice, { values: string[]; fallback: string; label: (v: string) => string }> = {
  protocol: { values: ["https", "ssh"], fallback: "https", label: (v) => v.toUpperCase() },
  scope: { values: ["global", "project"], fallback: "global", label: (v) => (v === "global" ? "Global" : "Project") },
};

interface ChoiceState {
  /** The value the commands actually use (shown as selected). */
  effective: string;
  /** Values that don't apply to the current method, with the reason (shown disabled). */
  disabled: Map<string, string>;
}

/**
 * Which values of a toggle make a difference for the current method: a value is disabled when the method isn't
 * available with it, or when every value gives exactly the same method (the choice doesn't apply).
 */
function choiceState(key: Choice, current: Method | undefined, base: Parameters<typeof methods>[2]): ChoiceState {
  const disabled = new Map<string, string>();
  if (!current || current.blocked) return { effective: settings[key], disabled };
  const variants = CHOICES[key].values.map((v) => [v, methods(data, settings.agent, { ...base, [key]: v }).find((m) => m.id === current.id)] as const);
  for (const [v, m] of variants) if (!m) disabled.set(v, `${current.label} isn't available with ${CHOICES[key].label(v)}`);
  const present = variants.filter(([, m]) => m);
  if (present.length > 1 && present.every(([, m]) => JSON.stringify(m) === JSON.stringify(present[0]![1]))) {
    const keep = present.some(([v]) => v === CHOICES[key].fallback) ? CHOICES[key].fallback : present[0]![0];
    for (const [v] of present) if (v !== keep) disabled.set(v, `Doesn't apply to ${current.label}`);
  }
  const effective = disabled.has(settings[key]) ? (CHOICES[key].values.find((v) => !disabled.has(v)) ?? settings[key]) : settings[key];
  return { effective, disabled };
}

function syncControls(states: Partial<Record<Choice, ChoiceState>> = {}) {
  for (const group of document.querySelectorAll<HTMLElement>("[data-setting]")) {
    const key = group.dataset.setting as Choice;
    const st = states[key];
    for (const b of group.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
      const v = b.dataset.value!;
      const on = v === (st?.effective ?? settings[key]);
      const reason = st?.disabled.get(v);
      b.setAttribute("aria-checked", String(on));
      b.disabled = !!reason;
      b.title = reason ?? "";
      b.tabIndex = on ? 0 : -1;
    }
  }
  (document.getElementById("agent") as HTMLSelectElement).value = settings.agent;
}

/** "~1.2k tokens always loaded · ~18k when used · 2.3 MB on disk" for what this panel installs. */
function renderEstimate() {
  const el_ = document.getElementById("context-estimate");
  if (!el_) return;
  const t = totalSize(data.skills.map((s) => s.size));
  const one = page.kind === "skill" || data.skills.length === 1;
  if (!data.skills.length) {
    el_.hidden = true;
    return;
  }
  el_.replaceChildren(
    el("span", { class: "label", textContent: "Context estimate" }),
    el("span", {}, el("strong", { textContent: formatTokens(t.always) }), " tokens always loaded"),
    el("span", {}, el("strong", { textContent: formatTokens(t.invoke) }), one ? " more when used" : ` more if all ${data.skills.length} skills are used`),
    el("span", {}, el("strong", { textContent: formatBytes(t.bytes) }), " on disk"),
  );
  el_.title =
    "Estimated at ~4 characters per token. Agents keep each skill's name and description in context from the start; " +
    "the SKILL.md body loads when the skill is used; other files only if the agent reads them.";
}

/** The method tab clicked on this page (not just remembered from an earlier visit). */
let clickedMethod: string | undefined;

function render() {
  renderEstimate();
  const base = { ...settings, skill: page.kind === "skill" ? page.skill : undefined, plugin: page.kind === "plugin" ? page.plugin : undefined };
  const available = methods(data, settings.agent, base);
  // The saved method, unless it was remembered from an earlier visit, is blocked here, and something else works.
  // A tab clicked on this page always opens (that's how you read its warning).
  const saved = available.find((m) => m.id === settings.method);
  const keep = saved && (!saved.blocked || clickedMethod === saved.id || !available.some((m) => !m.blocked));
  const current = keep ? saved : defaultMethod(available);
  // Grey out HTTPS/SSH or Global/Project when they make no difference to this method (the stored choice is kept).
  syncControls({ protocol: choiceState("protocol", current, base), scope: choiceState("scope", current, base) });
  const tabs = document.getElementById("methods")!;
  tabs.replaceChildren(
    ...available.map((m) => {
      const on = m === current!;
      const b = el("button", { type: "button", textContent: m.blocked ? `${m.label} ⚠` : m.label, tabIndex: on ? 0 : -1, class: m.blocked ? "is-blocked" : "" });
      if (m.blocked) b.title = m.blocked.reason.replace(/`/g, "");
      b.dataset.value = m.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(on));
      return b;
    }),
  );
  const guideEl = document.getElementById("guide")!;
  if (current) renderMethod(guideEl, current);
  else
    guideEl.replaceChildren(
      el("p", { class: "muted", textContent: `No install method for ${page.kind === "catalog" ? "the whole catalog" : "this"} with ${AGENTS.find((a) => a.id === settings.agent)?.label ?? "this agent"}. ` }, ...(page.kind === "catalog" ? [link(siteHref("plugins/"), "Open a plugin"), " or a skill to install it."] : [])),
    );
}

function set<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: keep in memory */
  }
  render();
}

function setupControls() {
  const agent = document.getElementById("agent") as HTMLSelectElement;
  const group = (label: string, pick: (a: (typeof AGENTS)[number]) => boolean) =>
    el("optgroup", { label }, ...AGENTS.filter(pick).map((a) => el("option", { value: a.id, textContent: a.label })));
  agent.replaceChildren(group("Native", (a) => a.native), group("Via skills CLI", (a) => !a.native && !a.unsupported), group("Not supported", (a) => !!a.unsupported));
  agent.addEventListener("change", () => set("agent", agent.value));

  // Segmented toggles (protocol, scope) and the method tabs: click + arrow keys.
  const wire = (container: HTMLElement, current: () => string, choose: (v: string) => void) => {
    container.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]");
      if (b) choose(b.dataset.value!);
    });
    container.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const btns = [...container.querySelectorAll<HTMLButtonElement>("button[data-value]")].filter((b) => !b.disabled);
      if (btns.length < 2) return;
      const i = btns.findIndex((b) => b.dataset.value === current());
      const next = btns[(i + (ev.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length]!;
      choose(next.dataset.value!);
      container.querySelector<HTMLButtonElement>(`button[data-value="${next.dataset.value}"]`)?.focus();
    });
  };
  for (const g of document.querySelectorAll<HTMLElement>("[data-setting]")) {
    const key = g.dataset.setting as "protocol" | "scope";
    wire(g, () => settings[key], (v) => set(key, v as never));
  }
  const tabs = document.getElementById("methods")!;
  wire(tabs, () => tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.dataset.value ?? "", (v) => {
    clickedMethod = v;
    set("method", v as MethodId);
  });
}

// ---- Pager shared by the skills table and the files table ----

const SIZES = [10, 25, 50, 100];
const DEFAULT_SIZE = 25;

/** 1 … 4 5 [6] 7 8 … 20 */
function pageList(cur: number, last: number): (number | "…")[] {
  const nums = [...new Set([1, last, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((n) => n >= 1 && n <= last))].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1]! > 1) out.push("…");
    out.push(n);
  });
  return out;
}

interface PagerOptions {
  page: number;
  size: number;
  total: number;
  /** Plural noun for the count and the size selector label, e.g. "skills". */
  noun: string;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}

/** "11–20 of 57", page buttons, and a page-size select. */
function pagerControls(o: PagerOptions): Node[] {
  const last = Math.max(1, Math.ceil(o.total / o.size));
  const from = (o.page - 1) * o.size;
  const button = (label: string, target: number, opts: { current?: boolean; disabled?: boolean; aria?: string } = {}) => {
    const b = el("button", { type: "button", textContent: label, disabled: !!opts.disabled, class: opts.current ? "current" : "" });
    if (opts.current) b.setAttribute("aria-current", "page");
    if (opts.aria) b.setAttribute("aria-label", opts.aria);
    b.addEventListener("click", () => o.onPage(target));
    return b;
  };
  const sizeSel = el("select", {}, ...SIZES.map((n) => el("option", { value: String(n), textContent: `${n} / page`, selected: n === o.size })));
  sizeSel.setAttribute("aria-label", `${o.noun[0]!.toUpperCase()}${o.noun.slice(1)} per page`);
  sizeSel.addEventListener("change", () => o.onSize(Number(sizeSel.value)));
  const count = el("span", { class: "count", textContent: o.total ? `${from + 1}–${Math.min(from + o.size, o.total)} of ${o.total}` : `0 ${o.noun}` });
  const nav = el(
    "div",
    { class: "pages" },
    ...(last > 1
      ? [
          button("‹", o.page - 1, { disabled: o.page === 1, aria: "Previous page" }),
          ...pageList(o.page, last).map((n) => (n === "…" ? el("span", { class: "gap", textContent: "…" }) : button(String(n), n, { current: n === o.page, aria: `Page ${n}` }))),
          button("›", o.page + 1, { disabled: o.page === last, aria: "Next page" }),
        ]
      : []),
  );
  return [count, nav, sizeSel];
}

// ---- Files table on skill pages: server-rendered rows, paginated here (?page=&size= in the URL) ----

function setupFilesTable() {
  const table = document.getElementById("files");
  if (!table) return;
  const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")];
  const pager = document.getElementById("files-pager")!;
  const read = () => {
    const p = new URLSearchParams(location.search);
    const size = Number(p.get("size"));
    return { page: Math.max(1, Math.floor(Number(p.get("page"))) || 1), size: SIZES.includes(size) ? size : DEFAULT_SIZE };
  };
  let state = read();
  const draw = () => {
    const last = Math.max(1, Math.ceil(rows.length / state.size));
    if (state.page > last) state.page = last;
    const from = (state.page - 1) * state.size;
    rows.forEach((r, i) => (r.hidden = i < from || i >= from + state.size));
    pager.replaceChildren(
      ...pagerControls({
        ...state,
        total: rows.length,
        noun: "files",
        onPage: (n) => {
          go({ page: n }, "push");
          document.getElementById("files-title")!.scrollIntoView({ block: "start", behavior: "smooth" });
        },
        onSize: (n) => go({ size: n, page: 1 }, "replace"),
      }),
    );
  };
  const go = (patch: Partial<typeof state>, mode: "push" | "replace") => {
    state = { ...state, ...patch };
    const p = new URLSearchParams();
    if (state.page > 1) p.set("page", String(state.page));
    if (state.size !== DEFAULT_SIZE) p.set("size", String(state.size));
    const url = `${location.pathname}${p.size ? `?${p}` : ""}`;
    if (url !== `${location.pathname}${location.search}`) history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    draw();
  };
  addEventListener("popstate", () => {
    state = read();
    draw();
  });
  draw();
}

// ---- Skills table: text search, tag/plugin filters and pagination, all kept in the URL's search params ----
//   ?q=<text>&tag=<a>&tag=<b>&plugin=<p>&page=<n>&size=<n>   (tags are AND-ed)


interface TableState {
  q: string;
  tags: string[];
  plugin: string;
  page: number;
  size: number;
}

function readState(search: string): TableState {
  const p = new URLSearchParams(search);
  const size = Number(p.get("size"));
  return {
    q: p.get("q") ?? "",
    tags: [...new Set(p.getAll("tag").map((t) => t.trim().toLowerCase()).filter(Boolean))],
    plugin: p.get("plugin") ?? "",
    page: Math.max(1, Math.floor(Number(p.get("page"))) || 1),
    size: SIZES.includes(size) ? size : DEFAULT_SIZE,
  };
}

function writeSearch(st: TableState): string {
  const p = new URLSearchParams();
  if (st.q.trim()) p.set("q", st.q);
  for (const t of st.tags) p.append("tag", t);
  if (st.plugin) p.set("plugin", st.plugin);
  if (st.page > 1) p.set("page", String(st.page));
  if (st.size !== DEFAULT_SIZE) p.set("size", String(st.size));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

function setupTable() {
  const table = document.getElementById("skills");
  if (!table) return;
  // Old links to the removed dialog (#skill=name) go to the skill's page.
  const legacy = /^#skill=(.+)$/.exec(location.hash);
  if (legacy) return location.replace(`skill/${encodeURIComponent(decodeURIComponent(legacy[1]!))}/`);

  const tbody = table.querySelector("tbody")!;
  const pager = document.getElementById("pager")!;
  const active = document.getElementById("active-filters")!;
  const filter = document.getElementById("filter") as HTMLInputElement;
  const hasTags = data.skills.some((s) => s.tags.length);
  table.classList.toggle("no-tags", !hasTags);
  // A skill can be in several plugins (preserved from the repo's marketplace).
  const memberOf = (name: string) => {
    const ps = data.plugins.filter((p) => p.skills.includes(name)).map((p) => p.name);
    return ps.length ? ps : [data.skills.find((s) => s.name === name)!.plugin];
  };
  const index = data.skills.map((s) => {
    const plugins = memberOf(s.name);
    return { s, plugins, text: `${s.name} ${plugins.join(" ")} ${s.description} ${s.tags.join(" ")}`.toLowerCase() };
  });
  const pluginsOf = new Map(index.map((x) => [x.s.name, x.plugins]));
  let state = readState(location.search);

  /** Apply a change. Tag/plugin/page clicks add a history entry (Back undoes them); typing replaces it. */
  const update = (patch: Partial<TableState>, mode: "push" | "replace" = "push") => {
    state = { ...state, ...patch };
    const url = `${location.pathname}${writeSearch(state)}`;
    if (url !== `${location.pathname}${location.search}`) history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    draw();
  };

  const toggleTag = (t: string) => update({ tags: state.tags.includes(t) ? state.tags.filter((x) => x !== t) : [...state.tags, t], page: 1 });
  const togglePlugin = (p: string) => update({ plugin: state.plugin === p ? "" : p, page: 1 });

  const tagButton = (t: string) => {
    const on = state.tags.includes(t);
    const b = el("button", { type: "button", class: `tag${on ? " on" : ""}`, textContent: t, title: on ? `Remove filter: ${t}` : `Show skills tagged ${t}` });
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => toggleTag(t));
    return b;
  };
  const pluginButton = (p: string) => {
    const on = state.plugin === p;
    const b = el("button", { type: "button", class: `pill${on ? " on" : ""}`, textContent: p, title: on ? "Remove plugin filter" : `Show skills in ${p}` });
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => togglePlugin(p));
    return b;
  };

  const row = (s: InstallData["skills"][number]) =>
    el(
      "tr",
      {},
      el("td", { class: "name" }, link(`skill/${encodeURIComponent(s.name)}/`, s.name)),
      el("td", { class: "plugin" }, el("div", { class: "tags" }, ...pluginsOf.get(s.name)!.map(pluginButton))),
      el("td", { class: "tags-cell" }, el("div", { class: "tags" }, ...s.tags.map(tagButton))),
      el("td", { class: "desc" }, el("div", { textContent: s.description, title: s.description })),
    );

  const activeChip = (label: string, value: string, onRemove: () => void) => {
    const b = el("button", { type: "button", class: "active-chip", title: `Remove ${label} filter` }, el("span", { class: "k", textContent: `${label}:` }), ` ${value} `, el("span", { class: "x", textContent: "✕" }));
    b.setAttribute("aria-label", `Remove ${label} filter ${value}`);
    b.addEventListener("click", onRemove);
    return b;
  };

  function draw() {
    if (filter.value !== state.q) filter.value = state.q;
    const words = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = index
      .filter(({ s, plugins, text }) => words.every((w) => text.includes(w)) && state.tags.every((t) => s.tags.includes(t)) && (!state.plugin || plugins.includes(state.plugin)))
      .map((x) => x.s);
    const last = Math.max(1, Math.ceil(hits.length / state.size));
    if (state.page > last) state.page = last;
    const from = (state.page - 1) * state.size;
    tbody.replaceChildren(...hits.slice(from, from + state.size).map(row));
    document.getElementById("empty")!.hidden = hits.length > 0;

    const chips = [
      ...(state.plugin ? [activeChip("plugin", state.plugin, () => togglePlugin(state.plugin))] : []),
      ...state.tags.map((t) => activeChip("tag", t, () => toggleTag(t))),
    ];
    if (chips.length || state.q) {
      const clear = el("button", { type: "button", class: "clear", textContent: "Clear filters" });
      clear.addEventListener("click", () => update({ q: "", tags: [], plugin: "", page: 1 }));
      active.replaceChildren(...chips, clear);
    } else active.replaceChildren();
    active.hidden = !active.childElementCount;

    pager.replaceChildren(
      ...pagerControls({
        page: state.page,
        size: state.size,
        total: hits.length,
        noun: "skills",
        onPage: (n) => {
          update({ page: n });
          document.getElementById("skills-title")!.scrollIntoView({ block: "start", behavior: "smooth" });
        },
        onSize: (n) => update({ size: n, page: 1 }, "replace"),
      }),
    );
  }

  filter.addEventListener("input", () => update({ q: filter.value, page: 1 }, "replace"));
  addEventListener("popstate", () => {
    state = readState(location.search);
    draw();
  });
  // Normalise the URL (e.g. drop a page number past the end) without adding history.
  draw();
  history.replaceState(null, "", `${location.pathname}${writeSearch(state)}`);
}

// Build footer ("Built 3 minutes ago"), moved out of the inline snippet so the CSP needs no 'unsafe-inline'.
function setupFooter() {
  const footer = document.getElementById("build-footer");
  const out = document.getElementById("build-footer-time");
  if (!footer || !out) return;
  const built = Date.parse(footer.dataset.built ?? "");
  if (Number.isNaN(built)) {
    out.textContent = "recently";
    return;
  }
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  const tick = () => {
    const s = Math.round((built - Date.now()) / 1000);
    const [unit, size] = units.find(([, n]) => Math.abs(s) >= n) ?? units[units.length - 1]!;
    out.textContent = rtf.format(Math.round(s / size), unit);
  };
  tick();
  setInterval(tick, 1000);
}

/** "(3 days ago)" next to dates on the build page. */
function setupAgo() {
  const els = [...document.querySelectorAll<HTMLElement>("[data-since]")];
  if (!els.length) return;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  const tick = () => {
    for (const e of els) {
      const t = Date.parse(e.dataset.since ?? "");
      if (Number.isNaN(t)) continue;
      const s = Math.round((t - Date.now()) / 1000);
      const [unit, size] = units.find(([, n]) => Math.abs(s) >= n) ?? units[units.length - 1]!;
      e.textContent = `(${rtf.format(Math.round(s / size), unit)})`;
    }
  };
  tick();
  setInterval(tick, 30_000);
}

/** The navbar's hamburger (<details>): close it on a click outside, Escape, or picking a link. */
function setupNavMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>(".nav-menu");
  if (!menu) return;
  document.addEventListener("click", (ev) => {
    if (menu.open && !menu.contains(ev.target as Node)) menu.open = false;
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
}

/** Offline support and "install app": the service worker at the site root (only on https or localhost). */
function setupOffline(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const scope = new URL(page.root || "./", location.href);
  navigator.serviceWorker.register(new URL("sw.js", scope), { scope: scope.pathname }).catch(() => {
    // Not fatal: the site works the same without it.
  });
}

// The plugins page has no install panel or skills table.
const hasInstall = !!document.getElementById("install");
if (hasInstall) setupControls();
setupTable();
setupFilesTable();
setupFooter();
setupAgo();
setupNavMenu();
setupOffline();
if (hasInstall) render();
