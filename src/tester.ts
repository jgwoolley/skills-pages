// Tester page: runs the shared checks (./checks.ts) on a URL or a chosen file, entirely in the browser.
// Requests go only to the URLs you enter, when you press Validate; chosen files never leave the browser.
// Git repositories can't be read from a browser, so they're explained instead of checked.
import { add, checkBytes, checkUrl, configure, report, worst, type Report, type Status, type Yaml } from "./checks.ts";

// YAML parser vendored next to this file (no CDN), loaded on first use.
configure({ yaml: () => import(new URL("./vendor/yaml/index.js", import.meta.url).href) as Promise<Yaml> });

// ---- UI ----

const ICON: Record<Status, string> = { ok: "✓", warn: "!", fail: "✕", info: "i" };
const SUMMARY: Record<Status, string> = { ok: "Looks good", warn: "Works, with warnings", fail: "Problems found", info: "Checked" };

function code(t: string): (Node | string)[] {
  return t.split(/`([^`]+)`/).map((part, i) => (i % 2 ? Object.assign(document.createElement("code"), { textContent: part }) : part));
}

function renderReport(r: Report, depth = 0): HTMLElement {
  const status = worst(r);
  const box = document.createElement(depth ? "details" : "section");
  box.className = `report status-${status}${depth ? " nested" : ""}`;
  if (depth && (status === "fail" || status === "warn")) (box as HTMLDetailsElement).open = true;
  const head = document.createElement(depth ? "summary" : "div");
  head.className = "report-head";
  head.append(
    Object.assign(document.createElement("span"), { className: `badge-${status}`, textContent: ICON[status] }),
    Object.assign(document.createElement("strong"), { textContent: r.title }),
    Object.assign(document.createElement("span"), { className: "report-kind", textContent: depth ? r.kind : `${r.kind} · ${SUMMARY[status]}` }),
  );
  box.append(head);
  if (r.checks.length) {
    const ul = document.createElement("ul");
    ul.className = "checks";
    for (const c of r.checks) {
      const li = document.createElement("li");
      li.className = `check-${c.status}`;
      li.append(Object.assign(document.createElement("span"), { className: `badge-${c.status}`, textContent: ICON[c.status] }), ...code(c.text));
      ul.append(li);
    }
    box.append(ul);
  }
  for (const c of r.children) box.append(renderReport(c, depth + 1));
  return box;
}

function setup() {
  const form = document.getElementById("tester-form") as HTMLFormElement | null;
  if (!form) return;
  const input = document.getElementById("tester-url") as HTMLInputElement;
  const fileInput = document.getElementById("tester-file") as HTMLInputElement;
  const out = document.getElementById("tester-results")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const run = async (task: () => Promise<Report>) => {
    button.disabled = true;
    out.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Checking…" }));
    try {
      out.replaceChildren(renderReport(await task()));
    } catch (err) {
      out.replaceChildren(renderReport(add(report("Tester", "error"), "fail", (err as Error).message)));
    } finally {
      button.disabled = false;
    }
  };
  // Keep the last URL in the address bar (?url=…) so a check can be shared or repeated.
  const params = new URLSearchParams(location.search);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ url })}`);
    void run(() => checkUrl(url));
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void run(async () => checkBytes({ url: location.href, bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type }, file.name));
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-example]"))
    b.addEventListener("click", () => {
      input.value = new URL(b.dataset.example!, document.baseURI).href;
      form.requestSubmit();
    });
  if (params.get("url")) {
    input.value = params.get("url")!;
    form.requestSubmit();
  }
}

setup();
