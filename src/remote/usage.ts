/** Usage: the account limits the PC's plan chips show, each agent's context,
 * and one Claude session's context broken down. */
import { age, agentIcon, el, findPane, go, iconButton, panes, run, threadOf, toast, topBar, type Pane } from "./core";

type Limit = { label: string; group: string; percent: number; severity: string; resetsAt: string | null };
type Plan = { tier?: string; limits: Limit[]; stale?: boolean; fetchedAt?: string; nextRefreshAt?: string; cached?: boolean; error?: string; note?: string; bankedResets?: number; bankedResetExpiries?: (string | null)[] };
type Profile = { buckets: { label: string; tokens: number }[]; series: number[]; drops: { turn: number; pre: number; post: number; trigger: string }[]; ctx: number; est: number };

/** The PC's names: its TIERS and KIND_LABELS. */
const TIERS: Record<string, string> = {
  default_claude_max_5x: "Max (5x)", default_claude_max_20x: "Max (20x)", default_claude_pro: "Pro", default_claude_free: "Free",
  free: "Free", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise",
};
const KIND_LABELS: Record<string, string> = { session: "Current session", weekly_all: "All models" };
const PAGES: Record<string, string> = { claude: "https://claude.ai/settings/usage", codex: "https://chatgpt.com/codex/settings/usage" };

function resetMs(iso: string | null) {
  if (!iso) return 0;
  const at = Date.parse(iso) || Number(iso) * 1000;
  return Number.isNaN(at) ? 0 : at;
}
/** "Resets in 4 hr 8 min", worded as the PC words it. */
function fmtReset(iso: string | null) {
  const at = resetMs(iso);
  if (!at) return "";
  const left = at - Date.now();
  if (left <= 0) return "Resetting now";
  if (left < 864e5) {
    const mins = Math.floor(left / 6e4);
    if (mins < 1) return "Resets in under a minute";
    const h = Math.floor(mins / 60);
    return h ? `Resets in ${h} hr ${mins % 60} min` : `Resets in ${mins} min`;
  }
  const d = new Date(Math.round(at / 6e4) * 6e4);
  return `Resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** A limit as a thread along its rail, with a knot where it stands. */
function meter(percent: number, severity = "") {
  const m = el("div", `meter ${severity}`);
  const p = Math.max(0, Math.min(100, percent));
  const runEl = el("span", "run");
  runEl.style.width = `${p}%`;
  const dot = el("span", "dot");
  dot.style.left = `${p}%`;
  m.append(runEl, dot);
  m.setAttribute("role", "meter");
  m.setAttribute("aria-valuenow", String(Math.round(p)));
  m.setAttribute("aria-valuemin", "0");
  m.setAttribute("aria-valuemax", "100");
  return m;
}

export const usageView = el("section", "screen primary alone");
usageView.id = "usage";
const body = el("div", "body");
const refresh = iconButton("refresh", "Refresh", () => void read(true, true));
usageView.append(topBar("Usage", [refresh]), body);
let plans: Record<string, Plan> | null = null;
let readAt = 0;

/** The PC's last reading, or with `force` a new one, as its refresh button asks. */
export async function read(now = false, force = false) {
  if (usageView.hidden || (!now && Date.now() - readAt < 60000)) return draw();
  readAt = Date.now();
  if (force) (refresh.disabled = true), draw();
  try {
    plans = await run<Record<string, Plan>>("usage", force ? ["--refresh"] : [], { timeout: 60 });
    // Forced and still cached: the account's rate limit holds it.
    const held = force && Object.entries(plans).find(([, p]) => p.cached && p.nextRefreshAt);
    if (held) toast(`${held[0] === "claude" ? "Claude" : "Codex"} is rate limited: try again after ${new Date(held[1].nextRefreshAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`);
  } catch (e) {
    if (now) toast(e instanceof Error ? e.message : String(e), true);
  }
  if (force) refresh.disabled = false;
  draw();
}

export function draw() {
  const nodes: Node[] = [];
  for (const [kind, name] of [["claude", "Claude"], ["codex", "Codex"]] as const) {
    const plan = plans?.[kind];
    const box = el("section", "provider");
    const head = el("div", "provider-head");
    const who = el("div", "who");
    who.append(el("b", "", plan?.tier ? `${name} ${TIERS[plan.tier] ?? plan.tier}` : name), el("span", "", refresh.disabled ? "Refreshing…" : plan?.fetchedAt ? (age(plan.fetchedAt) === "now" ? "Updated just now" : `Updated ${age(plan.fetchedAt)} ago`) : plans ? "No reading" : "Reading…"));
    const page = el("a", "", "Details");
    Object.assign(page, { href: PAGES[kind], target: "_blank", rel: "noreferrer" });
    head.append(agentIcon(kind), who, page);
    box.append(head);
    if (plan?.error) box.append(el("p", "hint", plan.error));
    for (const l of plan?.limits ?? []) {
      // A limit whose reset time has passed is empty again, as the PC shows it.
      const percent = resetMs(l.resetsAt) && resetMs(l.resetsAt) < Date.now() ? 0 : l.percent;
      const row = el("div", "limit");
      row.append(el("span", "label", KIND_LABELS[l.label] ?? l.label), el("span", "pct", `${Math.round(percent)}%`), meter(percent, l.severity), el("span", "reset", fmtReset(l.resetsAt)));
      box.append(row);
    }
    if (plan?.bankedResets) {
      const next = plan.bankedResetExpiries?.find(Boolean);
      box.append(el("p", "hint", `${plan.bankedResets} banked reset${plan.bankedResets === 1 ? "" : "s"}${next ? `, the first expires ${new Date(next).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`));
    }
    if (plan?.stale) box.append(el("p", "hint", "Live refresh unavailable: this is the last reading."));
    if (plan?.note) box.append(el("p", "hint", plan.note));
    nodes.push(box);
  }
  const withContext = panes().filter((p) => p.context);
  if (withContext.length) {
    nodes.push(el("div", "section-title", "Each agent's context"));
    const list = el("div", "files");
    list.append(...withContext.sort((a, b) => (a.context!.remainingPercent - b.context!.remainingPercent)).map(contextRow));
    nodes.push(list);
  }
  body.replaceChildren(...nodes);
}

function contextRow(p: Pane) {
  const used = 100 - p.context!.remainingPercent;
  const row = el("button", "ctx-row");
  row.type = "button";
  row.onclick = () => (p.agent === "claude" ? go(`#/context/${encodeURIComponent(p.id)}`) : go(`#/pane/${encodeURIComponent(p.id)}`));
  const t = threadOf(p);
  row.append(agentIcon(p.agent), el("b", "", `${t?.name ?? ""} / ${p.agent}${p.model ? ` · ${p.model}` : ""}`), el("span", "pct", `${used}%`), meter(used, used >= 90 ? "critical" : used >= 70 ? "warning" : ""));
  return row;
}

// --- One Claude session's context -------------------------------------------------

export const contextView = el("section", "screen detail");
contextView.id = "context";
const ctxBody = el("div", "body");
const ctxWho = el("div", "who");
const ctxName = el("b"), ctxSub = el("span");
ctxWho.append(ctxName, ctxSub);
contextView.append(topBar(ctxWho, [], "#/usage"), ctxBody);

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export async function showContext(id: string) {
  const p = findPane(id);
  ctxName.textContent = p ? `${p.ref} · ${p.agent}` : "This agent is gone";
  ctxSub.textContent = p?.title ?? "";
  ctxBody.replaceChildren(el("p", "hint", "Reading its transcript…"));
  let prof: Profile;
  try {
    prof = await run<Profile>("context", [id], { timeout: 60 });
  } catch (e) {
    return void ctxBody.replaceChildren(el("p", "hint", e instanceof Error ? e.message : String(e)));
  }
  const window = p?.context?.windowTokens ?? 0;
  const used = window ? Math.round((prof.ctx / window) * 100) : 0;
  const nodes: Node[] = [];
  const top = el("div", "limit");
  top.append(el("span", "label", `${tokens(prof.ctx)} of ${window ? tokens(window) : "?"} tokens`), el("span", "pct", `${used}%`), meter(used, used >= 90 ? "critical" : used >= 70 ? "warning" : ""));
  nodes.push(top);
  if (prof.series.length > 1) nodes.push(el("div", "section-title", "After each turn"), spark(prof, window));
  const total = prof.buckets.reduce((s, b) => s + b.tokens, 0) || 1;
  const bars = el("div", "bars");
  const colors = ["var(--accent)", "var(--magenta)", "var(--cyan)", "var(--warn)", "var(--ok)", "var(--blue)", "var(--err)"];
  bars.append(...prof.buckets.map((b, i) => {
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${Math.max(1, (b.tokens / total) * 100)}%`;
    fill.style.background = colors[i % colors.length];
    bar.append(el("span", "", b.label), el("span", "mono", tokens(b.tokens)), fill);
    return bar;
  }));
  nodes.push(el("div", "section-title", "What fills it"), bars);
  if (prof.drops.length) nodes.push(el("p", "hint", `Compacted ${prof.drops.length} time${prof.drops.length === 1 ? "" : "s"}: ${prof.drops.map((d) => `turn ${d.turn}, ${tokens(d.pre)} to ${tokens(d.post)}`).join("; ")}.`));
  const open = el("button", "", "Open the agent");
  open.onclick = () => go(`#/pane/${encodeURIComponent(id)}`);
  nodes.push(open);
  ctxBody.replaceChildren(...nodes);
}

/** Context after each turn, against the window; compactions are the falls. */
function spark(prof: Profile, window: number) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  const max = Math.max(window, ...prof.series, 1);
  const pts = prof.series.map((v, i) => `${(i / (prof.series.length - 1)) * 100},${40 - (v / max) * 38}`);
  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", `M0,40 L${pts.join(" L")} L100,40 Z`);
  area.setAttribute("fill", "color-mix(in srgb, var(--accent) 18%, transparent)");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, line);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Context after each of ${prof.series.length} turns`);
  return svg;
}
