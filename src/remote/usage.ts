/** Usage: the account limits the PC's plan chips show, each agent's context,
 * and one Claude session's context broken down. */
import { act, age, agentIcon, app, button, el, findPane, go, iconButton, panes, run, threadOf, toast, topBar, ui, type Pane } from "./core";
import { meter, spark } from "../procs";

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

export const usageView = el("section", "screen primary alone");
usageView.id = "usage";
const body = el("div", "body");
const refresh = iconButton("refresh", "Refresh", () => void read(true, true));
usageView.append(topBar("Usage", [refresh]), body);
let plans: Record<string, Plan> | null = null;
let planOff = false; // the PC's Plan usage is off (Settings): nobody asks the accounts, this tab neither
let readAt = 0;

/** The PC's last reading, or with `force` a new one, as its refresh button asks. */
export async function read(now = false, force = false) {
  if (usageView.hidden || (!now && Date.now() - readAt < 60000)) return draw();
  readAt = Date.now();
  if (force) (refresh.disabled = true), draw();
  try {
    // `usage` reads the accounts even with Plan usage off, every 5 minutes this tab is open: asked first.
    planOff = (await run<{ "plan-usage"?: string }>("set").catch(() => null))?.["plan-usage"] === "off";
    if (!planOff) {
      plans = await run<Record<string, Plan>>("usage", force ? ["--refresh"] : [], { timeout: 60 });
      // Forced and still cached: the account's rate limit holds it.
      const held = force && Object.entries(plans).find(([, p]) => p.cached && p.nextRefreshAt);
      if (held) toast(`${held[0] === "claude" ? "Claude" : "Codex"} is rate limited: try again after ${new Date(held[1].nextRefreshAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`);
    }
  } catch (e) {
    if (now) toast(e instanceof Error ? e.message : String(e), true);
  }
  if (force) refresh.disabled = false;
  draw();
}

let drawn = ""; // what the tab shows: drawn again only when that changes, never under a finger for nothing
export function draw() {
  const nodes: Element[] = [];
  refresh.hidden = planOff;
  if (planOff) {
    const box = el("section", "provider");
    const head = el("div", "provider-head");
    const who = el("div", "who");
    who.append(el("b", "", "Plan usage is off"), el("span", "", "Loom doesn't ask Claude or Codex for your limits."));
    head.append(ui("usage"), who, button("Turn on", () => void act(() => run("set", ["plan-usage", "on"], { change: true }), "Plan usage is on").then(() => read(true))));
    box.append(head);
    nodes.push(box);
  }
  for (const [kind, name] of planOff ? [] : ([["claude", "Claude"], ["codex", "Codex"]] as const)) {
    const plan = plans?.[kind];
    const box = el("section", "provider");
    const head = el("div", "provider-head");
    const who = el("div", "who");
    // By the minute: seconds would redraw the tab on each 2 s read of the threads.
    const fresh = plan?.fetchedAt && Date.now() - Date.parse(plan.fetchedAt) < 60000;
    const named = el("b", "", name);
    if (plan?.tier) named.append(" ", el("span", "tier", TIERS[plan.tier] ?? plan.tier));
    who.append(named, el("span", "", refresh.disabled ? "Refreshing…" : plan?.fetchedAt ? (fresh ? "Updated just now" : `Updated ${age(plan.fetchedAt)} ago`) : plans ? "No reading" : "Reading…"));
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
  const html = nodes.map((n) => n.outerHTML).join("");
  if (html === drawn && body.childElementCount) return;
  drawn = html;
  body.replaceChildren(...nodes);
}

function contextRow(p: Pane) {
  const used = 100 - p.context!.remainingPercent;
  const row = el("button", "ctx-row");
  row.type = "button";
  row.dataset.pane = p.id; // where its tap goes, so a new pane id draws it anew
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
  const p = findPane(id), visit = app.visit;
  ctxName.textContent = p ? `${p.ref} · ${p.agent}` : "This agent is gone";
  ctxSub.textContent = p?.title ?? "";
  ctxBody.replaceChildren(el("p", "hint", "Reading its transcript…"));
  let prof: Profile;
  try {
    prof = await run<Profile>("context", [id], { timeout: 60 });
  } catch (e) {
    if (visit === app.visit) ctxBody.replaceChildren(el("p", "hint", e instanceof Error ? e.message : String(e)));
    return;
  }
  // Read late, after you left for another agent's: that one's screen keeps its own numbers.
  if (visit !== app.visit) return;
  const window = p?.context?.windowTokens ?? 0;
  const used = window ? Math.round((prof.ctx / window) * 100) : 0;
  const nodes: Node[] = [];
  const top = el("div", "limit");
  top.append(el("span", "label", `${tokens(prof.ctx)} of ${window ? tokens(window) : "?"} tokens`), el("span", "pct", `${used}%`), meter(used, used >= 90 ? "critical" : used >= 70 ? "warning" : ""));
  nodes.push(top);
  if (prof.series.length > 1) nodes.push(el("div", "section-title", "After each turn"), spark(prof.series, Math.max(window, ...prof.series, 1), `Context after each of ${prof.series.length} turns`));
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
