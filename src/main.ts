import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize, UserAttentionType } from "@tauri-apps/api/window";
import { homeDir, join } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as pickFolder, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { proofFor, statusFor, flat, foot } from "./apply";
import { agentOf, codexRunning, codexTitle, grokTitle, launch, opencodeCommand, ownSession, validSessionId, type Agent } from "./agent";
import { icon } from "./icons";
import { parseStatus, lossInventory, parseBranch, upstreamLabel, parseNumstat, sumStat, diffRows, fileRows, hunkPatch, tree, gitAct, literal, resolveArgs, type Act, type Change, type DiffRow, type Sec, type Stat, type Node as Tree } from "./gitparse";
import { renderRows } from "./rows";
import { applyStash, listStashes, stashCommit } from "./stash";
import { LINES, wheelInit } from "./scroll";
import { dropText } from "./drop";
import { fileLinks, imageMime } from "./links";
import { claudeDivider, claudeComposer, readMenu, readFeedback, cursorKey, menuKeys, readSurvey, readInput, hash32, echoes, echoed, menuRev, claudeWorking, interruptHint, grokRunning, type Cell, type Menu as AgentMenu } from "./prompt";
import { callerPath, discards, flag, keyBytes, LOSSES, num, onOff, paneRef, parseArgs, pruneSettled, sha256, str, table, type Args, type Loss, type Options } from "./cli";
import { settingValue, allows, changeFields, claimManual, codexAsks, contextRecord, DEFAULT_NOTIFY, eventsAfter, fitBatch, isFinal, keptNotify, LOOM_TITLES, NOTIFY_KINDS, notifies, notifyDisposition, notifyKind, parseSignal, promptMatch, readJournal, route, sameNotify, taskContext, taskFields, taskRecord, TASK_STATES, unproven, writeJournal, type Change as TaskChange, type ManualEnter, type NotifyKind, type NotifySnapshot, type Signal, type Task, type TaskContext, type TaskEvent, type TaskSource, type TaskState } from "./task";
import { TaskEventGate } from "./task_event_gate";
import { Courier, hookHeader, hookUrl, matches, PaneEventLog, SETTLE_MS, Settler, TAIL_LINES, TAIL_WIDTH, type PaneEvent, type Webhook } from "./pane_events";
import { newPushKey, pushRequest, type PushKey, type PushMessage, type PushSub } from "./push";
import type { OverlayRow, OverlayState } from "./overlay";
import { procsView, type Reading } from "./procs";
import "@xterm/xterm/css/xterm.css";

const MAX_PANES = 16;
let desktopWindow: { size: PhysicalSize; position: PhysicalPosition; maximized: boolean; fullscreen: boolean; sideOpen: boolean } | undefined;

async function phoneWindow() {
  const button = $<HTMLButtonElement>("#phone-window");
  if (button.disabled) return;
  button.disabled = true;
  const win = getCurrentWindow();
  const restore = async () => {
    if (!desktopWindow) return;
    await win.setFullscreen(false);
    await win.unmaximize();
    await win.setSize(desktopWindow.size);
    await win.setPosition(desktopWindow.position);
    if (desktopWindow.maximized) await win.maximize();
    if (desktopWindow.fullscreen) await win.setFullscreen(true);
    toggleSide(desktopWindow.sideOpen);
    desktopWindow = undefined;
  };
  try {
    if (desktopWindow) {
      await restore();
    } else {
      const monitor = await currentMonitor();
      if (!monitor) throw new Error("Could not find the current monitor");
      const maximized = await win.isMaximized();
      const fullscreen = await win.isFullscreen();
      if (fullscreen) await win.setFullscreen(false);
      if (maximized) await win.unmaximize();
      const size = await win.innerSize();
      const position = await win.outerPosition();
      desktopWindow = { size, position, maximized, fullscreen, sideOpen };
      const outer = await win.outerSize();
      const frameWidth = outer.width - size.width, frameHeight = outer.height - size.height;
      const work = monitor.workArea;
      // A26: 1080 x 2340. Use a readable desktop scale, including the window
      // frame, and leave taskbars outside the phone-shaped window.
      const factor = Math.min(390 * monitor.scaleFactor / 1080, work.size.width / 1080, work.size.height / 2340);
      const width = Math.min(work.size.width, Math.max(Math.round(1080 * factor), 320 * monitor.scaleFactor + frameWidth));
      const height = Math.round(2340 * factor);
      await win.setSize(new PhysicalSize(Math.max(1, width - frameWidth), Math.max(1, height - frameHeight)));
      await win.setPosition(new PhysicalPosition(
        Math.round(work.position.x + (work.size.width - width) / 2),
        Math.round(work.position.y + (work.size.height - height) / 2),
      ));
      toggleSide(false);
    }
  } catch (e) {
    // Retain the saved bounds if restoration itself fails, so the next click
    // can retry instead of forgetting the user's desktop window.
    await restore().catch(() => {});
    toast(`Could not resize the window: ${String(e)}`);
  } finally {
    const active = !!desktopWindow;
    button.disabled = false;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Restore desktop window" : "Fit window for Galaxy A26");
    button.title = active ? "Restore previous window size and position" : "Fit window for Galaxy A26 (portrait)";
  }
}
/** Provider title spinners ("✻ Thinking…"): stripped before a title is shown or compared. */
const SPIN = /^[✳✻✽✶✢·◐◓◑◒⠁-⣿]+\s*/u;
/** What a pane's header calls it: what its app titled itself, or Loom's own
 * name for it (task.ts LOOM_TITLES), the only kind a notice may carry. */
function paneTitle(appTitle: string, agent: Agent) {
  // cmd.exe and powershell.exe title themselves with their own path until
  // something under them sets one (codex never does) — the agent's name
  // says more, and a shell's says nothing.
  const app = /\.exe\s*$/i.test(appTitle) ? (agent === "shell" ? "" : agent) : agent === "grok" ? grokTitle(appTitle) : appTitle;
  // Provider title spinners go: the pane's own state says "working" once, in
  // Loom's colours, wherever the pane shows.
  const own = agent === "shell" ? app : app.replace(SPIN, "");
  return own && own !== agent ? own : agent === "shell" ? LOOM_TITLES.shell : LOOM_TITLES.agent;
}
/** Output xterm has parsed, acknowledged for every pane in one invoke. Rust lets a pane run
 * four batches ahead (output.rs), so a pane with two pending flushes them all at once and a
 * lone one waits at most 100 ms. A timer, never requestAnimationFrame: that stops while the
 * window is minimized, and agents would block on a full output pipe. */
const acks = new Map<number, number>();
let ackTimer = 0;
function flushAcks() {
  clearTimeout(ackTimer);
  ackTimer = 0;
  if (!acks.size) return;
  void invoke("pty_acks", { acks: [...acks] }).catch(() => {});
  acks.clear();
}
function ackOutput(channel: number) {
  const pending = (acks.get(channel) ?? 0) + 1;
  acks.set(channel, pending);
  if (pending >= 2) flushAcks();
  else ackTimer ||= window.setTimeout(flushAcks, 100);
}
/** Every pane's output in one message per flush (output.rs Bus), as [channel, text]
 * entries: a message per chunk cost a script eval on Loom's main thread each. A
 * launch keeps its own channel, so a relaunch still tells old output apart, and
 * output for one that is gone is acked anyway, or its process would stall. */
const outs = new Map<number, Channel<string>>();
const outBus = new Channel<[number, string][]>();
outBus.onmessage = (batch) => {
  for (const [id, text] of batch) {
    const out = outs.get(id);
    if (out) out.onmessage(text);
    else ackOutput(id);
  }
};
void invoke("output_bus", { onOut: outBus }).catch(() => {});

/** Keep destructive confirmations in the app; Escape and initial focus cancel. */
function confirm(message: string, options: { title: string; kind?: string; action?: string; detail?: string }): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>("#confirm")!;
  // A second request must never overwrite the action the user is reviewing.
  if (dialog.open) return Promise.resolve(false);
  document.querySelector("#confirm-title")!.textContent = message.split("\n")[0];
  document.querySelector("#confirm-detail")!.textContent = options.detail ?? message.split("\n").slice(1).join("\n").trim();
  const action = document.querySelector<HTMLButtonElement>("#confirm-action")!;
  action.textContent = options.action ?? "Continue";
  action.classList.toggle("danger", options.kind === "warning");
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

/** The live value of a palette custom property — one source of truth for the
 * bits of chrome CSS can't reach (xterm's own theme, find decorations). */
const cssVar = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Match highlight in the pane's own palette; both ruler colors are required.
 * A function, not a const: the palette moves when the theme does. */
const findOpts = () => ({
  decorations: {
    matchBackground: cssVar("--line-strong"),
    matchOverviewRuler: cssVar("--line-strong"),
    activeMatchBackground: cssVar("--accent"),
    activeMatchColorOverviewRuler: cssVar("--accent"),
  },
});

/** A palette override. `vars` are set inline on <html>, so an empty one means
 * "whatever :root says" — that's the default theme, and it keeps the stylesheet
 * the single source of truth for it (no flash of the wrong palette on boot). */
type Theme = { label: string; scheme?: "light"; vars: Record<string, string> };
/** Capture the default before overrides, including colors used by previews. */
const BASE = Object.fromEntries(
  ["bg", "panel", "raise", "line", "line-strong", "text", "muted", "faint", "accent", "ok", "err", "warn", "blue", "magenta", "cyan"].map(k => [`--${k}`, cssVar(`--${k}`)]),
);
const THEMES: Theme[] = [
  { label: "loom", vars: {} },
  {
    // Dyed greys: the default's grey steps with one natural dye through them, and that dye, softened, as the accent.
    label: "woad",
    vars: {
      "--bg": "#0c0f13",
      "--panel": "#12171b",
      "--raise": "#1a1f24",
      "--line": "#1f252b",
      "--line-strong": "#2c343c",
      "--text": "#eaecef",
      "--muted": "#9ca4ac",
      "--faint": "#7e8791",
      "--accent": "#a0c1e5",
      "--accent-dim": "rgba(160, 193, 229, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "lichen",
    vars: {
      "--bg": "#0c100e",
      "--panel": "#131715",
      "--raise": "#1a201c",
      "--line": "#1f2622",
      "--line-strong": "#2d3531",
      "--text": "#eaedeb",
      "--muted": "#9da6a1",
      "--faint": "#7f8983",
      "--accent": "#a3ccb5",
      "--accent-dim": "rgba(163, 204, 181, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "heather",
    vars: {
      "--bg": "#100e13",
      "--panel": "#17151a",
      "--raise": "#1f1d23",
      "--line": "#26222a",
      "--line-strong": "#35313a",
      "--text": "#edebef",
      "--muted": "#a5a1ab",
      "--faint": "#88848f",
      "--accent": "#c6b5dd",
      "--accent-dim": "rgba(198, 181, 221, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "walnut",
    vars: {
      "--bg": "#120e0b",
      "--panel": "#191511",
      "--raise": "#221d19",
      "--line": "#29231e",
      "--line-strong": "#39322b",
      "--text": "#eeece9",
      "--muted": "#a9a29b",
      "--faint": "#8d847c",
      "--accent": "#d6c1a4",
      "--accent-dim": "rgba(214, 193, 164, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "madder",
    vars: {
      "--bg": "#130d0d",
      "--panel": "#1b1415",
      "--raise": "#241c1c",
      "--line": "#2b2222",
      "--line-strong": "#3c2f30",
      "--text": "#efebeb",
      "--muted": "#ac9fa0",
      "--faint": "#918282",
      "--accent": "#e1aeb1",
      "--accent-dim": "rgba(225, 174, 177, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "verdigris",
    vars: {
      "--bg": "#0a1010",
      "--panel": "#111818",
      "--raise": "#182020",
      "--line": "#1c2726",
      "--line-strong": "#283636",
      "--text": "#e9eded",
      "--muted": "#99a6a6",
      "--faint": "#7a8a89",
      "--accent": "#94c9c8",
      "--accent-dim": "rgba(148, 201, 200, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    label: "ink",
    vars: {
      "--bg": "#07080e",
      "--panel": "#0e0f16",
      "--raise": "#15171f",
      "--line": "#1a1d26",
      "--line-strong": "#282b37",
      "--text": "#ebecf0",
      "--muted": "#9fa2af",
      "--faint": "#818595",
      "--accent": "#b5bae7",
      "--accent-dim": "rgba(181, 186, 231, 0.12)",
      "--ok": "#7fbf95",
      "--err": "#e8796f",
      "--warn": "#e6b450",
      "--blue": "#93b3e0",
      "--magenta": "#bfa6d9",
      "--cyan": "#84c2c9",
    },
  },
  {
    // Undyed and light, with woad in its lines and accent.
    label: "chalk",
    scheme: "light",
    vars: {
      "--bg": "#f2f5f7",
      "--panel": "#fcfdff",
      "--raise": "#e8ebef",
      "--line": "#dce0e5",
      "--line-strong": "#b4bbc3",
      "--text": "#252c34",
      "--muted": "#535c66",
      "--faint": "#5b646f",
      "--accent": "#335e89",
      "--accent-dim": "rgba(51, 94, 137, 0.1)",
      "--ok": "#2f7650",
      "--err": "#b0443b",
      "--warn": "#875f12",
      "--blue": "#3b62a0",
      "--magenta": "#7a559f",
      "--cyan": "#276d76",
    },
  },
  {
    label: "linen",
    scheme: "light",
    vars: {
      "--bg": "#f6f4f2",
      "--panel": "#fefdfb",
      "--raise": "#eeeae6",
      "--line": "#e3dfda",
      "--line-strong": "#c0b9b1",
      "--text": "#312a22",
      "--muted": "#62594f",
      "--faint": "#6b6157",
      "--accent": "#76523a",
      "--accent-dim": "rgba(118, 82, 58, 0.1)",
      "--ok": "#2f7650",
      "--err": "#b0443b",
      "--warn": "#875f12",
      "--blue": "#3b62a0",
      "--magenta": "#7a559f",
      "--cyan": "#276d76",
    },
  },
  {
    label: "celadon",
    scheme: "light",
    vars: {
      "--bg": "#f2f5f4",
      "--panel": "#fbfefc",
      "--raise": "#e7ecea",
      "--line": "#dbe1de",
      "--line-strong": "#b3bdb8",
      "--text": "#232e29",
      "--muted": "#515f58",
      "--faint": "#596760",
      "--accent": "#356656",
      "--accent-dim": "rgba(53, 102, 86, 0.1)",
      "--ok": "#2f7650",
      "--err": "#b0443b",
      "--warn": "#875f12",
      "--blue": "#3b62a0",
      "--magenta": "#7a559f",
      "--cyan": "#276d76",
    },
  },
  {
    // Loom's dye palette before the grey: indigo ground, weld yellow, woad blue.
    label: "loom indigo",
    vars: {
      "--bg": "#0c1120",
      "--panel": "#121a2d",
      "--raise": "#19233b",
      "--line": "#243150",
      "--line-strong": "#34436a",
      "--text": "#e8eaf1",
      "--muted": "#9ba4bc",
      "--faint": "#848da7",
      "--accent": "#7ea6ef",
      "--accent-dim": "rgba(126, 166, 239, 0.14)",
      "--ok": "#7cc08d",
      "--err": "#e5605a",
      "--warn": "#f2bb44",
      "--blue": "#93b4e8",
      "--magenta": "#c3a3dc",
      "--cyan": "#7fc6cf",
    },
  },
  {
    // Loom's first palette, navy and copper, before the dye colours.
    label: "loom classic",
    vars: {
      "--bg": "#0a0f1b",
      "--panel": "#0e1626",
      "--raise": "#141e33",
      "--line": "#1c2a45",
      "--line-strong": "#2a3c5c",
      "--text": "#dce4f0",
      "--muted": "#94a6c8",
      "--faint": "#6e82a6",
      "--accent": "#d97757",
      "--accent-dim": "rgba(217, 119, 87, 0.14)",
      "--ok": "#6fbf73",
      "--err": "#f85149",
      "--warn": "#e3b341",
      "--blue": "#91b9df",
      "--magenta": "#bba6d8",
      "--cyan": "#83c6d0",
    },
  },
  {
    label: "graphite",
    vars: {
      "--bg": "#131315",
      "--panel": "#191a1d",
      "--raise": "#232428",
      "--line": "#2b2d32",
      "--line-strong": "#3d4046",
      "--text": "#e4e4e7",
      "--muted": "#a1a1aa",
      "--faint": "#71717a",
      "--accent": "#d97757",
      "--accent-dim": "rgba(217, 119, 87, 0.14)",
      "--ok": "#4ade80",
      "--err": "#f87171",
      "--warn": "#fbbf24",
      "--blue": "#a5b9db",
      "--magenta": "#cfadd2",
      "--cyan": "#96c4cb",
    },
  },
  {
    label: "tidal",
    vars: {
      "--bg": "#111e2f",
      "--panel": "#172538",
      "--raise": "#1f2e41",
      "--line": "#253449",
      "--line-strong": "#33445b",
      "--text": "#dfe9f4",
      "--muted": "#9eb0c4",
      "--faint": "#8799ac",
      "--accent": "#8dbaf7",
      "--accent-dim": "rgba(141, 186, 247, 0.12)",
      "--ok": "#90c7af",
      "--err": "#f19ba9",
      "--warn": "#e4c18d",
      "--blue": "#8bbafa",
      "--magenta": "#c3aaea",
      "--cyan": "#8dcdd4",
    },
  },
  {
    label: "solarized",
    vars: {
      "--bg": "#002832",
      "--panel": "#04303b",
      "--raise": "#0f3944",
      "--line": "#14404c",
      "--line-strong": "#23505d",
      "--text": "#94a2a2",
      "--muted": "#abbbbd",
      "--faint": "#92a3a9",
      "--accent": "#e09678",
      "--accent-dim": "rgba(224, 150, 120, 0.12)",
      "--ok": "#9fae56",
      "--err": "#e48683",
      "--warn": "#c69f32",
      "--blue": "#62aedb",
      "--magenta": "#da86b1",
      "--cyan": "#59b7b0",
    },
  },
  {
    label: "gruvbox",
    vars: {
      "--bg": "#212121",
      "--panel": "#282828",
      "--raise": "#313131",
      "--line": "#373737",
      "--line-strong": "#474747",
      "--text": "#e4dcc6",
      "--muted": "#bfb29b",
      "--faint": "#a69a8d",
      "--accent": "#dd996f",
      "--accent-dim": "rgba(221, 153, 111, 0.12)",
      "--ok": "#b6ba5e",
      "--err": "#e4887a",
      "--warn": "#f1c05c",
      "--blue": "#8baea0",
      "--magenta": "#d88a9f",
      "--cyan": "#8ec07c",
    },
  },
  {
    label: "dracula",
    vars: {
      "--bg": "#21232e",
      "--panel": "#282a36",
      "--raise": "#31333f",
      "--line": "#373946",
      "--line-strong": "#464957",
      "--text": "#e8e8e2",
      "--muted": "#b4b6c4",
      "--faint": "#9a9eb6",
      "--accent": "#b79ce0",
      "--accent-dim": "rgba(183, 156, 224, 0.12)",
      "--ok": "#99e3a3",
      "--err": "#e68886",
      "--warn": "#cfd76d",
      "--blue": "#9baefd",
      "--magenta": "#e491be",
      "--cyan": "#80def2",
    },
  },
  {
    label: "nord",
    vars: {
      "--bg": "#2c333f",
      "--panel": "#333b48",
      "--raise": "#3c4452",
      "--line": "#424b59",
      "--line-strong": "#525b6b",
      "--text": "#e5e8ed",
      "--muted": "#c8ced8",
      "--faint": "#abb4c5",
      "--accent": "#88c0d0",
      "--accent-dim": "rgba(136, 192, 208, 0.12)",
      "--ok": "#a3be8c",
      "--err": "#dda4a9",
      "--warn": "#e9c989",
      "--blue": "#9ab5d0",
      "--magenta": "#c7a9c1",
      "--cyan": "#8fbcbb",
    },
  },
  {
    label: "tokyo",
    vars: {
      "--bg": "#181928",
      "--panel": "#1f2030",
      "--raise": "#272839",
      "--line": "#2d2f40",
      "--line-strong": "#3c3e51",
      "--text": "#c6cbe1",
      "--muted": "#a3a9c1",
      "--faint": "#8d92a9",
      "--accent": "#8baaeb",
      "--accent-dim": "rgba(139, 170, 235, 0.12)",
      "--ok": "#a4cb7b",
      "--err": "#e38695",
      "--warn": "#e0af68",
      "--blue": "#80a3ed",
      "--magenta": "#b99eed",
      "--cyan": "#7dcfff",
    },
  },
  {
    label: "catppuccin",
    vars: {
      "--bg": "#171726",
      "--panel": "#1e1e2e",
      "--raise": "#262637",
      "--line": "#2c2c3e",
      "--line-strong": "#3b3c4f",
      "--text": "#d0d6ec",
      "--muted": "#a1a7bf",
      "--faint": "#8d91a5",
      "--accent": "#c8aaee",
      "--accent-dim": "rgba(200, 170, 238, 0.12)",
      "--ok": "#a4e09f",
      "--err": "#ec90a9",
      "--warn": "#e2cb99",
      "--blue": "#89b4fa",
      "--magenta": "#eebce0",
      "--cyan": "#91dfd2",
    },
  },
  {
    label: "one dark",
    vars: {
      "--bg": "#21252c",
      "--panel": "#282c34",
      "--raise": "#31353d",
      "--line": "#373b44",
      "--line-strong": "#464b55",
      "--text": "#abb2bf",
      "--muted": "#b1b9c6",
      "--faint": "#9ca1a9",
      "--accent": "#73b1e6",
      "--accent-dim": "rgba(115, 177, 230, 0.12)",
      "--ok": "#98c379",
      "--err": "#e3868c",
      "--warn": "#e5c07b",
      "--blue": "#66afeb",
      "--magenta": "#c38dd3",
      "--cyan": "#56b6c2",
    },
  },
  {
    label: "everforest",
    vars: {
      "--bg": "#2c343b",
      "--panel": "#333c43",
      "--raise": "#3c454c",
      "--line": "#424c54",
      "--line-strong": "#525d65",
      "--text": "#d0c6b2",
      "--muted": "#c8d1c2",
      "--faint": "#adb6b0",
      "--accent": "#e9a486",
      "--accent-dim": "rgba(233, 164, 134, 0.12)",
      "--ok": "#a7c080",
      "--err": "#eca0a1",
      "--warn": "#dbbc7f",
      "--blue": "#85beb7",
      "--magenta": "#dba4be",
      "--cyan": "#85c194",
    },
  },
  {
    label: "rosé pine",
    vars: {
      "--bg": "#181626",
      "--panel": "#1f1d2e",
      "--raise": "#272537",
      "--line": "#2d2b3e",
      "--line-strong": "#3d3b4f",
      "--text": "#e0def4",
      "--muted": "#a8a5bd",
      "--faint": "#918ea4",
      "--accent": "#c4a7e7",
      "--accent-dim": "rgba(196, 167, 231, 0.12)",
      "--ok": "#9ccfd8",
      "--err": "#e1859c",
      "--warn": "#f6c177",
      "--blue": "#9ccfd8",
      "--magenta": "#c4a7e7",
      "--cyan": "#9ccfd8",
    },
  },
  {
    label: "dusk",
    vars: {
      "--bg": "#1c1920",
      "--panel": "#232028",
      "--raise": "#2c2831",
      "--line": "#322f37",
      "--line-strong": "#413e47",
      "--text": "#e2dbe6",
      "--muted": "#b1a7b9",
      "--faint": "#9a90a2",
      "--accent": "#c9a0b8",
      "--accent-dim": "rgba(201, 160, 184, 0.12)",
      "--ok": "#9fc4a0",
      "--err": "#e09a9a",
      "--warn": "#d8c08e",
      "--blue": "#9fb5d4",
      "--magenta": "#c4a8d6",
      "--cyan": "#94c2c4",
    },
  },
  {
    label: "moss",
    vars: {
      "--bg": "#161c18",
      "--panel": "#1d231f",
      "--raise": "#252c27",
      "--line": "#2b322d",
      "--line-strong": "#3a413d",
      "--text": "#d9e0d6",
      "--muted": "#a3afa1",
      "--faint": "#8a9889",
      "--accent": "#a9c39a",
      "--accent-dim": "rgba(169, 195, 154, 0.12)",
      "--ok": "#a9c39a",
      "--err": "#dd9c95",
      "--warn": "#d2bd8a",
      "--blue": "#96b4c4",
      "--magenta": "#bca6c6",
      "--cyan": "#8fbfb8",
    },
  },
  {
    label: "slate",
    vars: {
      "--bg": "#1a1e24",
      "--panel": "#21252c",
      "--raise": "#292e35",
      "--line": "#2f343c",
      "--line-strong": "#3f434c",
      "--text": "#dcdfe5",
      "--muted": "#a9b0bc",
      "--faint": "#9199a6",
      "--accent": "#9db4cf",
      "--accent-dim": "rgba(157, 180, 207, 0.12)",
      "--ok": "#a3c4a6",
      "--err": "#dc9d9d",
      "--warn": "#d3bf90",
      "--blue": "#9db4cf",
      "--magenta": "#bdaad0",
      "--cyan": "#92bfc3",
    },
  },
  {
    label: "void",
    vars: {
      "--bg": "#030304",
      "--panel": "#070709",
      "--raise": "#0e0e10",
      "--line": "#131316",
      "--line-strong": "#212124",
      "--text": "#e7e7ef",
      "--muted": "#92929f",
      "--faint": "#7d7d8c",
      "--accent": "#aaa0e6",
      "--accent-dim": "rgba(170, 160, 230, 0.12)",
      "--ok": "#88e5b2",
      "--err": "#e3858d",
      "--warn": "#f7c562",
      "--blue": "#69c7fa",
      "--magenta": "#b691de",
      "--cyan": "#67e6d8",
    },
  },
  {
    label: "kanagawa",
    vars: {
      "--bg": "#181820",
      "--panel": "#1f1f28",
      "--raise": "#272731",
      "--line": "#2d2e38",
      "--line-strong": "#3d3d48",
      "--text": "#dbd7c1",
      "--muted": "#a9a99f",
      "--faint": "#939286",
      "--accent": "#efa87f",
      "--accent-dim": "rgba(239, 168, 127, 0.12)",
      "--ok": "#98bb6c",
      "--err": "#e68994",
      "--warn": "#e6c384",
      "--blue": "#86a4e1",
      "--magenta": "#ae99d1",
      "--cyan": "#81b0a6",
    },
  },
  {
    label: "sepia",
    vars: {
      "--bg": "#1f1a15",
      "--panel": "#26211c",
      "--raise": "#2f2924",
      "--line": "#35302a",
      "--line-strong": "#453f39",
      "--text": "#e6ddd0",
      "--muted": "#b5a999",
      "--faint": "#9e9283",
      "--accent": "#d2a679",
      "--accent-dim": "rgba(210, 166, 121, 0.12)",
      "--ok": "#a9bf8f",
      "--err": "#dc9b8c",
      "--warn": "#d5bb84",
      "--blue": "#a4b6c8",
      "--magenta": "#c4a8b8",
      "--cyan": "#9bbfb4",
    },
  },
  //deepseek
  {
    label: "synthwave '84",
    vars: {
      "--bg": "#231a30",
      "--panel": "#2a2139",
      "--raise": "#332a42",
      "--line": "#39304a",
      "--line-strong": "#493f5c",
      "--text": "#ede7dd",
      "--muted": "#b4acc4",
      "--faint": "#9c95ad",
      "--accent": "#df9bc9",
      "--accent-dim": "rgba(223, 155, 201, 0.12)",
      "--ok": "#83e5b7",
      "--err": "#e38590",
      "--warn": "#e8cd62",
      "--blue": "#73c1fc",
      "--magenta": "#e497cc",
      "--cyan": "#62e5e3",
    },
  },
  {
    label: "cyberpunk",
    vars: {
      "--bg": "#0a0f1b",
      "--panel": "#101623",
      "--raise": "#181e2c",
      "--line": "#1d2433",
      "--line-strong": "#2b3343",
      "--text": "#dfe7f0",
      "--muted": "#93a0b2",
      "--faint": "#7c8a9f",
      "--accent": "#d0cb7d",
      "--accent-dim": "rgba(208, 203, 125, 0.12)",
      "--ok": "#8be5af",
      "--err": "#e3858e",
      "--warn": "#f3b559",
      "--blue": "#6ca9ea",
      "--magenta": "#d487bb",
      "--cyan": "#5edcf4",
    },
  },
  {
    label: "cyberpunk silver",
    vars: {
      "--bg": "#0a0f1b",
      "--panel": "#101623",
      "--raise": "#181e2c",
      "--line": "#1d2433",
      "--line-strong": "#2b3343",
      "--text": "#dfe7f0",
      "--muted": "#93a0b2",
      "--faint": "#7c8a9f",
      "--accent": "#e2e4e8",
      "--accent-dim": "rgba(226, 228, 232, 0.12)",
      "--ok": "#8be5af",
      "--err": "#e3858e",
      "--warn": "#f3b559",
      "--blue": "#6ca9ea",
      "--magenta": "#d487bb",
      "--cyan": "#5edcf4",
    },
  },
  {
    label: "matrix",
    vars: {
      "--bg": "#030904",
      "--panel": "#071009",
      "--raise": "#0e1810",
      "--line": "#131e16",
      "--line-strong": "#212c24",
      "--text": "#dceedc",
      "--muted": "#899c89",
      "--faint": "#748775",
      "--accent": "#9adaa3",
      "--accent-dim": "rgba(154, 218, 163, 0.12)",
      "--ok": "#96e3a5",
      "--err": "#e4877e",
      "--warn": "#eeca61",
      "--blue": "#6fa8eb",
      "--magenta": "#c78fd4",
      "--cyan": "#62dcc5",
    },
  },
  {
    label: "ayu mirage",
    vars: {
      "--bg": "#1d222e",
      "--panel": "#242936",
      "--raise": "#2d323f",
      "--line": "#333846",
      "--line-strong": "#424858",
      "--text": "#cccac2",
      "--muted": "#aeb6c3",
      "--faint": "#949eb0",
      "--accent": "#e7c27a",
      "--accent-dim": "rgba(231, 194, 122, 0.12)",
      "--ok": "#b8dc8a",
      "--err": "#e98d80",
      "--warn": "#f4c768",
      "--blue": "#73d0ff",
      "--magenta": "#d4bfff",
      "--cyan": "#90e1c6",
    },
  },
  {
    label: "palenight",
    vars: {
      "--bg": "#272b3e",
      "--panel": "#2e3247",
      "--raise": "#373b51",
      "--line": "#3d4259",
      "--line-strong": "#4d526b",
      "--text": "#d4d7ed",
      "--muted": "#bec2db",
      "--faint": "#a4a9c1",
      "--accent": "#b6d48c",
      "--accent-dim": "rgba(182, 212, 140, 0.12)",
      "--ok": "#badc88",
      "--err": "#ec8d90",
      "--warn": "#f8c565",
      "--blue": "#87abf5",
      "--magenta": "#cfa1ed",
      "--cyan": "#87dbfd",
    },
  },
  {
    label: "night owl",
    vars: {
      "--bg": "#061e31",
      "--panel": "#0c253a",
      "--raise": "#152e43",
      "--line": "#19344b",
      "--line-strong": "#28445d",
      "--text": "#d6deeb",
      "--muted": "#9cafc3",
      "--faint": "#8698ab",
      "--accent": "#e59780",
      "--accent-dim": "rgba(229, 151, 128, 0.12)",
      "--ok": "#b4d784",
      "--err": "#e48781",
      "--warn": "#f8c565",
      "--blue": "#87abf5",
      "--magenta": "#cfa1ed",
      "--cyan": "#7fdbca",
    },
  },
  {
    label: "monokai",
    vars: {
      "--bg": "#25261f",
      "--panel": "#2c2d26",
      "--raise": "#35362f",
      "--line": "#3b3c35",
      "--line-strong": "#4b4c44",
      "--text": "#e8e8e2",
      "--muted": "#bbbaad",
      "--faint": "#a4a295",
      "--accent": "#b5d48d",
      "--accent-dim": "rgba(181, 212, 141, 0.12)",
      "--ok": "#b6d986",
      "--err": "#e48783",
      "--warn": "#dcd16a",
      "--blue": "#ad94e3",
      "--magenta": "#e087a7",
      "--cyan": "#66d9ef",
    },
  },
  {
    label: "horizon",
    vars: {
      "--bg": "#1c1e28",
      "--panel": "#232530",
      "--raise": "#2c2e39",
      "--line": "#323440",
      "--line-strong": "#414351",
      "--text": "#d5d8da",
      "--muted": "#aab0c5",
      "--faint": "#9199b0",
      "--accent": "#e190a1",
      "--accent-dim": "rgba(225, 144, 161, 0.12)",
      "--ok": "#77e0b7",
      "--err": "#e2869a",
      "--warn": "#f8c098",
      "--blue": "#39bad6",
      "--magenta": "#e38fbb",
      "--cyan": "#3ec5d7",
    },
  },
  {
    label: "vesper",
    vars: {
      "--bg": "#0f0f0f",
      "--panel": "#161616",
      "--raise": "#1e1e1e",
      "--line": "#242424",
      "--line-strong": "#333333",
      "--text": "#e8e8e8",
      "--muted": "#9e9e9e",
      "--faint": "#888888",
      "--accent": "#f2ba8d",
      "--accent-dim": "rgba(242, 186, 141, 0.12)",
      "--ok": "#7ee4ca",
      "--err": "#ec8e8c",
      "--warn": "#f9c193",
      "--blue": "#91b4d8",
      "--magenta": "#dcaee8",
      "--cyan": "#89e2c7",
    },
  },
  {
    label: "poimandres",
    vars: {
      "--bg": "#181b24",
      "--panel": "#1f222c",
      "--raise": "#272b35",
      "--line": "#2d313c",
      "--line-strong": "#3c404c",
      "--text": "#d5e0f4",
      "--muted": "#a3acc3",
      "--faint": "#8e95ac",
      "--accent": "#7cddc3",
      "--accent-dim": "rgba(124, 221, 195, 0.12)",
      "--ok": "#6de2c4",
      "--err": "#e790b8",
      "--warn": "#d6d19a",
      "--blue": "#87dbfd",
      "--magenta": "#f1bbde",
      "--cyan": "#a9d3fb",
    },
  },
  {
    label: "flexoki",
    vars: {
      "--bg": "#151413",
      "--panel": "#1c1b1a",
      "--raise": "#242322",
      "--line": "#2a2928",
      "--line-strong": "#3a3837",
      "--text": "#cecdc3",
      "--muted": "#a4a49c",
      "--faint": "#8f8d85",
      "--accent": "#dc9a6c",
      "--accent-dim": "rgba(220, 154, 108, 0.12)",
      "--ok": "#abbf68",
      "--err": "#e3887a",
      "--warn": "#e2ba52",
      "--blue": "#6aaae8",
      "--magenta": "#db86ae",
      "--cyan": "#41baad",
    },
  },
  {
    label: "oxocarbon",
    vars: {
      "--bg": "#161616",
      "--panel": "#1d1d1d",
      "--raise": "#252525",
      "--line": "#2b2b2b",
      "--line-strong": "#3b3b3b",
      "--text": "#e6e8ec",
      "--muted": "#a0a5af",
      "--faint": "#8b8f97",
      "--accent": "#b89fe4",
      "--accent-dim": "rgba(184, 159, 228, 0.12)",
      "--ok": "#6eb97d",
      "--err": "#e98d82",
      "--warn": "#f7c56e",
      "--blue": "#80aaf2",
      "--magenta": "#e990b4",
      "--cyan": "#54d9d7",
    },
  },
  {
    label: "amber",
    vars: {
      "--bg": "#0b0500",
      "--panel": "#120a02",
      "--raise": "#1a1206",
      "--line": "#20170b",
      "--line-strong": "#2f2518",
      "--text": "#dbccb9",
      "--muted": "#a3947f",
      "--faint": "#8c7f6a",
      "--accent": "#e7b976",
      "--accent-dim": "rgba(231, 185, 118, 0.12)",
      "--ok": "#e8c170",
      "--err": "#e48d6d",
      "--warn": "#eeca61",
      "--blue": "#e0b268",
      "--magenta": "#db915a",
      "--cyan": "#e5c687",
    },
  },
  {
    label: "terafox",
    vars: {
      "--bg": "#0d1c1e",
      "--panel": "#132325",
      "--raise": "#1b2c2e",
      "--line": "#213234",
      "--line-strong": "#2f4244",
      "--text": "#dde6e4",
      "--muted": "#9cadad",
      "--faint": "#7d9896",
      "--accent": "#df9774",
      "--accent-dim": "rgba(223, 151, 116, 0.12)",
      "--ok": "#84aeab",
      "--err": "#e4887b",
      "--warn": "#fda66f",
      "--blue": "#6fb1c4",
      "--magenta": "#df87a8",
      "--cyan": "#a1cdd8",
    },
  },
  // Current editors' own palettes, set to the same rules as the rest.
  {
    label: "github dimmed",
    vars: {
      "--bg": "#1b2027",
      "--panel": "#22272e",
      "--raise": "#2a3037",
      "--line": "#31363d",
      "--line-strong": "#40464d",
      "--text": "#cdd9e5",
      "--muted": "#a5b3c0",
      "--faint": "#8e9ba9",
      "--accent": "#6f9cd7",
      "--accent-dim": "rgba(111, 156, 215, 0.12)",
      "--ok": "#66a767",
      "--err": "#da7f75",
      "--warn": "#c69028",
      "--blue": "#679cdf",
      "--magenta": "#ab8cda",
      "--cyan": "#3ac5cf",
    },
  },
  {
    label: "vitesse",
    vars: {
      "--bg": "#0c0c0c",
      "--panel": "#121212",
      "--raise": "#1a1a1a",
      "--line": "#202020",
      "--line-strong": "#2e2e2e",
      "--text": "#dbd7ca",
      "--muted": "#949ca3",
      "--faint": "#7e868d",
      "--accent": "#4d9375",
      "--accent-dim": "rgba(77, 147, 117, 0.12)",
      "--ok": "#80a665",
      "--err": "#cb7676",
      "--warn": "#e6cc77",
      "--blue": "#6394bf",
      "--magenta": "#d07a9e",
      "--cyan": "#5eaab5",
    },
  },
  {
    label: "tokyo storm",
    vars: {
      "--bg": "#1d2133",
      "--panel": "#24283b",
      "--raise": "#2d3144",
      "--line": "#33374b",
      "--line-strong": "#42475c",
      "--text": "#c0caf5",
      "--muted": "#adb4cf",
      "--faint": "#969cb6",
      "--accent": "#85a4e3",
      "--accent-dim": "rgba(133, 164, 227, 0.12)",
      "--ok": "#a4cb7b",
      "--err": "#e38695",
      "--warn": "#e0af68",
      "--blue": "#80a3ed",
      "--magenta": "#b99eed",
      "--cyan": "#7dcfff",
    },
  },
  {
    label: "macchiato",
    vars: {
      "--bg": "#1d2032",
      "--panel": "#24273a",
      "--raise": "#2d3043",
      "--line": "#33364a",
      "--line-strong": "#42465b",
      "--text": "#cad3f5",
      "--muted": "#acb3ce",
      "--faint": "#949bb5",
      "--accent": "#c2a5e9",
      "--accent-dim": "rgba(194, 165, 233, 0.12)",
      "--ok": "#a6da95",
      "--err": "#e88a98",
      "--warn": "#eed49f",
      "--blue": "#8aadf4",
      "--magenta": "#f5bde6",
      "--cyan": "#8bd5ca",
    },
  },
  {
    label: "material ocean",
    vars: {
      "--bg": "#090b13",
      "--panel": "#0f111a",
      "--raise": "#171922",
      "--line": "#1c1f28",
      "--line-strong": "#2b2d37",
      "--text": "#babed8",
      "--muted": "#959aa9",
      "--faint": "#808492",
      "--accent": "#80cbc4",
      "--accent-dim": "rgba(128, 203, 196, 0.12)",
      "--ok": "#c5e793",
      "--err": "#dd8083",
      "--warn": "#ffcb6b",
      "--blue": "#87abf5",
      "--magenta": "#c396e1",
      "--cyan": "#89ddff",
    },
  },
  //deepseek
  {
    label: "solarized light",
    scheme: "light",
    vars: {
      "--bg": "#f5edd6",
      "--panel": "#fdf6e3",
      "--raise": "#eee5cd",
      "--line": "#e5dbc1",
      "--line-strong": "#c2b89d",
      "--text": "#16353e",
      "--muted": "#40555c",
      "--faint": "#596667",
      "--accent": "#a14d2f",
      "--accent-dim": "rgba(161, 77, 47, 0.1)",
      "--ok": "#5e6b03",
      "--err": "#a34a43",
      "--warn": "#826000",
      "--blue": "#1c6a9b",
      "--magenta": "#99456a",
      "--cyan": "#1d706d",
    },
  },
  {
    label: "latte",
    scheme: "light",
    vars: {
      "--bg": "#f3f6fb",
      "--panel": "#ffffff",
      "--raise": "#eceef4",
      "--line": "#e2e5ea",
      "--line-strong": "#bec1c7",
      "--text": "#383b52",
      "--muted": "#53566b",
      "--faint": "#666876",
      "--accent": "#7158a5",
      "--accent-dim": "rgba(113, 88, 165, 0.1)",
      "--ok": "#3b762f",
      "--err": "#a94e51",
      "--warn": "#905f0b",
      "--blue": "#4369b0",
      "--magenta": "#765dab",
      "--cyan": "#157381",
    },
  },
  {
    label: "paper",
    scheme: "light",
    vars: {
      "--bg": "#f7f6f1",
      "--panel": "#ffffff",
      "--raise": "#f0eee9",
      "--line": "#e6e5df",
      "--line-strong": "#c2c1bb",
      "--text": "#30362c",
      "--muted": "#515a4b",
      "--faint": "#656b5f",
      "--accent": "#586c3c",
      "--accent-dim": "rgba(88, 108, 60, 0.1)",
      "--ok": "#347735",
      "--err": "#a74d44",
      "--warn": "#8a6100",
      "--blue": "#426797",
      "--magenta": "#845b8a",
      "--cyan": "#306f73",
    },
  },
  {
    label: "porcelain",
    scheme: "light",
    vars: {
      "--bg": "#f2f6fb",
      "--panel": "#ffffff",
      "--raise": "#ebeff4",
      "--line": "#e1e5ea",
      "--line-strong": "#bdc1c7",
      "--text": "#28364a",
      "--muted": "#4a586b",
      "--faint": "#5b6b7e",
      "--accent": "#365fa0",
      "--accent-dim": "rgba(54, 95, 160, 0.1)",
      "--ok": "#287452",
      "--err": "#a74d5b",
      "--warn": "#886116",
      "--blue": "#365fa0",
      "--magenta": "#80559f",
      "--cyan": "#247078",
    },
  },
  {
    label: "polar",
    scheme: "light",
    vars: {
      "--bg": "#eaeff7",
      "--panel": "#f6f8fb",
      "--raise": "#e2e8f1",
      "--line": "#d8dee7",
      "--line-strong": "#b5bac4",
      "--text": "#2e3440",
      "--muted": "#495367",
      "--faint": "#5c657a",
      "--accent": "#3f628f",
      "--accent-dim": "rgba(63, 98, 143, 0.1)",
      "--ok": "#466338",
      "--err": "#983e48",
      "--warn": "#7a571a",
      "--blue": "#3d5c85",
      "--magenta": "#6f527c",
      "--cyan": "#29606a",
    },
  },
  {
    label: "sakura",
    scheme: "light",
    vars: {
      "--bg": "#fbecf2",
      "--panel": "#fff8fa",
      "--raise": "#f4e5eb",
      "--line": "#ebdae1",
      "--line-strong": "#c8b7be",
      "--text": "#483741",
      "--muted": "#624f59",
      "--faint": "#74606b",
      "--accent": "#9c435b",
      "--accent-dim": "rgba(156, 67, 91, 0.1)",
      "--ok": "#3c7050",
      "--err": "#9b4254",
      "--warn": "#7d4f0c",
      "--blue": "#3e5c8a",
      "--magenta": "#8a4272",
      "--cyan": "#2c6f74",
    },
  },
];
let theme: Theme = THEMES[0];

/** ANSI and app chrome share a palette. Light themes use ink for bright white. */
const buildTermTheme = () => ({
  background: cssVar("--panel"), // the pane card's own surface, a step up from the ground
  foreground: cssVar("--text"),
  cursor: cssVar("--accent"),
  cursorAccent: cssVar("--bg"),
  selectionBackground: cssVar("--line-strong"),
  selectionForeground: cssVar("--text"),
  black: theme.scheme === "light" ? cssVar("--text") : cssVar("--panel"), // a TUI's "black" fill is the terminal's own ground
  brightBlack: cssVar("--faint"),
  white: cssVar("--muted"),
  brightWhite: cssVar("--text"),
  red: cssVar("--err"), brightRed: cssVar("--err"),
  green: cssVar("--ok"), brightGreen: cssVar("--ok"),
  yellow: cssVar("--warn"), brightYellow: cssVar("--warn"),
  blue: cssVar("--blue"), brightBlue: cssVar("--blue"),
  magenta: cssVar("--magenta"), brightMagenta: cssVar("--magenta"),
  cyan: cssVar("--cyan"), brightCyan: cssVar("--cyan"),
});
/** Memoised per theme: every cssVar is a getComputedStyle, and this ran 18 of
 * them for each pane built or re-themed. */
let termColors: ReturnType<typeof buildTermTheme> | undefined;
const termTheme = () => (termColors ??= buildTermTheme());

function applyTheme(t: Theme) {
  theme = t;
  const root = document.documentElement;
  // Clear first: themes need not define the same keys, and a leftover override
  // from the last one would survive under :root.
  for (const k of THEMES.flatMap((x) => Object.keys(x.vars))) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.scheme ?? "dark";
  root.dataset.scheme = t.scheme ?? "dark"; // light themes get lighter shadows and glass
  termColors = undefined; // the palette moved
  for (const p of threads.flatMap((t) => t.panes)) p.term.options.theme = termTheme();
}

/** A pane as saved: the command it booted with, the claude session it owns,
 * and the session's last-known effort level (hook-reported; resume re-pins it). */
type PaneState = { cmd: string; startupSettings?: { model?: string; effort?: string }; sid?: string; stableId?: string; effort?: string; sessionId?: string; groupIds?: string[]; notify?: "on" | "off"; notifyIds?: string[] };
/** A pane's task notices: every pane's setting (`inherit`), or its own on or off. */
type PaneNotify = "inherit" | "on" | "off";
/** Every pane's task notices, which kinds, and what a pane made from now on starts with. */
let notifyPolicy: { on: boolean; kinds: Record<NotifyKind, boolean>; newPanes: PaneNotify } = { on: true, kinds: { ...DEFAULT_NOTIFY.kinds }, newPanes: "inherit" };

type Startup = { label: string; cmd: string };
const DEFAULT_STARTUPS: Startup[] = [
  { label: "claude", cmd: "claude" },
  { label: "codex", cmd: "codex" },
  { label: "opencode", cmd: "opencode" },
  { label: "opencode2", cmd: "opencode2" },
  { label: "cursor", cmd: "cursor-agent" },
  { label: "grok", cmd: "grok" },
  { label: "powershell", cmd: "" },
  { label: "cmd", cmd: "cmd" },
  { label: "git bash", cmd: '& "$env:ProgramFiles\\Git\\bin\\bash.exe" -i -l' },
];
let startups: Startup[] = [...DEFAULT_STARTUPS];
/** A label is one choice: the + menu's row, the new-thread form's count and loomctl's --agent.
 * The first entry with a label keeps it, as --agent found it before. A later entry under a
 * taken label goes if it repeats a command already there under that label or a number Loom
 * gave it; another command takes the first "label (N)" no entry has in any case, so no label anyone
 * saved changes what it starts and no command is lost. */
function uniqueStartups(list: Startup[]): Startup[] {
  const out: Startup[] = [];
  const taken = new Set(list.map((s) => s.label.toLowerCase())); // --agent ignores case, so a number must too
  for (const s of list) {
    let label = s.label;
    if (out.some((o) => o.label === label)) {
      if (out.some((o) => o.cmd === s.cmd && (o.label === s.label || o.label.replace(/ \(\d+\)$/, "") === s.label))) continue;
      for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${s.label} (${n})`;
      taken.add(label.toLowerCase());
    }
    out.push(label === s.label ? s : { ...s, label });
  }
  return out;
}
/** What a name typed as a new startup starts: one of Loom's own while no entry
 * has its label (powershell, whose empty command is the pane's own shell),
 * else the name run as a command. */
function typedStartup(name: string): Startup {
  const own = DEFAULT_STARTUPS.find((d) => d.label === name.toLowerCase());
  return own && !startups.some((s) => s.label.toLowerCase() === own.label) ? { ...own } : { label: name, cmd: name };
}
/** Cursor's and Grok's hooks report each turn, named by its own id, in order:
 * the reports alone say when a turn runs and ends (agentReport). A question
 * on their screens asks in the turn running (cursorQuestion). Cursor's Esc and
 * Ctrl-C are read off its keys; Grok reports a cancel itself. */
const reportsTurns = (agent: Agent) => agent === "cursor" || agent === "grok";
let fontSize = 13; // Ctrl+= / Ctrl+- / Ctrl+0, global to every pane, persisted
let paneMix: Record<string, number> = Object.create(null); // the new-thread form's panes by startup label, persisted so it keeps your last pick
let soundEnabled = true;
let taskbarEnabled = true;
let keepAwake = false;
let planUsage = true; // Preferences → Plan usage: off = no usage rows and no account API calls; persisted
let speakShown = true; // Preferences → Speak button: the floating mic over the panes; F4 works either way; persisted
const OVERLAY_MODES = ["off", "background", "always"] as const;
type OverlayMode = (typeof OVERLAY_MODES)[number];
let overlayMode: OverlayMode = "off"; // Preferences → Agent overlay; persisted

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${seq++}`;
const basename = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;

/** A line at the bottom right that goes away by itself — for errors that
 * deserve a look but not a modal. */
let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add("hidden"), 6000);
}

/** A line icon from styles.css (`.i-x`, `.i-plus`, …): a mask painted in currentColor. */
const glyph = (name: string) => {
  const i = document.createElement("i");
  i.className = `i i-${name}`;
  return i;
};

/** A small toolbar button. A string label is text; a glyph makes it an icon button. */
function mini(label: string | Node, title: string, fn: () => void) {
  const b = document.createElement("button");
  b.append(label);
  if (typeof label !== "string") b.classList.add("icon");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onmousedown = (e) => e.preventDefault(); // don't steal terminal focus
  b.onclick = (e) => {
    e.stopPropagation();
    fn();
  };
  return b;
}

/** Two-note blip: `from` for the first third, `to` for the rest, under one
 * exponential decay so it reads as a single cue rather than two beeps.
 * ponytail: WebAudio sine instead of shipping audio assets. */
let audio: AudioContext | undefined;
function chime(from: number, to: number, peak = 0.15, len = 0.3) {
  if (!soundEnabled) return; // every sound routes through here: the wake blip and the mic cues
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume(); // no gesture yet on restore
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.setValueAtTime(to, t + len * 0.3);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + len + 0.01);
}
/** Attention blip: a pane wants you. Louder and longer than the mic cues, which
 * answer something you just did and shouldn't carry across the room. */
const beep = () => chime(880, 1320);

/** What a pane's claude session has spent — see src-tauri/src/usage.rs. `ctx` is
 * the live context size, the token counts are the session's running totals. */
type Usage = {
  ctx: number;
  window: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  mainTurns: number;
  sid: string;
  model: string;
  effort: string;
  effortObserved?: boolean;
  /** From the statusline tee: what the pane runs RIGHT NOW, ahead of the
   * transcript — follows a /model typed by hand the moment it runs. "" until
   * the tee has fired. */
  liveModel: string;
  liveEffort: string;
};

/** The context pill: a pane header's gauge, and the overview's copy of it. */
function paintGauge(el: HTMLElement, u: Usage) {
  const pct = Math.min(100, Math.round((u.ctx / u.window) * 100));
  // 90% is about where Claude Code starts compacting on you.
  el.className = `ctx${pct >= 90 ? " hot" : pct >= 70 ? " warm" : ""}`;
  el.style.setProperty("--pct", `${pct}%`);
  el.textContent = `${pct}%`;
  el.title =
    `Context ${tok(u.ctx)} of ${tok(u.window)} — ${pct}% full\n` +
    `${u.turns} turns · ${tok(u.output)} out · ${tok(u.input + u.cacheWrite)} in · ` +
    `${tok(u.cacheRead)} cached`;
}

/** What a pane's context is made of and how it got there — see the `Bucket` doc
 * in src-tauri/src/usage.rs for what the numbers do and don't mean. `series` and
 * `drops` are exact; `buckets` are a 4-chars-a-token estimate of what each origin
 * has produced over the session, which is not the same as what is in the window
 * now — Claude Code prunes what it sends and records nothing about what it cut. */
type Bucket = { label: string; tokens: number };
type Drop = { trigger: string; pre: number; post: number; turn: number };
type Profile = { buckets: Bucket[]; series: number[]; drops: Drop[]; ctx: number; est: number };

/** The pane whose profile the usage panel is showing, and its answer. Both are
 * cleared when the panel opens and the answer lands a moment later — reading a
 * whole transcript is not something to do on the 4s poll. */
let profilePane: Pane | null = null;
let profile: Profile | null = null;

/** The models this account can use, straight from the API — a model Anthropic
 * adds appears here on its own. Null until the fetch lands; MODELS is the
 * offline fallback, the CLI's own alias list. `/effort`'s levels are a fixed
 * vocabulary of the CLI, so they stay a list. Both settings are session-scoped:
 * Claude Code applies them to the running conversation and does not persist. */
type ModelOpt = { value: string; label: string; maxInput: number; maxOutput: number };
let models: ModelOpt[] | null = null;
const MODELS = ["opus[1m]", "sonnet[1m]", "fable[1m]", "haiku", "default"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"];

/** One row per family — newest only — and the big window wherever the model has
 * one. Family is the word after "claude-" in the id, and the API answers newest
 * first, so the first of each family is the current one; a new family or a new
 * version of an old one lands here on its own. `[1m]` is how Claude Code opts
 * into the larger window, and `maxInput` is what says a model has one, so no
 * per-model knowledge is needed. */
function modelRows(): { value: string; label: string; detail: string }[] {
  if (!models?.length) return MODELS.map((v) => ({ value: v, label: v, detail: "" }));
  const rows = [{ value: "default", label: "Default", detail: "" }];
  const seen = new Set<string>();
  for (const m of models) {
    const family = m.value.replace(/^claude-/, "").split("-")[0];
    if (seen.has(family)) continue;
    seen.add(family);
    const big = m.maxInput > 200_000;
    rows.push({
      value: big ? `${m.value}[1m]` : m.value,
      label: m.label.replace(/^Claude /, ""), // "Claude Fable 5" → "Fable 5"
      detail: tok(big ? m.maxInput : 200_000),
    });
  }
  return rows;
}

/** A setting the config panel applied, and the main-thread turn count it was
 * applied at. It stands until a turn past that reports one of its own. `was` is
 * set when the command went into a running turn's queue: that turn keeps
 * writing records under the old setting, so the stamp also holds until the
 * transcript moves off what it reported at send time. */
type Set_ = { v: string; at: number; was?: string };

/** 48604 → "49k", 1000000 → "1M", 1600000 → "1.6M". Header space is a few
 * characters wide, and a round million reads badly as "1.0M". */
const tok = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(n);

/** The account's plan limits — the same numbers Claude Code's own /usage panel
 * shows. `label` arrives as the API's `kind`, except a model-scoped limit which
 * already carries its model's name. See src-tauri/src/usage.rs. */
type Limit = { label: string; group: string; percent: number; severity: string; resetsAt: string | null };
/** `stale` = read off a statusline payload because the endpoint wouldn't answer,
 * so it carries the two account-wide windows and nothing else. */
type Plan = { tier: string; limits: Limit[]; stale: boolean; bankedResets?: number; bankedResetExpiries?: (string | null)[]; note?: string; retryAfterSeconds?: number };
type PlanProvider = "claude" | "codex";
const PLAN_PROVIDERS = {
  claude: { name: "Claude", button: "plan", command: "plan_usage", url: "https://claude.ai/settings/usage" },
  codex: { name: "Codex", button: "codex-plan", command: "codex_plan_usage", url: "https://chatgpt.com/codex/settings/usage" },
};
const plans: Partial<Record<PlanProvider, Plan>> = {};
const planErrors: Partial<Record<PlanProvider, string>> = {};
/** When the numbers on screen arrived. A failed refresh leaves it alone. */
const planFetchedAt: Partial<Record<PlanProvider, number>> = {};

const TIERS: Record<string, string> = {
  default_claude_max_5x: "Max (5x)",
  default_claude_max_20x: "Max (20x)",
  default_claude_pro: "Pro",
  default_claude_free: "Free",
  free: "Free", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise",
};
const KIND_LABELS: Record<string, string> = { session: "Current session", weekly_all: "All models" };

/** "Resets in 4 hr 8 min", the way the desktop app words it. Rounded to the
 * minute before formatting a date: the API answers …T00:59:59Z where the app
 * says 1:00 AM. */
// The API sends a date string, the statusline payload unix seconds (usage.rs
// falls back to it when the endpoint 429s) — no ISO parses to 0, so one `||`
// takes both. 0 = no usable time.
function resetMs(iso: string | null) {
  if (!iso) return 0;
  const at = Date.parse(iso) || Number(iso) * 1000;
  return Number.isNaN(at) ? 0 : at;
}

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
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `Resets ${day} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** The pane under a viewport point. Both drags need it: a header swap runs on
 * mouse events, and a file drop arrives from the OS with a position and no
 * element of its own. */
function paneAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y)?.closest(".pane");
  if (dashboardPreviewPane?.el === el) return dashboardPreviewPane;
  return current?.panes.find((p) => p.el === el) ?? null;
}

const MIC_TIP = "Dictate into the focused agent pane — click, or hold F4";
const MIC_OFF = "Dictation needs a pane with an agent running";
const MIC_LABEL = { "": "Speak", rec: "Listening", busy: "Transcribing", err: "Mic error" };
/** Typed into the pane the moment recording starts, so the dictation arrives as
 * an argument to a slash command instead of a bare message. `enter` submits the
 * finished transcript for you; without it you get a chance to fix a word. */
type Prefix = { text: string; enter: boolean };
let prefixes: Prefix[] = [
  { text: "/prompt ", enter: false },
  { text: "", enter: false },
];
let prefix: Prefix = prefixes[0];

/** What whisper transcribes as. `""` detects per clip — a touch slower, and it
 * can hear an accent as another language, which is why English leads. The menu's
 * input takes any other code whisper knows ("ja", "ko", "hi", "nl"), so this is
 * a starting set rather than the limit. */
type Lang = { label: string; code: string };
let langs: Lang[] = [
  { label: "English", code: "en" },
  { label: "auto", code: "" },
  { label: "French", code: "fr" },
  { label: "Arabic", code: "ar" },
  { label: "Spanish", code: "es" },
  { label: "German", code: "de" },
];
let lang: Lang = langs[0];

/** The running recording: which pane it belongs to, and the prefix and language
 * it opened with — swapping either mid-sentence must not change how this one
 * ends. */
/** `gen` and `seq`: the launch it records for, and the input count once the
 * prefix went in, so a transcript never lands in a restarted pane. */
let recording: { pane: Pane; prefix: Prefix; lang: Lang; gen: number; seq: number } | null = null;
/** Start and stop run one at a time: a push-to-talk tap outruns the IPC round
 * trip, and a stop dropped for being "too early" leaves the mic open for good. */
let micChain: Promise<void> = Promise.resolve();
const mic = (step: () => Promise<void>) => (micChain = micChain.then(step));

/** The open-mic overlay. Bar heights are the mic's own peak, so it moves while
 * you talk and lies flat while you don't — an animation on a loop would say
 * "recording" just as convincingly with the mic muted. */
const WAVE_BARS = 28;
let waveTimer: number | undefined;
let wavePhase = 0;

function waveShow(on: boolean) {
  if (on === !!waveTimer) return; // micState repaints on every buffer change
  const el = $("#wave");
  el.classList.toggle("hidden", !on);
  if (!on) {
    clearInterval(waveTimer);
    waveTimer = undefined;
    return;
  }
  if (!el.childElementCount)
    el.append(...Array.from({ length: WAVE_BARS }, () => document.createElement("i")));
  const bars = [...el.children] as HTMLElement[];
  waveTimer = setInterval(async () => {
    const lvl = await invoke<number>("dictate_level").catch(() => 0);
    // Speech peaks around 0.2–0.6 and a quiet room near 0.02: linear leaves the
    // wave flat for everything short of a shout.
    const amp = Math.min(1, Math.sqrt(lvl) * 1.3);
    wavePhase += 0.45;
    bars.forEach((b, i) => {
      const bell = Math.sin(((i + 0.5) / WAVE_BARS) * Math.PI); // taper to the ends
      const ripple = 0.55 + 0.45 * Math.sin(wavePhase - i * 0.5); // travels outward
      b.style.transform = `scaleY(${(0.05 + 0.95 * amp * bell * ripple).toFixed(3)})`;
    });
  }, 60);
}

let micUi: keyof typeof MIC_LABEL = "";
let micErrTimer = 0;
function micState(s = micUi, msg = "") {
  micUi = s;
  // A stale "⚠ mic" from an hour ago reads as currently broken: revert on its own.
  clearTimeout(micErrTimer);
  if (s === "err") micErrTimer = window.setTimeout(() => micUi === "err" && micState(""), 5000);
  waveShow(s === "rec"); // every start/stop path lands here — F4, button, blur, close
  const b = $<HTMLButtonElement>("#dictate");
  const ready = !dashboardOpen && !!current?.active?.agentUp;
  b.className = s;
  b.querySelector(".lbl")!.textContent = MIC_LABEL[s];
  b.disabled = !s && !ready; // a running recording keeps its stop button either way
  b.title = msg || (ready || s ? MIC_TIP : MIC_OFF);
}
/** The focused pane changed, or claude came up / exited in it. */
const micRefresh = () => micState();

async function micStart() {
  const pane = current?.active;
  if (dashboardOpen || recording || !pane?.agentUp) return;
  // A config command is being typed into a pane right now — a dictation prefix
  // pasted into the middle of it mangles both. Clears on the next press.
  if (cfgBusy) return micState("err", "model/effort change in progress — try again");
  // The launch you began dictating to, before the microphone takes its time to open.
  const gen = pane.generation;
  try {
    await invoke("dictate_start");
    if (changed(pane, gen)) {
      // Restarted, stopped or closed meanwhile: close the microphone, and what it caught goes nowhere.
      await invoke("dictate_stop", { lang: null }).catch(() => "");
      return micState("err", `${pane.agent} ${changed(pane, gen)} while the microphone opened — try again`);
    }
    if (prefix.text) pane.term.paste(prefix.text);
    recording = { pane, prefix, lang, gen, seq: pane.inputSeq };
    micState("rec");
    chime(660, 990, 0.09, 0.18); // rising: mic open
  } catch (e) {
    micState("err", String(e));
  }
}

async function micStop() {
  const r = recording;
  if (!r) return;
  const { pane: p, prefix: pre, gen } = r;
  // null, not "": whisper takes Option<&str> and None is what means "detect".
  const code = r.lang.code || null;
  recording = null;
  micState("busy");
  chime(990, 660, 0.08, 0.18); // falling: mic closed
  try {
    const text = await invoke<string>("dictate_stop", { lang: code });
    micState("");
    // Restarted, stopped or closed while whisper ran: the text was for a process that's gone.
    const offer = (why: string) => {
      if (text) void navigator.clipboard.writeText(text).catch(() => {});
      toast(`${p.agent} ${why} while you dictated, so nothing was typed.${text ? " The dictation is on the clipboard." : ""}`);
    };
    if (changed(p, gen)) return offer(changed(p, gen));
    if (text && !pre.enter) p.term.paste(text); // not pty_write: paste honors bracketed-paste mode
    else if (text) {
      // In the pane's input turn: a loomctl send waiting on its echo would
      // otherwise take this Enter, and this text would go with its own. A
      // question that came up while whisper ran ignores the paste, and Enter
      // would answer it.
      const asking = () => !!readMenu(liveScreen(p, false), p.agent);
      const entered = await inTurn(p, async (live) => {
        if (asking()) return false;
        p.term.paste(text);
        // Codex reads an Enter that lands right behind pasted text as part of
        // the paste (a newline in the composer), so let the input settle first.
        await p.settle(150, 1000);
        live(true);
        if (asking()) return false;
        const mark = manualEnter(p);
        p.typed = null;
        const release = holdForEnter(p, mark);
        p.inputSeq++;
        void invoke("pty_write", { id: p.id, data: "\r" }).then(release, (e) => {
          if (mark) manualFailed(mark);
          release();
          toast(`Could not write to ${p.agent}: ${String(e)}`);
        });
        return true;
      }, gen).catch((e) => {
        if (e instanceof NotSubmitted && changed(p, gen)) return void offer(changed(p, gen));
        throw e;
      });
      if (entered === undefined) return; // gone meanwhile: offered
      if (!entered) {
        void navigator.clipboard.writeText(text).catch(() => {});
        toast(`${p.agent} is asking a question, so Loom didn't press Enter. The dictation is on the clipboard.`);
      }
    } else if (pre.text && p.inputSeq === r.seq) {
      // A mis-tapped F4 with nothing said: take the prefix back out instead of
      // leaving a bare "/prompt " in the input. Backspaces have to go raw — a
      // DEL inside a bracketed paste is literal text, not a keypress. Only
      // when nothing went in since: they would eat that instead.
      p.inputSeq++;
      invoke("pty_write", { id: p.id, data: "\x7f".repeat(pre.text.length) });
    }
    p.th.focusPane(p);
  } catch (e) {
    micState("err", String(e));
  }
}

type LayoutMode = "grid" | "rows" | "cols";
const LAYOUTS: LayoutMode[] = ["grid", "rows", "cols"];
const LAYOUT_LABEL: Record<LayoutMode, string> = { grid: "grid", rows: "rows", cols: "cols" };
/** The layout button: the shape it is in, as an icon and a word. */
function paintLayout(mode: LayoutMode) {
  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = LAYOUT_LABEL[mode];
  $("#layout").replaceChildren(glyph(`layout-${mode}`), label);
}

/** Panes holding a WebGL context, least recently shown first. See Pane.gpu(). */
const GL_BUDGET = 12;
const glLive: Pane[] = [];

// Restored claude panes boot BOOTS at a time. A claude start is CPU-heavy, and ten
// at once starve each other: a function-hooks plugin gets 10s to load and misses
// it ("hooks module did not load: not loaded within 10000ms"). A slot frees when
// the pane's SessionStart marker lands, or after 15s so a stuck boot can't stall
// the rest. `first`: the thread on screen, which waits at the front of the queue.
const BOOTS = 2;
let booting = 0;
const bootWaiting: (() => void)[] = [];
async function bootSlot(first: boolean): Promise<() => void> {
  while (booting >= BOOTS) await new Promise<void>((r) => first ? bootWaiting.unshift(r) : bootWaiting.push(r));
  booting++;
  return () => {
    booting--;
    bootWaiting.shift()?.();
  };
}
/** The name this launch's Claude markers go under (helper.rs `marker_name`):
 * a replaced launch's transcript and status never read as its replacement's. */
const claudeMarker = (p: Pane, launch = p.launched) => `${p.id}.${launch}`;
async function booted(pane: string) {
  for (let i = 0; i < 60; i++) {
    if (await invoke<boolean>("pane_booted", { pane }).catch(() => true)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

class Pane {
  readonly id = uid();
  groupIds: string[] = [];
  readonly el = document.createElement("div");
  readonly term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize,
    lineHeight: 1.25,
    scrollback: 5000,
    cursorBlink: loomFocused, // readFocus keeps it in step
    allowProposedApi: true, // parser.registerOscHandler
    theme: termTheme(),
  });
  private _busy = false;
  /** From spawn until the process prints something visible. A restored claude
   * pane can wait its turn for a boot slot this long. */
  starting = true;
  busySince = 0; // when this stretch of work began, for the overview's "Working · 12m"
  /** When the latest stretch of output began (activity), shown as work or not:
   * under an unread alert it isn't, yet a turn Claude began by itself started
   * there (agentTurn). 0 from when a task of the pane ends (moveTask) until
   * the next output, which begins the next stretch however soon it comes. */
  workSince = 0;
  private workAt = 0; // that stretch's last output
  quietSince = Date.now(); // when it last stopped working (or was made), for "Idle · 5m"
  get busy() { return this._busy; }
  set busy(on: boolean) {
    if (on && !this._busy) this.busySince = Date.now();
    if (!on && this._busy) this.quietSince = Date.now();
    this._busy = on;
  }
  waiting = false; // the agent rang: turn finished / wants input
  waitingSince = 0;
  /** Claude was seen idle at its input since its alert rose (activity). */
  private alertIdle = false;
  private _dead = false;
  exitedAt = 0;
  /** The process exited; Enter relaunches it. */
  get dead() { return this._dead; }
  set dead(on: boolean) {
    if (on && !this._dead) this.exitedAt = Date.now();
    this._dead = on;
  }
  appTitle = ""; // OSC 0/2 from the running app
  codexThread = ""; // the thread id codex titles its pane with (agent.ts: codexTitle)
  /** Codex's run state, from its title (agent.ts codexTitle): Working,
   * Thinking or Waiting while a turn runs, whether or not its status row
   * shows. Unset until this launch titles one, as a Codex older than
   * run-state never does: then its "esc to interrupt" alone says busy. */
  codexState: string | undefined;
  /** Codex asked (an approval or a question, OSC 9) and no answer went in
   * since. Its title says Working all through one, but nothing runs. */
  codexAsking = false;
  /** Whether a Cursor turn runs, as its hooks' reports say, in order: from a
   * turn's start to its stop (agentReport, cursorRuns). Unset until this
   * launch's first, as when Loom couldn't add its hooks: then its "ctrl+c to
   * stop" alone says busy. */
  cursorTurn: boolean | undefined;
  /** Grok's last Stop, held until Grok's session log says how its turn ended
   * (grokSettle): a Stop hook that blocks sends Grok on under the same
   * prompt, and its hooks can't tell that Stop from the last (stopHookActive
   * is true for both). */
  grokStop: GrokStop | undefined;
  grokTimer = 0;
  /** Every read of Grok's session log grokOver started, done once all are: closing waits for them (closeTasks). */
  grokReads: Promise<unknown> = Promise.resolve();
  /** Cursor's turns by their generation_id, which its hooks name: the one
   * whose start came last (cursorGen), and each one an Esc or Ctrl-C went
   * into, with when (cursorEsc), kept until its first stop counts
   * (agentReport). Its error written after that Esc is the interrupt, and
   * one written before is a failure of its own. cursorEscs: when each Esc or
   * Ctrl-C that answered no question went in, oldest first. A turn Loom
   * hears of later takes the first one after its start (its report says
   * when) as its own. */
  cursorGen: string | undefined;
  cursorEsc = new Map<string, number>();
  cursorEscs: number[] = [];
  /** Cursor shows a question (an approval, trusting its folder), read off the
   * screen: no hook reports one. Raised once per question (cursorQuestion). */
  cursorAsking = false;
  /** The question an answer went to (menuRev), still drawn until Cursor
   * redraws: not asked again. */
  private cursorAnswered: string | undefined;
  /** Cursor asks for rejection feedback, after an approval's "Skip & tell the
   * agent what to do instead" (readFeedback). Its Ctrl-C skips the feedback
   * and its Esc goes back to the approval, and the turn goes on (answers,
   * wrote). Text typed there hides its placeholder, so it holds until Cursor
   * draws its follow-up composer or a question, or a Ctrl-C goes in. */
  private cursorFeedback = false;
  /** What OMP last said of itself (OSC 7501, programStatus): working,
   * blocked, done, error or idle. Unset until this launch says one, and again
   * once OMP quits (clear) and its shell's prompt has the pane. */
  programState: string | undefined;
  label = ""; // appTitle as shown: spinner stripped, a name when there is none
  /** Where it was when it left its thread (keepContext). Every copy after is this one, last known. */
  left?: TaskContext;
  startup = ""; // command this pane booted with, persisted for restore
  agent: Agent = "shell"; // what `startup` runs, see agent.ts
  sid = ""; // and the claude session it owns, so the next launch resumes it
  startupSettings?: { model?: string; effort?: string };
  providerUsage: Usage | null = null;
  sessionId?: string; // Provider-reported ID, never a generated placeholder.
  effort = ""; // session's effort per the last hook, "" until one reports
  usage: Usage | null = null; // null until claude is up in this pane; zeroed until its first turn
  lastOut = 0; // when the pty last drew anything, for settle()
  lastIn = 0; // when you last typed, so an echo doesn't read as the agent working
  /** Every write of input to the process: typing, pastes, dictation, loomctl.
   * Part of the input revision send --input checks, so any writer in between
   * is noticed even before the screen shows what it wrote. */
  inputSeq = 0;
  /** Its task notices: every pane's setting, or its own on or off (notifyPolicy). */
  notify: PaneNotify = "inherit";
  /** Runtime ids of this saved pane, including launches from earlier Loom runs. */
  notifyIds: string[] = [this.id];
  /** This pane's own id across restarts, where `id` is new each start: saved with it and restored only into it. */
  stableId: string = crypto.randomUUID();
  /** Its state as `watch --panes`, `wait --until` and webhooks hear it: what paint() shows, once it stood 2 s. */
  readonly settler = new Settler((old, state, since) => paneEvent(this, old, state, since), SETTLE_MS, () => cliState(this));
  /** Enters a person gave it in Loom's window that may have sent a prompt no
   * task holds yet (manualEnter), oldest first. Never their text. */
  manual: ManualEnter[] = [];
  /** The launch something was typed or pasted into in Loom's window since
   * its last Enter, or null: what was typed is never kept. Where Loom can't
   * read the input (OpenCode, say), it is the only sign an Enter sent
   * anything, and only in that launch: a draft left in a process that was
   * relaunched since is no sign for the new one (review 2026-10-03 19:10). */
  typed: number | null = null;
  /** DECTCEM: the app hid the terminal cursor (Claude draws its own caret). */
  cursorHidden = false;
  /** What the config panel last set, each stamped with the turn count at the
   * time. `/model` and `/effort` change nothing the transcript records until the
   * next turn runs, so these are what the panel shows meanwhile. Stamped one by
   * one: setting the effort says nothing about the model, and must not discard
   * what was chosen for it. */
  want: { model?: Set_; effort?: Set_ } | null = null;
  readonly search = new SearchAddon();

  private fit = new FitAddon();
  private observer = new ResizeObserver(() => this.resize());
  private gl?: WebglAddon;
  private host = document.createElement("div");
  private title = document.createElement("span");
  private stateTag = document.createElement("span");
  private gauge = document.createElement("span");
  private cfg: HTMLButtonElement;
  /** Its task notices at a glance, and the way to change them (notifyMenu). */
  readonly bell: HTMLButtonElement;
  private unlisten: UnlistenFn[] = [];
  private out = new Channel<string>();
  private idle = 0;
  private disposed = false;
  private opencodeStatus = false; // Plugin events take precedence over the TUI footer.
  private resumeNotice?: HTMLElement;
  private startupOutput = "";
  private startupRetry = false;
  private spawnResume = false;
  exitCode?: number;
  private startupStarted = 0;
  /** This pane's own row under its thread in the sidebar — Orca lists each
   * agent session under its worktree, and a thread with a claude and a codex
   * in it wants both visible at a glance. */
  readonly row = document.createElement("button");
  private rowLabel = document.createElement("span");
  private rowName = document.createElement("strong");
  private rowState = document.createElement("small");
  /** The pane as one mark on its thread's folded row: provider icon, state
   * ring, one click to open it. Owned here so painting a pane touches only
   * its own nodes, whatever the sidebar holds. A mouse shortcut only: the
   * agent rows and Ctrl+K reach the same pane from the keyboard. */
  readonly pip = document.createElement("span");
  /** Provider mark in the header, the sidebar row and the pip; swapped in
   * start() once the agent is known. */
  private ico: SVGSVGElement = icon("shell");
  private rowIco: SVGSVGElement = icon("shell");
  private pipIco: SVGSVGElement = icon("shell");

  constructor(readonly th: Thread) {
    this.el.className = "pane";
    this.el.dataset.id = this.id; // for driving a pane from devtools
    this.row.className = "agent";
    this.row.onclick = (e) => {
      e.stopPropagation(); // the thread row behind it would only re-show
      revealPane(this);
    };
    this.pip.className = "pip";
    this.pip.setAttribute("aria-hidden", "true");
    this.pip.append(this.pipIco);
    this.pip.onclick = (e) => {
      e.stopPropagation();
      revealPane(this);
    };
    const copy = document.createElement("span");
    copy.className = "agent-copy";
    this.rowName.className = "agent-name";
    this.rowLabel.className = "agent-title";
    this.rowState.className = "agent-state";
    // The working spinner: its ten frames, one per line, stepped by syncSpin's clock (styles.css).
    const spin = document.createElement("span");
    spin.className = "agent-spin";
    spin.setAttribute("aria-hidden", "true");
    spin.append(Object.assign(document.createElement("span"), { textContent: "⠋\n⠙\n⠹\n⠸\n⠼\n⠴\n⠦\n⠧\n⠇\n⠏" }));
    copy.append(this.rowName, spin, this.rowLabel);
    this.row.append(this.rowIco, copy, this.rowState);
    this.host.className = "pane-term";
    this.title.className = "pane-title";
    this.stateTag.className = "pane-state";
    this.gauge.className = "ctx hidden";
    this.gauge.onmousedown = (e) => e.preventDefault(); // don't steal terminal focus
    this.gauge.onclick = (e) => {
      e.stopPropagation();
      showMenu(this.gauge, usageMenu);
      // showMenu toggles, so a second click on the same gauge closes the panel —
      // only read the transcript when it actually opened.
      if (!menu.classList.contains("hidden")) loadProfile(this);
    };
    this.cfg = mini(glyph("sliders"), "Model and effort for this pane", () => {
      if (cfgPane !== this) (cfgNote = ""), (cfgDone = null); // another pane's verdict isn't this one's
      cfgPane = this; // the dropdowns hold the rest of the state
      showMenu(this.cfg, configMenu);
    });
    this.cfg.classList.add("cfg", "hidden"); // until start() knows this pane runs claude
    this.bell = mini(glyph("bell"), "Task notices", () => showMenu(this.bell, notifyMenu(this)));
    this.bell.classList.add("notify");
    const head = document.createElement("div");
    head.className = "pane-head";
    const actions = document.createElement("div");
    actions.className = "pane-actions";
    actions.append(
      this.bell,
      this.cfg,
      mini(glyph("maximize"), "Zoom (F2)", () => this.th.toggleZoom(this)),
      mini(glyph("x"), "Close pane", () => this.th.closePane(this)),
    );
    head.append(this.ico, this.title, this.stateTag, this.gauge, actions);
    this.el.append(head, this.host);
    this.el.addEventListener("mousedown", () => this.th.focusPane(this));
    this.term.attachCustomKeyEventHandler((e) => {
      // Codex runs inline: its history belongs to xterm, so page keys must
      // move that buffer. Full-screen views and modified keys stay agent input.
      if (e.type === "keydown" && this.agent === "codex" && this.term.buffer.active.type === "normal" &&
          !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && (e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        this.term.scrollPages(e.key === "PageUp" ? -1 : 1);
        return false;
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.key.toLowerCase() !== "c" || !this.term.hasSelection()) return true;
      e.preventDefault();
      void this.copySelection();
      return false;
    });
    // The right button is Loom's in every pane, even mouse-reporting TUIs:
    // capture phase, so xterm never reports the click to the pty. Claude Code
    // would otherwise paste on it too and double the text; opencode reports
    // it and does nothing, which left it with no paste at all.
    this.host.addEventListener("mousedown", (e) => {
      if (e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      this.th.focusPane(this);
    }, true);
    // Any-motion mouse tracking (opencode) reports every mouse move to the
    // pty as input, and xterm drops the selection on any input — so a
    // Shift-drag selection was gone before the mouse reached the copy click.
    // Hold plain motion back while a selection stands; a click or key still ends it.
    this.host.addEventListener("mousemove", (e) => {
      if (!e.buttons && this.term.modes.mouseTrackingMode === "any" && this.term.hasSelection()) e.stopPropagation();
    }, true);
    // Right-click = paste, like a real terminal — no context menu. With a
    // selection it copies instead (and clears it), so copy stays one click too.
    this.host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.term.hasSelection()) return void this.copySelection();
      navigator.clipboard.readText().then((t) => t && this.term.paste(t)).catch((e) => toast(`Could not paste: ${e}`));
    }, true);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri).catch(() => {})));
    // Only images are clickable file paths. Web links still take precedence.
    this.term.registerLinkProvider({
      provideLinks: (y, cb) => {
        cb(
          fileLinks(this.term.buffer.active, y, this.term.cols).filter(link => imageMime(link.text.replace(/:\d+(?::\d+)?$/, ""))).map((link) => ({
            ...link,
            activate: async () => {
              try {
                const target = /^~[\\/]/.test(link.text) ? await join(await homeDir(), link.text.slice(2)) : link.text;
                const path = target.replace(/:\d+(?::\d+)?$/, "");
                openTab(this.th, basename(path), { file: path });
              } catch (e) { toast(String(e)); }
            },
          })),
        );
      },
    });

    // Drag the header onto another pane to swap places (aa's F6 "move"). Mouse
    // events, not HTML5 drag: dragDropEnabled gives the OS drag to the native
    // side so file drops carry real paths, and on Windows that costs the page
    // its dragstart. The pointer is all that is left.
    head.addEventListener("mousedown", (e) => {
      if (e.button || (e.target as HTMLElement).closest("button")) return;
      const from = { x: e.clientX, y: e.clientY };
      let dragging = false;
      const move = (m: MouseEvent) => {
        // A wobble while clicking a header is not a drag.
        if (!dragging && Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < 6) return;
        dragging = true;
        const over = paneAt(m.clientX, m.clientY);
        for (const p of this.th.panes) p.el.classList.toggle("drop", p === over && p !== this);
      };
      const up = (u: MouseEvent) => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        for (const p of this.th.panes) p.el.classList.remove("drop");
        const to = dragging && paneAt(u.clientX, u.clientY);
        if (to) this.th.swap(this, to); // swap() no-ops on the pane you started from
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    head.addEventListener("dblclick", () => this.th.toggleZoom(this));
  }

  private async copySelection() {
    const text = this.term.getSelection();
    try {
      await navigator.clipboard.writeText(text);
      if (this.term.getSelection() === text) this.term.clearSelection();
    } catch (e) {
      toast(`Could not copy: ${e}`);
    }
  }

  /** `sid` given = this pane is being restored, so resume that session. */
  async start(startup: string, sid?: string) {
    this.startup = startup;
    this.agent = agentOf(startup);
    for (const k of ["ico", "rowIco", "pipIco"] as const) {
      const fresh = icon(this.agent);
      this[k].replaceWith(fresh);
      this[k] = fresh;
    }
    this.sid = sid ?? crypto.randomUUID();
    this.cfg.classList.toggle("hidden", !this.isClaude); // nothing to configure in a shell
    this.paint(); // the sidebar shows restored panes still waiting for a boot slot
    // Bound history per pane. Inline agents such as Codex use this scrollback;
    // alternate-screen agents keep their transcript themselves.
    this.term.options.scrollback = this.agent === "shell" ? 5000 : 1500;
    this.term.open(this.host);
    // WebGL from the start, hidden or not (the budget in gpu() still caps it).
    // A hidden pane on the DOM renderer re-renders every row on every scroll
    // (xterm's selection refresh bypasses its render pause) and, with no width
    // to measure in display:none, caches nothing — 8 restored agent panes
    // streaming in the background ate ~90% of the main thread; on WebGL, ~20%.
    this.gpu(true);
    this.term.onTitleChange((t) => {
      const codex = this.agent === "codex" ? codexTitle(t) : undefined;
      if (codex) {
        if (codex.thread) this.codexThread = codex.thread; // an id and a state, not a name to show
        this.codexState = codex.state;
        return;
      }
      // Agents redraw the title with a spinner glyph while working, ~10 times a
      // second; paint() strips it, so those are the same title — skip them.
      const same = t.replace(SPIN, "") === this.appTitle.replace(SPIN, "");
      this.appTitle = t;
      if (!same) this.paint();
    });
    this.term.onData((d) => {
      // A dead pane has nowhere to send keys; Enter brings the process back.
      if (this.dead) return void (d === "\r" && this.spawn(true));
      // Focus reports (ConPTY turns them on) are the page losing or gaining
      // focus, not you answering: pass them on, leave the alert alone.
      if (d === "\x1b[I" || d === "\x1b[O") return void invoke("pty_write", { id: this.id, data: d }).catch(() => {});
      // So are the pointer moving or the wheel turning over a program that
      // tracks the mouse (OpenCode): a click is someone acting, these aren't.
      const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(d)?.[1] ?? (/^\x1b\[M[\s\S]{3}$/.test(d) ? d.charCodeAt(3) - 32 : undefined);
      if (mouse !== undefined && Number(mouse) & 96) return void invoke("pty_write", { id: this.id, data: d }).catch(() => {});
      this.lastIn = Date.now();
      // Read before the Enter goes in: the input still holds what it sends.
      const mark = d === "\r" ? manualEnter(this) : undefined;
      // Keys and pastes, never escape sequences (arrows, mouse reports), count
      // as typing; Enter, Ctrl+C and Ctrl+U leave the input empty.
      if (d === "\r" || d === "\x03" || d === "\x15") this.typed = null;
      else if (!d.startsWith("\x1b") || d.startsWith("\x1b[200~")) this.typed = this.generation;
      const release = holdForEnter(this, mark);
      this.inputSeq++;
      this.usePrompt(d);
      const waitingSince = this.waitingSince, sent = this.sending(d);
      void invoke<number>("pty_write", { id: this.id, data: d }).then((began) => {
        this.wrote(d, true, sent, began || undefined);
        release();
        // A failed write must leave the attention signal intact, and so must
        // one to a launch since replaced.
        if (this.generation !== sent.gen) return;
        if (this.waitingSince === waitingSince) this.seen();
        if (d === "\x1b" && this.agent === "codex" && this.busy) ((this.busy = false), this.paint());
      }, e => {
        if (mark) manualFailed(mark);
        release();
        this.wrote(d, false, sent);
        toast(`Could not write to ${this.agent}: ${String(e)}`);
      });
    });
    this.term.parser.registerOscHandler(133, (d) => (this.mark(d), true));
    // Watched, not handled: false lets xterm show or hide the cursor itself.
    for (const final of ["h", "l"]) this.term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      if (params.includes(25)) this.cursorHidden = final === "l";
      return false;
    });
    // Codex reports a finished turn (and an approval prompt) as OSC 9 — see
    // CODEX_FLAGS in agent.ts. OSC 99 is the kitty notification opentui TUIs
    // use; "p=?" there is a capability probe, not news.
    this.term.parser.registerOscHandler(9, (d) => {
      if (this.agent === "codex") this.codexAsking = codexAsks(d);
      if (this.codexAsking) taskSignal(this, { kind: "approval", at: Date.now(), detail: d.slice(0, 200) });
      this.wake(undefined, "osc9");
      return true;
    });
    this.term.parser.registerOscHandler(99, (d) => (d.includes("p=?") || this.wake(undefined, "osc99"), true));
    this.term.parser.registerOscHandler(7501, (d) => (this.programStatus(d), true));
    // Claude rings BEL when a turn finishes (Stop hook / idle prompt).
    this.term.onBell(() => this.wake(undefined, "bell"));
    this.fit.fit();

    // An exit names its launch: one queued for a process a relaunch replaced isn't this one's.
    const unlisten = await listen<number | { code: number; launch: number | null }>(`pty-exit:${this.id}`, ({ payload: p }) => {
      if (typeof p === "number") return this.exited(p);
      if (p.launch === null || p.launch === this.launched) this.exited(p.code);
    });
    if (this.disposed) { unlisten(); return; }
    this.unlisten.push(unlisten);
    // Channel, not an event: stdout is the hot path and channels skip the
    // event bus' JSON round-trip through every other listener.
    await this.spawn(!!sid);
    if (!this.disposed) this.observer.observe(this.host);
  }

  /** The process is gone: say so, and let Enter bring it back. Once per launch. */
  exited(code: number, how = `exited ${code}`) {
    if (this.dead) return;
    this.dead = true;
    this.exitCode = code;
    this.busy = false;
    this.waiting = false;
    this.term.write(`\r\n\x1b[90m[${how}] — Enter relaunches\x1b[0m\r\n`);
    this.paint();
    this.retryCodexStartup();
  }

  /** Ends the process and keeps the pane. pty_kill takes the session out of
   * the map before killing it, so no pty-exit follows: the exit is marked here.
   * It names the process that runs: a launch still starting gives up, and
   * kills what it started (see spawn). */
  async stop() {
    const gen = ++this.launchGen;
    this.settler.stop(); // what was settling belongs to the launch this ends
    await invoke("pty_kill", { id: this.id, launch: this.installed });
    // A launch that began while the kill was in flight is the pane now: it stays up.
    if (gen === this.launchGen) this.exited(1, "stopped");
  }

  /** Start (or restart) the pane's process. `resume` = pick the session up
   * where it was. For claude that means `--resume`, which exits on an id that
   * was never written to — a pane opened and never used — so the transcript
   * is checked first and a fresh `--session-id` boot takes over. A codex or
   * opencode pane with no reported session yet (made before Loom captured one)
   * asks once instead of guessing.
   *
   * True once the process runs, else why it doesn't. Launches take turns, and
   * each carries a generation that a newer launch or stop() bumps: one that
   * falls behind while awaiting the session check, a boot slot or pty_spawn
   * gives up, and kills a process it already started before the next launch
   * may begin. pty_spawn replaces a pane's session by id, so two in flight
   * could leave the wrong one running. */
  async spawn(resume: boolean, retry = false): Promise<true | string> {
    if (shuttingDown) return "Loom has stopped its panes for shutdown. Retry closing the window.";
    const gen = ++this.launchGen;
    this.settler.stop(); // the last launch's exit can't settle as this one's
    const before = this.launching;
    let done!: () => void;
    this.launching = new Promise<void>((r) => (done = r));
    this.starts++;
    try {
      await before;
      return await this.launch(gen, resume, retry);
    } finally {
      this.starts--;
      done();
    }
  }
  private launchGen = 0;
  /** The launch whose process runs (or ran last), or is about to: what an
   * exit, a session marker or a wake must name to count. */
  launched = 0;
  /** The launch pty_spawn last started: what a stop kills. `launched` names a
   * launch while it still checks its session, before its process replaces this one. */
  private installed = 0;
  private launching: Promise<void> = Promise.resolve();
  private starts = 0;
  /** A launch hasn't finished. A dead pane can be starting again (a restart
   * checking its saved session), and a stop must still cancel that. */
  get launchPending() {
    return this.starts > 0;
  }
  /** Which launch the pane is on. Input queued for one is never typed into the next. */
  get generation() {
    return this.launchGen;
  }

  private async launch(gen: number, resume: boolean, retry: boolean): Promise<true | string> {
    const stale = () => this.disposed || shuttingDown || gen !== this.launchGen;
    const gaveUp = () => (this.disposed ? "The pane was closed." : "A stop or another launch came first.");
    if (stale()) return gaveUp();
    this.starting = true;
    this.startupOutput = "";
    this.startupRetry = retry;
    this.spawnResume = resume;
    this.exitCode = undefined;
    // A new process: the last one's commands, exit codes and turns aren't its own.
    this.commands = this.turns = 0;
    this.lastFailed = this.lastExit = null;
    this.lastTurnAt = Date.now();
    this.turnSource = undefined;
    this.atPrompt = false;
    this.receiptRunning = undefined;
    this.codexState = undefined;
    this.codexAsking = false;
    this.cursorTurn = undefined;
    this.grokStop = undefined; // its settle timer finds nothing held
    this.cursorGen = undefined;
    this.cursorEsc = new Map();
    this.cursorEscs = [];
    this.cursorAsking = false;
    this.cursorAnswered = undefined;
    this.cursorFeedback = false;
    this.programState = undefined;
    this.providerUsage = null;
    this.startupStarted = Date.now();
    // This launch is the pane's from here, starting through Codex's session check
    // and the awaits below: a repaint meanwhile shows it starting, and the last
    // launch's exit, wakes and session marks no longer count, though they can
    // still arrive, and this launch's can come before pty_spawn replies.
    const wasDead = this.dead;
    this.dead = false;
    this.launched = gen;
    this.paint();
    if (resume && this.agent === "codex" && this.sessionId && !ownSession(this.startup)) {
      try {
        if (!(await invoke<boolean>("has_codex_session", { sid: this.sessionId }))) this.sessionId = undefined;
      } catch (e) {
        if (stale()) return gaveUp();
        this.dead = true;
        this.term.write(`\r\nCould not check saved session: ${String(e)} — Enter retries\r\n`);
        this.paint();
        return `Could not check the saved session: ${String(e)}`;
      }
    }
    if (stale()) return gaveUp();
    if (resume && !this.sessionId && (this.agent === "codex" || this.agent === "opencode") && !ownSession(this.startup)) {
      this.dead = true;
      if (!this.resumeNotice) {
        const notice = document.createElement("div");
        notice.className = "resume-notice";
        const text = document.createElement("p");
        text.textContent = `Choose the previous ${this.agent === "codex" ? "Codex" : "OpenCode"} session once. Loom will remember it for this pane.`;
        notice.append(text, mini("Choose session", "Choose the session to resume", () => this.chooseSession()),
          mini("Start new", "Start a new conversation", () => void this.spawn(false)));
        this.host.before(notice);
        this.resumeNotice = notice;
      }
      this.paint();
      return `${this.agent} has no session to resume yet. Pick one in Loom, or start a new one.`;
    }
    this.resumeNotice?.remove();
    this.resumeNotice = undefined;
    if (!resume) this.sessionId = undefined;
    if (wasDead) this.term.reset(); // the old TUI's screen is not the new one's
    this.opencodeStatus = false;
    const can =
      resume &&
      (this.agent !== "claude" ||
        (await invoke<boolean>("has_session", { dir: this.th.dir, sid: this.sid }).catch(() => false)));
    if (stale()) return gaveUp();
    const release = restoring && this.agent === "claude" ? await bootSlot(this.th === current) : undefined;
    if (stale()) { release?.(); return gaveUp(); }
    outs.delete(this.out.id);
    const out = this.out = new Channel<string>();
    outs.set(out.id, out);
    out.onmessage = (d) => {
      const ack = () => ackOutput(out.id);
      if (this.disposed || this.out !== out) { ack(); return; }
      this.lastOut = Date.now();
      // Claude's first bytes are terminal queries and a title: nothing to see yet.
      if (this.starting && /\S/.test(d.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, ""))) {
        this.starting = false;
        this.paint();
      }
      if (this.agent === "codex") {
        this.startupOutput = (this.startupOutput + d).slice(-4096);
        this.retryCodexStartup();
      }
      const readsScreen = this.agent === "codex" || this.agent === "opencode" || reportsTurns(this.agent);
      this.term.write(d, () => {
        ack();
        if (!this.disposed && readsScreen) this.activity();
      });
      if (!readsScreen) this.activity();
    };
    const ok = await invoke("pty_spawn", {
      id: this.id,
      cwd: this.th.dir,
      argv: launch(this.startup, this.sid, can, this.effort || undefined, this.sessionId),
      codexStateId: this.agent === "codex" ? this.sid : undefined,
      cols: this.term.cols,
      rows: this.term.rows,
      onOut: this.out,
      bus: true,
      // LOOM_LAUNCH: the agents' reports name it, so a replaced process's can't move this launch's tasks.
      launch: gen,
    }).then(() => true as const, (e) => String(e));
    if (stale()) {
      // Stopped, closed or relaunched while this process was starting: it must not stay up.
      release?.();
      if (ok === true) await invoke("pty_kill", { id: this.id, launch: gen }).catch(() => {});
      return gaveUp();
    }
    if (ok !== true) {
      this.dead = true;
      this.term.write(`\r\n\x1b[31m${ok}\x1b[0m — Enter retries\r\n`);
    } else this.installed = gen;
    if (release) void (ok === true ? booted(claudeMarker(this, gen)) : Promise.resolve()).then(release);
    this.paint();
    return ok;
  }

  private retryCodexStartup() {
    if (this.agent !== "codex" || !this.dead || this.exitCode !== 1 || this.startupRetry || this.disposed) return;
    if (Date.now() - this.startupStarted > 60000 || this.lastIn >= this.startupStarted) return;
    const text = this.startupOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (!text.includes("account/read failed during TUI bootstrap") || !text.includes("workspace routing discovery timed out")) return;
    this.startupRetry = true;
    const out = this.out;
    this.term.write("\r\nCodex account discovery timed out. Retrying once...\r\n");
    setTimeout(() => {
      if (!this.disposed && this.dead && this.out === out) void this.spawn(this.spawnResume || !!this.sessionId, true);
    }, 1000);
  }

  async chooseSession() {
    const dialog = $<HTMLDialogElement>("#session-picker");
    if (dialog.open) return;
    const list = $("#session-list");
    const request = crypto.randomUUID();
    dialog.dataset.request = request;
    list.textContent = "Loading sessions…";
    $("#session-title").textContent = `Resume ${this.agent === "codex" ? "Codex" : "OpenCode"}`;
    dialog.showModal();
    try {
      const rows = await invoke<{ id: string; title: string }[]>(`${this.agent}_sessions`, { dir: this.th.dir, command: opencodeCommand(this.startup) });
      if (!dialog.open || dialog.dataset.request !== request) return;
      list.replaceChildren();
      for (const row of rows.filter(r => validSessionId(r.id))) {
        const b = document.createElement("button");
        b.className = "picker-row";
        b.textContent = row.title || row.id;
        b.title = row.id;
        b.onclick = () => {
          this.sessionId = row.id;
          save();
          dialog.close();
          void this.spawn(true);
        };
        list.append(b);
      }
      if (!list.childElementCount) list.textContent = "No saved sessions in this folder. You can start a new conversation in the pane.";
    } catch (e) {
      if (dialog.open && dialog.dataset.request === request) list.textContent = `Could not load sessions: ${String(e)}`;
    }
  }

  /** Agent panes have no OSC 133 to say "working": output that keeps coming
   * is the signal, and 1.5 s of quiet ends it. Output right after a keystroke
   * is the echo, not the agent — a real answer keeps drawing well past that. */
  private activity() {
    if (this.agent === "shell") return;
    if (this.opencodeStatus) return;
    // OMP says itself whether a turn runs (programStatus). Once it quits, its
    // shell's marks do (mark).
    if (this.agent === "omp" && this.programState === undefined) return;
    if (reportsTurns(this.agent)) this.cursorQuestion();
    if (this.agent === "codex" || this.agent === "opencode" || this.agent === "omp" || reportsTurns(this.agent)) {
      // ponytail: both keep drawing while idle (codex's star field, opencode's
      // TUI), so output alone says nothing. Codex's title says whether a turn
      // runs, status row shown or not; without one, the interrupt hint where
      // the input is: codex's "Working (3s • esc to interrupt)", opencode's
      // "esc interrupt" footer ("esc again to interrupt" after one press).
      // Clear busy when it goes, even without a ring. Read the live screen
      // after xterm joins PTY chunks, not scrolled history. An unanswered
      // approval runs nothing, whatever the title says.
      const running = this.agent === "omp" ? this.programState === "working"
        : this.agent === "grok" ? this.grokBusy()
        : reportsTurns(this.agent) && this.cursorTurn !== undefined ? this.cursorTurn
        : this.agent === "codex" && this.codexState !== undefined ? codexRunning(this.codexState) : interruptHint(this.screen(true, true), this.agent, () => screenCells(this));
      const status = running && !this.codexAsking && !this.cursorAsking;
      if (!status && this.busy) ((this.busy = false), this.paint());
      // An alert or Esc can clear busy while the hint stays visible. Reconcile
      // current state on every draw, including after the alert is acknowledged.
      if (status && !this.busy && !this.waiting) ((this.busy = true), this.paint());
      return;
    }
    const now = Date.now();
    if (now - this.lastIn < 300) return;
    if (!this.workSince || now - this.workAt >= 1500) this.workSince = now;
    this.workAt = now;
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => ((this.busy = false), this.paint()), 1500);
    // Under an unread alert, output is Claude redrawing its prompt, not work,
    // until its working line comes back after Loom saw it idle at its input:
    // a turn it began by itself (a background shell's notice, a wake-up),
    // which no Enter or hook start announces. Idle first, so the working line
    // still up as the alert rings (its Stop hooks running) isn't one.
    if (this.waiting && this.agent === "claude") {
      if (!claudeWorking(this.screen(true))) this.alertIdle ||= readInput(screenCells(this), "claude").kind !== "unknown";
      else if (this.alertIdle) this.waiting = false;
    }
    if (this.busy || this.waiting) return;
    this.busy = true;
    this.paint();
  }

  /** Cursor's questions (an approval, trusting its folder) have no hook, so
   * the screen says when one shows: it asks in the pane's task and raises the
   * alert, as Codex's OSC 9 does for its own. Gone, the pane works on (an
   * answer in Loom also says so: wrote). */
  private cursorQuestion() {
    const screen = liveScreen(this, false), menu = readMenu(screen, this.agent);
    this.cursorFeedback = !menu && (readFeedback(screen) ?? this.cursorFeedback);
    if (this.cursorAnswered !== undefined) {
      if (menu && menuRev(menu) === this.cursorAnswered) return;
      this.cursorAnswered = undefined;
    }
    if (!!menu === this.cursorAsking) return;
    this.cursorAsking = !!menu;
    if (!menu) return;
    // A prompt that went in since the turn Loom knows of may be what asks. Its
    // start was written before it could ask, so the next poll brings it, and
    // the question asks in that turn's task once the batch is in (agentEvents).
    // Reports held behind a stop's write (holdReports) may say a newer turn
    // runs too. With no start by then, it was the known turn's (a queued
    // follow-up waits).
    if (!this.cursorPrompted() && !reportsHeld.has(this.id)) this.cursorAsks(menu);
    else this.cursorAskSoon();
    // The hook's source: one source counts a launch's turns (wake), and an approval counts as Codex's does.
    this.wake(undefined, "hook");
  }
  private cursorAskLater = 0;
  /** Asks the question on screen a second on, in the turn running then, and
   * not while the pane's reports are held: those may start a newer turn.
   * ponytail: a second covers one 250 ms poll; a page stalled longer asks in the known turn. */
  private cursorAskSoon() {
    clearTimeout(this.cursorAskLater);
    this.cursorAskLater = window.setTimeout(() => (reportsHeld.has(this.id) ? this.cursorAskSoon() : this.cursorAsking && this.cursorAsks()), 1000);
  }
  /** A prompt went in that no start Loom has read explains yet: a task's
   * Enter, or a person's noted one (manualEnter). */
  private cursorPrompted() {
    return this.manual.some((m) => m.launch === this.generation) || [...tasks.values()].some((t) => t.pane === this.id && t.gen === this.generation && t.state === "submitted");
  }
  /** Cursor's question asks in the task of the turn running now (cursorGen),
   * never in an older one whose stop Loom hasn't read yet. One drawn before
   * Loom read its turn's start (the hooks are read every 250 ms) asks again
   * once that poll's batch has moved the task (agentEvents). */
  cursorAsks(menu = readMenu(liveScreen(this, false), this.agent)) {
    if (menu) taskSignal(this, { kind: "approval", at: Date.now(), detail: menu.question.join(" ").slice(0, 200) || undefined, turn: this.cursorGen });
  }

  /** GPU rendering. A page gets ~16 WebGL contexts, so they are budgeted:
   * showing a thread turns its panes on, and once GL_BUDGET is exceeded the
   * least recently shown panes of other threads give theirs up — so bouncing
   * between two threads rebuilds nothing. Idempotent both ways; on context
   * loss (or off) xterm falls back to the DOM renderer. */
  gpu(on: boolean) {
    const i = glLive.indexOf(this);
    if (i >= 0) glLive.splice(i, 1);
    if (!on) {
      this.gl?.dispose();
      this.gl = undefined;
      return;
    }
    glLive.push(this); // most recently shown last
    if (!this.gl)
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => this.gpu(false));
        this.term.loadAddon(gl);
        this.gl = gl;
      } catch {} // no WebGL → DOM renderer, still works
    while (glLive.length > GL_BUDGET) {
      const old = glLive.find((p) => p.th !== current);
      if (!old) break; // the current thread alone is over budget: keep it whole
      old.gpu(false);
    }
  }

  private raf = 0;
  private resizeRender?: { dispose(): void };
  /** rAF-coalesced: splitter drags fire ResizeObserver per pointermove per pane —
   * one fit per frame, and IPC only when the cell grid actually changed. */
  resize() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      if (!this.host.clientWidth || !this.host.clientHeight) return;
      this.resizeRender?.dispose();
      // Wait until xterm resumes its renderer after a hidden pane is reparented.
      // Fitting while paused leaves scrollbar geometry at the old row count.
      this.resizeRender = this.term.onRender(() => {
        this.resizeRender?.dispose();
        this.resizeRender = undefined;
        const { cols, rows } = this.term;
        const buffer = this.term.buffer.active;
        const following = buffer.viewportY === buffer.baseY;
        this.fit.fit();
        if (this.term.cols === cols && this.term.rows === rows) return;
        // A prior drag can leave xterm's cached scrollbar position unchanged
        // after fitting. Reconcile it after the new dimensions are rendered.
        if (following) this.raf = requestAnimationFrame(() => {
          if (!this.disposed && this.host.clientWidth && this.term.buffer.active === buffer)
            this.term.scrollLines(buffer.length);
        });
        invoke("pty_resize", {
          id: this.id,
          cols: this.term.cols,
          rows: this.term.rows,
        }).catch(() => {});
      });
      this.term.refresh(0, this.term.rows - 1);
    });
  }

  run(cmd: string) {
    this.inputSeq++;
    invoke("pty_write", { id: this.id, data: cmd + "\r" });
    this.th.focusPane(this);
  }

  /** Scroll terminal history directly; agent-owned transcripts receive wheel
   * input encoded by xterm for their negotiated mouse protocol. */
  scroll(up: boolean) {
    if (this.term.buffer.active.type === "normal" && this.term.modes.mouseTrackingMode === "none")
      return this.term.scrollLines(up ? -LINES : LINES);
    this.term.element?.dispatchEvent(
      new WheelEvent("wheel", wheelInit(up, this.host.getBoundingClientRect())),
    );
  }

  /** Turn finished: flag the pane yellow and blip, until you look at it.
   * The marker carries the session's effort level — keep the last-known one
   * (letters only: it lands on a command line at next boot). `at`: when the
   * turn ended, earlier than now for a report Loom reads late. */
  wake(effort: string | undefined, source: WakeSource, at = Date.now()) {
    if (this.agent === "opencode" && (effort === "opencode:busy" || effort === "opencode:waiting")) {
      this.opencodeStatus = true;
      if (this.dead) return;
      if (effort === "opencode:busy") {
        this.waiting = false;
        this.busy = true;
        this.paint();
        if (dashboardOpen) renderDashboard();
        return;
      }
      effort = undefined;
    }
    // A Cursor hook's marker moves nothing. Each hook replaces the pane's one
    // marker, so a poll can leave an older turn's stop after a newer turn's
    // start. Its reports, every one kept and read in order in the same poll,
    // move the pane instead (agentReport). An older helper.rs still writes them.
    if (this.agent === "cursor" && effort?.startsWith("cursor:")) return;
    if (effort && /^[a-z]+$/.test(effort) && effort !== this.effort) {
      this.effort = effort;
      save();
    }
    // A turn: the agent says it finished or needs you, after input since the
    // last one. Claude's idle reminder comes with no input: it doesn't count.
    // One turn often signals twice, though (Claude's bell, then its Stop hook a
    // marker poll and a PowerShell start later; OpenCode's plugin and OSC 99),
    // and the second can land after the next task went in. So the first source
    // that counts a turn is the only one that counts them for this launch; the
    // others still raise the alert.
    if (this.agent !== "shell" && this.lastIn > this.lastTurnAt && (this.turnSource ??= source) === source) {
      this.turns++;
      this.lastTurnAt = at;
      turnReceipts(this, at);
    }
    if (this.waiting) return;
    this.waiting = true;
    this.waitingSince = Date.now();
    this.alertIdle = false;
    this.busy = false;
    this.paint();
    beep();
    // Loom isn't on screen: flash the taskbar button too. Cleared in main().
    // The sidebar dot and waiting count remain visible with notifications off.
    if (taskbarEnabled && !loomFocused)
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
  }

  /** Its bell: on or off as its task notices are, marked when it has its own setting. */
  paintBell() {
    const on = this.notify === "inherit" ? notifyPolicy.on : this.notify === "on";
    this.bell.replaceChildren(glyph(on ? "bell" : "bell-off"));
    this.bell.classList.toggle("own", this.notify !== "inherit");
    this.bell.classList.toggle("off", !on);
    this.bell.title = `Task notices ${this.notify === "inherit" ? `${on ? "on" : "off"}, like every pane` : `${this.notify} for this pane`}. Click to change.`;
    this.bell.setAttribute("aria-label", this.bell.title);
  }

  seen() {
    if (!this.waiting) return;
    this.waiting = false;
    if (this.agent === "codex" || this.agent === "opencode" || this.agent === "omp" || reportsTurns(this.agent)) this.activity();
    this.paint();
    if (dashboardOpen) renderDashboard();
  }

  paint(index = this.th.panes.indexOf(this)) {
    const title = (this.label = paneTitle(this.appTitle, this.agent));
    const state = paneState(this);
    const starting = this.starting && !this.dead;
    const word = this.dead ? "Exited" : starting ? "Starting" : this.waiting ? "Waiting" : this.busy ? "Working" : "Ready";
    this.title.textContent = title;
    this.title.title = `${this.agent}, pane ${index + 1}: ${this.appTitle || title}`;
    this.stateTag.textContent = state || starting ? word : "";
    this.el.classList.toggle("starting", starting);
    this.el.classList.toggle("busy", this.busy);
    this.el.classList.toggle("waiting", this.waiting);
    this.el.classList.toggle("dead", this.dead);
    this.el.classList.toggle("active", this.th.active === this);
    // The sidebar row: the agent, then whatever it titled itself.
    this.rowName.textContent = this.agent;
    this.rowLabel.textContent = title;
    this.rowState.textContent = word;
    this.row.title = `${this.agent}: ${this.appTitle || title}`;
    this.row.setAttribute("aria-label", `${this.agent}, ${title}, ${word}`);
    this.row.dataset.state = state;
    this.row.classList.toggle("on", this.th === current && this.th.active === this);
    this.pip.dataset.state = state;
    this.pip.title = `${this.agent}: ${title} (${word})`;
    if (!this.disposed) this.settler.see(cliState(this));
    this.th.paint(); // the thread row sums its panes
    syncSpin();
    // Exiting or relaunching changes whether this pane can be dictated into.
    if (this.th === current && this.th.active === this) micRefresh();
  }

  /** What the pane is showing, so a command can be checked for having taken.
   * Defaults to visible rows; live reads ignore the user's scrollback position.
   * `joined`: a row the terminal wrapped continues the line above it. */
  screen(live = false, joined = false) {
    const buf = this.term.buffer.active;
    const start = live ? buf.baseY : buf.viewportY;
    let s = "";
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(start + y);
      if (joined && y && line?.isWrapped) s = s.slice(0, -1);
      // To the terminal's width: the alternate screen keeps cells past it after a narrowing resize.
      s += (line?.translateToString(!joined, 0, this.term.cols) ?? "") + "\n";
    }
    return s;
  }

  /** Wait until the pane has drawn nothing for `quiet` ms — long enough for a TUI
   * to finish reacting to what it was just sent. Capped, because Claude Code
   * redraws a spinner while it works and would otherwise never go quiet. */
  async settle(quiet = 300, cap = 2500) {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      // Count from the send, not from the last byte: a reply that hasn't begun
      // yet leaves lastOut in the past, and waiting on that alone returns at
      // once — which is exactly how the second command used to get dropped.
      const idle = now - Math.max(this.lastOut, start);
      if (idle >= quiet || now - start >= cap) return;
      await new Promise((r) => setTimeout(r, Math.min(quiet - idle, 100)));
    }
  }

  /** Poll result for this pane's session, or null when no claude is running in
   * it. A session that hasn't answered yet reads 0% — the statusline reports the
   * window from startup, the context only once a turn has sent something. The
   * bar is the element's own background, so the gauge is one node carrying a
   * percentage. */
  setUsage(u: Usage | null) {
    // Only the gauge's own numbers gate the repaint — the rest of the poll
    // (the live model and effort the config panel reads) still has to land, and
    // before the first turn ctx and turns sit at 0 for as long as you take to
    // type your first message.
    // The window too: /model to a smaller one changes the share before any turn does.
    const drawn = u?.ctx === this.usage?.ctx && u?.turns === this.usage?.turns && u?.window === this.usage?.window;
    this.usage = u;
    if (drawn) return;
    if (!u) return void (this.gauge.className = "ctx hidden");
    paintGauge(this.gauge, u);
    this.gauge.title += "\nClick for what filled it";
  }

  focus() {
    this.seen(); // Opening a preview skips this method; explicitly focusing its pane acknowledges it.
    this.term.focus();
  }

  /** Claude Code booted this pane and still has it running. Gates the config
   * panel's slash commands and right-click paste, which claude does for
   * itself. Not an alternate-screen test any more: Claude Code and Codex draw
   * inline in the main buffer now, and an agent pane runs the agent bare, so
   * the process being alive is the whole question. */
  get claudeUp() {
    return this.isClaude && !this.dead;
  }

  /** Any agent up — where dictation can type. */
  get agentUp() {
    return this.agent !== "shell" && !this.dead;
  }

  get isClaude() {
    return this.agent === "claude";
  }

  async dispose() {
    this.disposed = true;
    this.settler.stop();
    dashboardMessages.delete(this.id);
    dashboardDrafts.delete(this.id);
    // Closing the pane mid-sentence: drop the recording, there's nowhere to put it.
    if (recording?.pane === this) {
      recording = null;
      micState("");
      mic(() => invoke("dictate_stop").then(() => {}, () => {}));
    }
    clearTimeout(this.idle);
    clearTimeout(this.grokTimer);
    this.observer.disconnect();
    cancelAnimationFrame(this.raf);
    this.resizeRender?.dispose();
    this.unlisten.forEach((u) => u());
    outs.delete(this.out.id);
    // The channel lives until native drops it; its handler mustn't keep this pane. Late output is still acked.
    const channel = this.out.id;
    this.out.onmessage = () => ackOutput(channel);
    this.gpu(false);
    this.term.dispose();
    this.el.remove();
    this.row.remove();
    this.pip.remove();
    await invoke("pty_kill", { id: this.id }).catch(() => {});
  }

  /** OSC 133 from shell-init.ps1: the pane's busy state (;C a command started,
   * ;D it exited) and, for loomctl, how many finished, the last exit code,
   * whether the prompt is waiting for a command (;B), and which command line
   * runs (;E), which pairs a send --receipt with its own ;D. A is ignored. */
  private mark(data: string) {
    // OMP draws each prompt in its transcript between marks of its own (A,
    // then B C D;0), for terminals to jump between them: never its shell's.
    if (this.agent === "omp" && this.programState !== undefined) return;
    const [kind, code, ...rest] = data.split(";");
    if (kind === "B") return void (this.atPrompt = true);
    if (kind === "E") {
      this.atPrompt = false;
      // Only the comment send --receipt puts at the very end of the line: a
      // marker-like string anywhere else in a command is just text.
      this.receiptRunning = /(?:^E;|\s)# loom-receipt:([0-9a-f]{16})$/.exec(data)?.[1];
      if (this.receiptRunning) taskSignal(this, { kind: "start", at: Date.now(), token: this.receiptRunning });
      return;
    }
    if (kind !== "C" && kind !== "D") return;
    this.atPrompt = false;
    this.busy = kind === "C";
    if (kind === "D") {
      const known = /^-?\d+$/.test(code ?? "");
      this.commands++;
      this.lastFailed = known ? code !== "0" : null;
      // exact=0: the prompt knows the command failed but not its code (shell-init.ps1).
      this.lastExit = known && !rest.includes("exact=0") ? Number(code) : null;
      if (this.receiptRunning) {
        finishReceipt(this.receiptRunning, this, { failed: this.lastFailed, exit: this.lastExit });
        taskSignal(this, { kind: "end", at: Date.now(), token: this.receiptRunning, failed: this.lastFailed, exit: this.lastExit });
      }
      this.receiptRunning = undefined;
    }
    this.paint();
  }
  /** OSC 7501 Program Status (docs/feature-study.md section 3): OMP says
   * unasked when a turn runs (working), waits on you (blocked: its question,
   * or a tool it may not run unasked), ends (done, error, or idle when Esc
   * stopped it), and that it quit (clear). That is its report of a turn, as
   * Claude's hooks and Codex's notify are theirs: it moves the pane's tasks,
   * raises the alert where a turn ends or asks, and says whether the pane
   * works (activity). A query (`?`) goes unanswered. */
  programStatus(data: string) {
    const state = /(?:^|:)state=(\w+)/.exec(data)?.[1];
    if (this.agent !== "omp" || !state || state === this.programState) return;
    const was = this.programState, at = Date.now();
    this.programState = state === "clear" ? undefined : state;
    let detail: string | undefined; // what it asks, or why it failed: base64 UTF-8
    try { detail = new TextDecoder().decode(Uint8Array.from(atob(/(?:^|:)msg=([\w+/=]+)/.exec(data)?.[1] ?? ""), (c) => c.charCodeAt(0))).slice(0, 200) || undefined; } catch {}
    if (state === "working") taskSignal(this, { kind: was === "blocked" ? "resume" : "start", at });
    else if (state === "blocked") taskSignal(this, { kind: "approval", at, detail });
    else if (state === "done") taskSignal(this, { kind: "end", at });
    else if (state === "error") taskSignal(this, { kind: "fail", at, detail });
    else if (was === "working" || was === "blocked") taskSignal(this, { kind: "interrupt", at });
    if (state === "blocked" || state === "done" || state === "error") return this.wake(undefined, "osc7501");
    if (this.programState) return this.activity();
    this.busy = false;
    this.paint();
  }
  /** Commands a shell with Loom's prompt finished (OSC 133 D), whether the last
   * failed, and its exit code when the prompt knows it exactly. */
  commands = 0;
  lastFailed: boolean | null = null;
  lastExit: number | null = null;
  /** The shell's prompt is waiting for a command line. */
  atPrompt = false;
  /** A line break typed into a shell submits whatever is at the prompt, so the
   * prompt is spent until the next ;B, though ;E and ;C take a moment to come. */
  usePrompt(data: string) {
    if (this.agent === "shell" && /[\r\n]/.test(data)) this.atPrompt = false;
  }
  /** The receipt on the command line running now (a send --receipt comment). */
  receiptRunning: string | undefined;
  /** Times an agent finished a turn or stopped to ask, each after new input (wake). */
  turns = 0;
  lastTurnAt = 0;
  /** The one signal that counts turns for this launch: the first that did. */
  turnSource: WakeSource | undefined;
  /** Whether `d` answers the question on screen: Enter, or one key the prompt
   * takes, a number or the letter an option names. Read as it's typed, before
   * the agent redraws. A key the prompt ignores, the first letter of a typed
   * answer, arrows and pastes answer nothing. */
  answers(d: string) {
    if (d.startsWith("\x1b[200~")) return false;
    if (d.includes("\r")) return true;
    // Cursor's question takes the keys its options name and Ctrl-C, which
    // rejects it, as Esc does where no option names Esc (Delete's "Keep"). An
    // option that proposes asks for feedback instead, so it's still asked
    // (cursorKey). In the feedback, Ctrl-C skips it, as an empty Enter does,
    // and Esc goes back to the question.
    if (this.agent === "cursor" && (d === "\x1b" || d === "\x03" || /^[a-z]$/i.test(d))) {
      if (!this.cursorAsking) return d === "\x03" && this.cursorFeedback;
      if (d === "\x03") return true;
      const menu = readMenu(liveScreen(this, false), this.agent);
      return !!menu && (cursorKey(menu, d === "\x1b" ? "esc" : d.toLowerCase()) ?? d === "\x1b");
    }
    // Shift+Tab and Tab pick the option that names them ("allow all edits ...
    // (shift+tab)", Cursor's "Add Shell(echo) to allowlist? (tab)").
    if (d === "\x1b[Z" || d === "\t") {
      const asked = readMenu(liveScreen(this, false), this.agent), key = d === "\t" ? /\(tab\)\s*$/i : /shift\s*\+\s*tab/i;
      return !!asked && (asked.full ?? asked.options).some((o) => key.test(o));
    }
    if (!/^[0-9a-z]$/i.test(d)) return false;
    const menu = readMenu(liveScreen(this, false), this.agent) ?? (this.agent === "claude" ? readSurvey(liveScreen(this, true, true)) : null);
    return !!menu && menuKeys(menu).includes(d.toLowerCase());
  }
  /** A Cursor turn started (`running`) or the pane's current one stopped, as
   * its reports say in order (agentReport). A question Cursor drew before Loom
   * read the start still waits for its answer. */
  cursorRuns(running: boolean) {
    if (this.dead) return;
    if (running && !this.cursorAsking) this.waiting = false;
    this.cursorTurn = running;
    this.busy = (this.agent === "grok" ? this.grokBusy() : running) && !this.cursorAsking;
    this.paint();
    if (dashboardOpen) renderDashboard();
  }
  /** Whether Grok runs a turn: its bar says where it can (grokRunning), its
   * hooks where it can't. A bar showing none running ends the hooks' word,
   * but for a held Stop's: a prompt another hook blocked ran no turn, and no
   * report of its end is owed. */
  grokBusy() {
    const seen = grokRunning(liveScreen(this, false));
    if (seen === false && !this.grokStop) this.cursorTurn = false;
    return seen ?? this.cursorTurn ?? false;
  }
  /** A Grok report as agentReport takes it, or undefined while it waits.
   * Its Stop waits for Grok's session log to say how the turn ended
   * (grokSettle). That turn's own cancel or failure, Ctrl+C in its Stop gate
   * or an error after a block, is how it ended. Grok's idle notice, another
   * turn starting, or an older launch's Stop say the turn is over, but not
   * how (grokOver). */
  grokReport(s: Signal): Signal | undefined {
    const old = (s.launch ?? this.generation) !== this.generation, held = this.grokStop;
    if (s.kind === "stop") return void (old ? this.grokOver(s) : ((this.grokStop = s), this.grokSettle()));
    if (s.kind === "idle") {
      if (!old && held) this.grokOver(held);
      else if (!old && this.cursorTurn) this.cursorRuns(false);
      return;
    }
    if (!old && held && (s.kind === "start" ? s.turn !== held.turn : (s.kind === "fail" || s.kind === "interrupt") && s.turn === held.turn)) {
      if (s.kind === "start") this.grokOver(held);
      else this.grokDrop();
    }
    return s;
  }
  /** Reads how Grok's session log says the held Stop's turn ended, once the
   * bar no longer shows it running, and every quarter second until it says.
   * A Stop hook that blocks sends Grok on with its bar unchanged, and Grok can
   * fail or cancel the turn after, a click on its stop button too, and report
   * that off the turn, late (Grok's hooks guide). So the bar, a start, keys
   * typed or the time it took prove the turn over at most, never how. Success
   * ends it as its Stop said. Any other end leaves it to Grok's own report,
   * still held but no longer read.
   * A dead pane polls no more, and a closed one says nothing (dispose). */
  async grokSettle() {
    clearTimeout(this.grokTimer);
    const s = this.grokStop;
    if (!s || this.disposed || this.dead) return;
    if (grokRunning(liveScreen(this, false)) !== true && !this.cursorAsking) {
      const end = await this.grokOutcome(s);
      if (this.grokStop !== s || this.disposed || this.dead) return;
      if (end === "end_turn") return this.grokEnd(s);
      if (end) return; // held unpolled: its own report clears it, and closing ends it unknown
    }
    this.grokTimer = window.setTimeout(() => void this.grokSettle(), 250);
  }
  /** Stop `s`'s turn is over: the next turn started, Grok settled, an older
   * launch's, or Loom is closing. Grok's session log says whether it
   * succeeded. Anything else leaves it to Grok's own report, or the sweep's
   * quiet ends it unknown. `keep`: closing keeps it held for the sweep. */
  grokOver(s: GrokStop, keep = false) {
    if (this.grokStop === s) keep ? clearTimeout(this.grokTimer) : this.grokDrop();
    this.grokReads = Promise.all([this.grokReads, this.grokOutcome(s).then((end) => end === "end_turn" && this.grokEnd(s))]);
  }
  /** How Grok's session log says Stop `s`'s turn ended (grok.rs turn_end): "end_turn" alone is success. */
  private grokOutcome(s: GrokStop) {
    if (!s.session || !s.turn) return Promise.resolve(null);
    return invoke<string | null>("grok_turn_end", { session: s.session, turn: s.turn, from: s.from ?? 0 }).catch(() => null);
  }
  /** Stop `s`'s turn succeeded: it ends as that Stop, or the turn's later one still held, said. */
  private grokEnd(s: GrokStop) {
    const held = this.grokStop;
    if (this.disposed) return;
    if (held && held.turn === s.turn) (s = held), this.grokDrop();
    agentReport(this, { at: s.at, launch: s.launch, kind: "end", ...(s.turn ? { turn: s.turn } : {}), ...(s.response ? { response: s.response } : {}) });
  }
  private grokDrop() {
    this.grokStop = undefined;
    clearTimeout(this.grokTimer);
  }
  /** What writing `d` means, read off the screen as it's typed: the agent can
   * redraw for it before the write is acknowledged (wrote). `gen`: the launch
   * it goes to, whose alone it is (generation). `answer`: it
   * settles the question on screen (answers), and `menu`, which of Cursor's
   * (menuRev). `stop`: an Esc or Ctrl-C with neither Cursor's question nor
   * its feedback open, which stops the turn running: that turn, when it was
   * typed, and a hold on the pane's reports until its write's outcome is in
   * (holdReports). */
  sending(d: string): Meant {
    const answer = this.answers(d), cursor = this.agent === "cursor";
    const menu = answer && reportsTurns(this.agent) && this.cursorAsking ? readMenu(liveScreen(this, false), this.agent) : null;
    const stop = cursor && (d === "\x1b" || d === "\x03") && !this.cursorAsking && !this.cursorFeedback;
    return { gen: this.generation, answer, ...(menu ? { menu: menuRev(menu) } : {}), ...(stop ? { stop: { turn: this.cursorTurn ? this.cursorGen : undefined, at: Date.now(), release: holdReports(this) } } : {}) };
  }
  /** Cursor's question `rev` is answered, the one on screen as the answer was
   * typed: drawn on until Cursor redraws, it isn't asked again, while one
   * Cursor drew since asks (wrote). */
  private answeredCursor(rev: string | undefined) {
    if (!this.cursorAsking) return;
    this.cursorAsking = false;
    this.cursorAnswered = rev;
  }
  /** When Esc or Ctrl-C last went in, by anyone. Agents report no end for a
   * turn they were interrupted in (Claude Code runs no Stop hook), so a task
   * there ends on this and the agent no longer working (sweepTasks). */
  interruptAt = 0;
  /** A write to the process finished: `delivered`, or it failed and may or
   * may not have gone in. Only what went in moves a task. Esc or Ctrl-C may
   * have interrupted a turn (sweepTasks judges it). An answer (`sent`, what
   * sending() read as it was typed, never the screen now: the agent may have
   * redrawn for it already) answers a question, which neither Claude nor
   * Codex reports, so a task asking here works again. An answer that
   * failed leaves the question asked, and the task says the answer is in
   * doubt (`answerInDoubt`, not `uncertain`: an answer says nothing about the
   * task's own Enter). */
  wrote(data: string, delivered: boolean, sent: Meant, began?: number) {
    const stop = sent.stop;
    // A write to a launch since replaced (a stop, a restart) is that one's:
    // it touches nothing of this launch's question, tasks, interruptions or
    // alert. The reports it held still go on.
    if (sent.gen !== this.generation) return void stop?.release();
    if (delivered && (data === "\x1b" || data === "\x03")) {
      this.interruptAt = Date.now();
      this.codexAsking = false;
      // Cursor's: only one typed with neither its question nor its feedback
      // open stops the turn: the one running as it was typed, or one Loom
      // hasn't heard of yet (agentReport). It counts from when the pane's
      // writer began writing it (`began`), or else when it was typed. An error
      // Cursor wrote before that is the turn's own.
      if (stop) {
        const at = began ?? stop.at;
        // ponytail: the last 16 only; one 250 ms poll's starts need far fewer.
        if (this.cursorEscs.push(at) > 16) this.cursorEscs.shift();
        // The first Esc into a turn stopped it.
        if (stop.turn && !this.cursorEsc.has(stop.turn)) this.cursorEsc.set(stop.turn, at);
      }
      // Ctrl-C ends Cursor's feedback, if it was open. Esc can open it or end
      // it, so only the screen says (cursorQuestion).
      // ponytail: a second Ctrl-C typed before this one's acknowledgement or
      // Cursor's redraw still reads as the skip; one more draw tells them apart.
      if (data === "\x03") this.cursorFeedback = false;
    }
    // The reports held while it went in are judged now, with its outcome in.
    stop?.release();
    if (!sent.answer) return;
    const asking = [...tasks.values()].filter((t) => t.pane === this.id && t.gen === this.generation && t.state === "approval");
    if (!delivered) return void asking.forEach((t) => moveTask(t, { state: "approval", signal: "answer", answerInDoubt: true }));
    this.codexAsking = false;
    this.answeredCursor(sent.menu);
    taskSignal(this, { kind: "resume", at: Date.now() });
    // An answer went in, to a tracked task's question or a turn Loom hasn't
    // adopted yet; an alert the write itself raised stays.
    if (this.waitingSince <= this.lastIn) this.seen();
    // Cursor or Grok may have drawn its next question before this write was
    // acknowledged: that one asks now, with an alert of its own.
    if (reportsTurns(this.agent)) this.cursorQuestion();
  }
}

/** A thread, as Orca has them: one branch of work in its own git worktree,
 * with the agent (or agents) running there. `dir` is the worktree, `repo` the
 * checkout it was cut from — the same path when the thread IS the checkout.
 * Panes never outlive their thread. */
class Thread {
  readonly id = uid();
  readonly grid = document.createElement("section");
  readonly row = document.createElement("div");
  readonly panes: Pane[] = [];
  private observer = new ResizeObserver(() => { if (this.grid.clientWidth) this.relayout(); });
  active: Pane | null = null;
  zoomed: Pane | null = null;
  layout: LayoutMode = "cols";
  /** Agent rows listed under the thread row: set by its chevron, persisted.
   * Unset, the thread you are on lists its agents and the rest fold them into
   * pips, so thirty threads still fit on one screen. */
  open: boolean | undefined;
  /** Diff tabs open over this thread's panes, and the one showing — null is
   * the panes themselves. Orca keeps diffs as tabs beside the agent; so do we. */
  tabs: DiffTab[] = [];
  tab: DiffTab | null = null;
  commitDraft = "";
  /** Opened from the saved workspace, its panes still starting: they come back
   * as they were. A thread loomctl makes meanwhile is new, panes and all. */
  restoring = false;
  private label = document.createElement("button");
  private list = document.createElement("div");
  private pips = document.createElement("span");
  private stat = document.createElement("span");
  private age = document.createElement("span");
  /** The branch, on the open thread's second line (styles.css shows it only there). */
  private branchEl = document.createElement("span");
  private fold = mini(glyph("chevron"), "Fold agents", () => this.setOpen(!this.listed));
  private add = mini(glyph("plus"), "Add agent or CLI to this thread", () => this.addMenu(this.add));
  /** Lines changed against HEAD and files touched, from pollStats(). */
  changed = { add: 0, del: 0, files: 0 };
  colW: number[] = [];
  rowH: number[] = [];

  constructor(
    readonly repo: string,
    readonly dir: string,
    public branch: string,
    public name: string,
  ) {
    this.grid.className = "grid";
    this.observer.observe(this.grid);
    this.row.className = "thread";
    this.row.dataset.id = this.id;
    // Group metadata below collapsed names; expanded headers keep it inline.
    const top = document.createElement("div");
    top.className = "thread-top";
    this.label.className = "thread-name thread-select";
    this.label.textContent = name;
    this.fold.classList.add("fold");
    const more = mini(glyph("more"), "Thread actions", () => showMenu(more, threadMenu(this)));
    more.classList.add("more");
    this.add.classList.add("thread-add");
    const tools = document.createElement("span");
    tools.className = "thread-tools";
    tools.append(this.add, more);
    this.pips.className = "pips";
    this.stat.className = "thread-stat";
    this.age.className = "thread-age";
    const meta = document.createElement("div");
    meta.className = "thread-meta";
    this.branchEl.className = "thread-branch";
    meta.append(this.branchEl, this.pips, this.stat, this.age);
    top.append(this.fold, this.label, tools, meta);
    this.label.ondblclick = () => renameThread(this);
    this.list.className = "agents";
    this.list.id = `agents-${this.id}`;
    this.list.setAttribute("role", "group");
    this.list.setAttribute("aria-label", "Agents and terminals");
    this.fold.setAttribute("aria-controls", this.list.id);
    this.row.append(top, this.list);
    this.setStat(this.changed);
    this.row.onclick = () => show(this);
    this.row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(this.row, threadMenu(this));
    };
    // Wired once, here: the row outlives every sidebar rebuild, and wiring it
    // in renderSide added a listener per rebuild — each drop then fired N times.
    dragRow(this.row, () => threads.filter((t) => t.repo === repo).map((t) => t.row), (over, after) => {
      moveNextTo(threads, this, threads.find((t) => t.id === over.dataset.id)!, after);
      renderSide();
      save();
    });
  }

  /** Cut from a repo, or the repo's own checkout opened as a thread. */
  get isWorktree() {
    return this.dir !== this.repo;
  }

  /** Whether the agent rows show: the chevron's choice, else "is it current". */
  get listed() {
    return this.open ?? this === current;
  }

  setOpen(o: boolean) {
    this.open = o;
    this.paintFold();
    save();
  }

  private shown?: boolean;
  private paintFold() {
    const on = this.listed;
    if (on === this.shown) return; // paint() runs per pane repaint; skip the DOM when nothing moved
    this.shown = on;
    this.list.classList.toggle("hidden", !on);
    this.row.classList.toggle("listed", on);
    this.fold.title = on ? "Fold agents" : "List agents";
    this.fold.setAttribute("aria-label", this.fold.title);
    this.fold.setAttribute("aria-expanded", String(on));
  }

  rename(n: string) {
    this.name = n;
    this.label.textContent = n;
    this.setStat(this.changed); // the tooltip names it too
    save();
  }

  /** "3m" since any pane here last drew, Orca's per-row age. Blank until
   * something has happened this run — a restored thread has no history. */
  paintAge() {
    const last = Math.max(0, ...this.panes.map((p) => p.lastOut));
    this.age.textContent = last ? ago(last) : "";
  }

  setStat(s: { add: number; del: number; files: number }) {
    this.changed = s;
    // The branch is usually loom/<name>, which the row already says; it lives
    // in the tooltip and the top bar instead of a line of its own.
    this.row.title = `${this.name}\n${this.branch ? `Branch ${this.branch}` : "Folder without a Git branch"}\n${this.dir}`;
    if (this.branchEl.textContent !== this.branch) this.branchEl.textContent = this.branch;
    this.stat.innerHTML = statHtml(s);
    if (this === current) paintHead();
  }

  /** Does this row survive the sidebar filter? Name, branch, or an agent's title. */
  matches(q: string) {
    const hay = [basename(this.repo), this.name, this.branch, ...this.panes.map((p) => `${p.agent} ${p.appTitle}`)].join(" ").toLowerCase();
    return hay.includes(q);
  }

  async addPane(st: PaneState = { cmd: startups[0]?.cmd ?? "" }, focus = true) {
    if (this.panes.length >= MAX_PANES) return;
    const p = new Pane(this);
    p.groupIds = Array.isArray(st.groupIds) ? [...new Set(st.groupIds.filter(id => agentGroups.some(g => g.id === id)))] : [];
    if (st.sessionId && validSessionId(st.sessionId)) p.sessionId = st.sessionId;
    if (st.effort) p.effort = st.effort;
    p.startupSettings = st.startupSettings;
    // A restored pane keeps its own setting; a new one starts as notifyPolicy.newPanes says.
    p.notify = st.notify === "on" || st.notify === "off" ? st.notify : this.restoring ? "inherit" : notifyPolicy.newPanes;
    if (this.restoring && Array.isArray(st.notifyIds)) p.notifyIds = [...new Set([...st.notifyIds.filter((id) => typeof id === "string" && id), p.id])];
    if (this.restoring && typeof st.stableId === "string" && st.stableId) p.stableId = st.stableId;
    if (startupTurns) for (const id of p.notifyIds) startupNotify.set(id, p.notify);
    p.paintBell();
    this.panes.push(p);
    this.grid.append(p.el);
    this.list.append(p.row); // sidebar order = grid order
    this.pips.append(p.pip);
    dragRow(p.row, () => this.panes.map((q) => q.row), (over, after) => {
      moveNextTo(this.panes, p, this.panes.find((q) => q.row === over)!, after);
      this.reordered(p);
    });
    this.relayout();
    if (!this.restoring && p.notify !== "inherit") void recordNotify().catch(notifyError); // before it can have a task
    await p.start(st.cmd, st.sid);
    if (!this.panes.includes(p)) return;
    if (focus) this.focusPane(p);
    return p;
  }

  addMenu(at: HTMLElement) {
    showMenu(at, startupMenu((cmd) => {
      if (this.open === false) this.open = undefined; // the pane you add is one you want to see
      this.tab = null;
      show(this);
      void this.addPane({ cmd }).then(p => {
        if (p) revealPane(p);
        return save();
      });
    }));
  }

  /** `force`: loomctl's --yes, which already said so. */
  async closePane(p: Pane, force = false): Promise<boolean> {
    if (!this.panes.includes(p)) return false;
    // A misclick on ✕ would otherwise kill a running agent on the spot.
    if (p.agentUp && !force && !(await confirm(`Close ${p.agent} pane?`, {
      title: "Loom", action: "Close pane",
      detail: "This stops the running agent and removes this pane from the workspace. Your project files stay on disk.",
    }))) return false;
    // Found again after the dialog: another close may have come first.
    const i = this.panes.indexOf(p);
    if (i === -1) return false;
    if (this.zoomed === p) this.toggleZoom(p);
    keepContext([p]);
    this.panes.splice(i, 1);
    const cleanup = p.dispose();
    this.relayout();
    const next = this.panes[Math.min(i, this.panes.length - 1)] ?? null;
    // Focusing counts as seeing a pane's alert: only in the thread in front.
    // Closed from loomctl or the phone elsewhere, the next pane keeps its own.
    if (this === current) this.focusPane(next);
    else ((this.active = next), this.panes.forEach((q, k) => q.paint(k)));
    save(); // else the pane is back on the next launch
    await cleanup;
    return true;
  }

  /** Ctrl+Alt+Arrow: the pane whose box lies that way from the focused one,
   * nearest first. Geometry, not grid index, so it follows the layout mode. */
  focusToward(dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") {
    const from = this.active;
    if (!from) return;
    const c = (p: Pane) => {
      const r = p.el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const a = c(from);
    let best: Pane | null = null;
    let bestD = Infinity;
    for (const p of this.panes) {
      if (p === from) continue;
      const b = c(p);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ok =
        dir === "ArrowLeft" ? dx < -1 : dir === "ArrowRight" ? dx > 1 : dir === "ArrowUp" ? dy < -1 : dy > 1;
      if (!ok) continue;
      // Off-axis distance counts double: the pane straight across wins over a diagonal one.
      const d = dir === "ArrowLeft" || dir === "ArrowRight" ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx);
      if (d < bestD) (bestD = d), (best = p);
    }
    if (best) this.focusPane(best);
  }

  focusPane(p: Pane | null) {
    const changed = this.active !== p;
    this.active = p;
    this.panes.forEach((q, i) => q.paint(i));
    p?.focus();
    micRefresh(); // dictation follows the focused pane
    if (changed && this === current) paintTabs(); // the panes tab wears the focused agent's mark and the count
    if (changed) save();
  }

  /** The sidebar row: what runs here, on which branch, and whether it wants
   * you. One state per row, worst first — a thread with a pane waiting is
   * waiting whatever the others are up to. */
  paint() {
    this.add.disabled = this.panes.length >= MAX_PANES;
    this.paintFold(); // "current" may have moved
    const state = this.panes.some((p) => p.waiting)
      ? "waiting"
      : this.panes.some((p) => p.busy)
        ? "busy"
        : this.panes.length && this.panes.every((p) => p.dead)
          ? "dead"
          : "";
    this.row.dataset.state = state;
    this.row.classList.toggle("on", this === current);
    paintWaiting();
  }

  /** grid: square-ish tiling (1→1x1, 4→2x2). rows: one column, panes stacked.
   * cols: one row, panes side by side. Track weights survive resizes but
   * reset (re-balance) whenever the pane count changes shape. */
  relayout() {
    if (!this.grid.clientWidth) return; // Hidden threads keep their saved split sizes.
    const n = this.panes.length || 1;
    const capacity = Math.max(1, Math.floor(this.grid.clientWidth / 280));
    const cols = Math.min(capacity, this.layout === "rows" ? 1 : this.layout === "cols" ? n : Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const reshaped = this.colW.length !== cols || this.rowH.length !== rows;
    if (this.colW.length !== cols) this.colW = Array(cols).fill(1);
    if (this.rowH.length !== rows) this.rowH = Array(rows).fill(1);
    this.grid.style.gridTemplateColumns = this.colW.map((w) => `${w}fr`).join(" ");
    this.grid.style.gridTemplateRows = this.rowH.map((w) => `${w}fr`).join(" ");
    this.panes.forEach((p, i) => p.paint(i));
    this.paint();
    this.placeSplitters();
    if (reshaped) save();
  }

  /** Swap two panes' grid positions (drop target ⇄ dragged pane). */
  swap(a: Pane, b: Pane) {
    const i = this.panes.indexOf(a);
    const j = this.panes.indexOf(b);
    if (i === -1 || j === -1 || i === j) return;
    [this.panes[i], this.panes[j]] = [b, a];
    this.reordered(a);
  }

  /** `panes` changed order: the grid and sidebar follow, and the order is saved. */
  private reordered(focus: Pane) {
    for (const p of this.panes) (this.grid.append(p.el), this.list.append(p.row), this.pips.append(p.pip)); // DOM order = grid order, sidebar too
    this.relayout();
    this.focusPane(focus);
    save(); // the reorder is the saved pane order
  }

  /** aa's F2: the focused pane fills the stage; the others keep running hidden. */
  toggleZoom(p: Pane) {
    this.zoomed = this.zoomed === p ? null : p;
    this.grid.classList.toggle("zooming", !!this.zoomed);
    for (const q of this.panes) q.el.classList.toggle("zoom", q === this.zoomed);
    this.placeSplitters();
    this.panes.forEach((q) => q.resize()); // hidden panes no-op via the 0-size guard
    this.focusPane(this.zoomed ?? p);
    save();
  }

  /** Drag handles over the grid gaps; dragging shifts weight between the two
   * neighboring tracks. Positions are px, so they're replaced on any resize. */
  private placeSplitters() {
    this.grid.querySelectorAll(".split").forEach((e) => e.remove());
    if (this.zoomed) return;
    const PAD = 7; // .grid padding = gap
    const place = (weights: number[], size: number, axis: "x" | "y") => {
      const avail = size - 2 * PAD - (weights.length - 1) * PAD;
      const total = weights.reduce((s, w) => s + w, 0);
      if (avail <= 0 || !total) return;
      let off = PAD;
      for (let i = 1; i < weights.length; i++) {
        off += (weights[i - 1] / total) * avail;
        const s = document.createElement("div");
        s.className = `split ${axis === "x" ? "v" : "h"}`;
        s.style[axis === "x" ? "left" : "top"] = `${off}px`;
        s.onpointerdown = (e) => this.dragSplit(e, s, weights, i, avail / total, axis);
        this.grid.append(s);
        off += PAD;
      }
    };
    place(this.colW, this.grid.clientWidth, "x");
    place(this.rowH, this.grid.clientHeight, "y");
  }

  private dragSplit(
    e: PointerEvent,
    el: HTMLElement,
    weights: number[],
    i: number,
    pxPerFr: number,
    axis: "x" | "y",
  ) {
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY;
    const startOff = parseFloat(el.style[axis === "x" ? "left" : "top"]);
    const [a, b] = [weights[i - 1], weights[i]];
    const min = 0.15 * (a + b); // neither side collapses below ~15% of the pair
    const prop = axis === "x" ? ("gridTemplateColumns" as const) : ("gridTemplateRows" as const);
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      const d = ((axis === "x" ? ev.clientX : ev.clientY) - start) / pxPerFr;
      weights[i - 1] = Math.min(Math.max(a + d, min), a + b - min);
      weights[i] = a + b - weights[i - 1];
      this.grid.style[prop] = weights.map((w) => `${w}fr`).join(" ");
      el.style[axis === "x" ? "left" : "top"] = `${startOff + (weights[i - 1] - a) * pxPerFr}px`;
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      this.placeSplitters();
      save();
    };
  }

  async dispose() {
    this.observer.disconnect();
    keepContext(this.panes); // removeThread comes here, right after taking the thread from the list
    const cleanup = Promise.all(this.panes.splice(0).map((p) => p.dispose()));
    this.grid.remove();
    this.row.remove();
    await cleanup;
  }
}

// --- app state ------------------------------------------------------------
const threads: Thread[] = [];
/** Native shutdown committed: preserve its reports and allow only a close retry. */
let shuttingDown = false;
/** This Loom's start, so a phone waiting on a restart sees the new one answer (status's `booted`). */
const bootedAt = Date.now();
let relaunching = false;
/** A close is under way: its end decides whether Loom restarts, so nothing turns it into one now. */
let windowClosing = false;
/** Restarts Loom: the safe close that closing its window runs, then the exe
 * starts again (lib.rs relaunch), after an update the new version. Every pane
 * comes back, agents in their sessions; a turn under way stops. */
function relaunch() {
  if (windowClosing) return void toast("Loom is closing, so it won't restart. Start it again once it has closed.");
  relaunching = true;
  getCurrentWindow().close().catch((e) => {
    relaunching = false;
    toast(`Could not restart Loom: ${String(e)}`);
  });
}
/** The panes a restart would stop in the middle of something. */
const working = () => threads.flatMap((t) => t.panes).filter((p) => cliState(p) === "working");
let current: Thread | null = null;
/** Checkouts threads get cut from, in sidebar order. Kept past their last
 * thread so the new-thread form still offers them. */
let repos: string[] = [];
/** Project groups folded shut in the sidebar; persisted. */
let reposFolded = new Set<string>();
/** What the sidebar filter box holds, lower-cased. */
let sideQuery = "";
let sideOpen = !matchMedia("(max-width: 760px)").matches;
/** Sidebar widths, dragged from their inner edge. A CSS variable rather than
 * an inline width so the narrow-window drawer rules still win. */
const SIDE_W = { side: 280, changes: 300 };
const sideW = { ...SIDE_W };
function applySideW() {
  document.documentElement.style.setProperty("--side-w", `${sideW.side}px`);
  document.documentElement.style.setProperty("--changes-w", `${sideW.changes}px`);
}
function dragSideW(handle: HTMLElement, key: keyof typeof sideW, dir: 1 | -1) {
  handle.onpointerdown = (e) => {
    e.preventDefault();
    const start = e.clientX, from = sideW[key];
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (ev) => {
      sideW[key] = Math.round(Math.min(Math.max(from + dir * (ev.clientX - start), 160), Math.max(160, innerWidth * 0.6)));
      applySideW();
    };
    handle.onpointerup = () => { handle.onpointermove = handle.onpointerup = null; save(); };
  };
  handle.ondblclick = () => { sideW[key] = SIDE_W[key]; applySideW(); save(); };
}
// Restoring panes is asynchronous. Never replace the saved workspace with a
// half-loaded one, and serialize writes so an older snapshot cannot win.
let restoring = true;
let saveQueue: Promise<unknown> = Promise.resolve();

/** Write the workspace now. `save()` below is what everything calls; this is
 * for the two moments that can't wait: the end of boot and the window closing. */
const flushSave = (): Promise<unknown> => {
  if (restoring) return Promise.resolve();
  const json = JSON.stringify({
      threads: threads.map((t) => ({
        repo: t.repo,
        dir: t.dir,
        branch: t.branch,
        name: t.name,
        open: t.open,
        panes: t.panes.map((p) => ({ cmd: p.startup, startupSettings: p.startupSettings, sid: p.sid, stableId: p.stableId, sessionId: p.sessionId, effort: p.effort || undefined, groupIds: p.groupIds, notify: p.notify === "inherit" ? undefined : p.notify,
          notifyIds: p.notifyIds.filter((id) => journalUnreadable || id === p.id || typedTasks().some((t) => t.pane === id)) })),
        layout: t.layout,
        active: t.panes.indexOf(t.active!),
        zoomed: t.panes.indexOf(t.zoomed!),
        colW: t.colW,
        rowH: t.rowH,
        tabs: t.tabs.map(({ load, rendered, ...tab }) => tab),
        tab: t.tabs.indexOf(t.tab!),
        commitDraft: t.commitDraft,
      })),
      repos,
      agentGroups,
      reposFolded: [...reposFolded],
      startups,
      prefixes,
      prefix: prefixes.indexOf(prefix),
      langs,
      lang: langs.indexOf(lang),
      theme: theme.label,
      fontSize,
      paneMix,
      soundEnabled,
      taskbarEnabled,
      notify: notifyPolicy,
      keepAwake,
      planUsage,
      webhooks,
      speakButton: speakShown,
      overlay: overlayMode,
      ui: { thread: threads.indexOf(current!), dashboard: dashboardOpen, dashboardCompact, sideOpen, changesOpen, sideQuery, sideW: { ...sideW },
        sideScroll: $("#threads").scrollTop,
        foldedSections: [...foldedSections], foldedDirs: [...foldedDirs],
        panel, openDirs: [...openDirs], diffFull },
    });
  saveQueue = saveQueue.catch(() => {}).then(() => invoke("save_state", { json }));
  return saveQueue.catch(e => toast(`Could not save workspace: ${String(e)}`));
};
/** Throttled. Focus changes, folds and scrolls all save, and each one used to
 * serialise the whole workspace and hit the disk — a click between panes was
 * a write. Now at most one write per 300 ms, of whatever the state is by then. */
let savePending: Promise<unknown> | null = null;
const save = (): Promise<unknown> => {
  if (restoring) return Promise.resolve();
  return (savePending ??= new Promise((r) => setTimeout(r, 300)).then(() => {
    savePending = null;
    return flushSave();
  }));
};

function setFont(n: number) {
  fontSize = Math.min(Math.max(n, 8), 24);
  for (const p of threads.flatMap((t) => t.panes)) {
    p.term.options.fontSize = fontSize;
    p.resize();
  }
  save();
}

/** F3: cycle to the next pane waiting on you, wherever it lives. */
function jumpWaiting() {
  if (dashboardOpen) {
    renderDashboard();
    if (dashboardNext) revealPane(dashboardNext);
    return;
  }
  const all = threads.flatMap((t) => t.panes);
  const waiting = all.filter((p) => p.waiting);
  if (!waiting.length) return;
  const i = current?.active ? all.indexOf(current.active) : -1;
  const next = waiting.find((p) => all.indexOf(p) > i) ?? waiting[0];
  revealPane(next);
}

/** False, showing nothing, for a pane closed since whatever offered it (the
 * status bar's servers between polls); its thread's dispose empties its panes too. */
function revealPane(p: Pane) {
  if (!p.th.panes.includes(p)) return false;
  p.th.active = p; // Switching must not clear a different pane's notification.
  p.th.tab = null;
  show(p.th);
  if (p.th.zoomed && p.th.zoomed !== p) p.th.toggleZoom(p);
  if (matchMedia("(max-width: 1100px)").matches) toggleChanges(false);
  p.el.scrollIntoView({ block: "nearest" });
  return true;
}

/** The header chip: how many panes want you, across every thread. One glance
 * covers what a zoomed pane or another thread's tab would hide. */
let waitingShown = -1;
let pickerRaf = 0;
function paintWaiting() {
  const n = threads.reduce((s, t) => s + t.panes.filter((p) => p.waiting).length, 0);
  // Every pane repaint lands here; rewriting the same text would still relayout the bar.
  if (n !== waitingShown) {
    const more = n > waitingShown;
    waitingShown = n;
    const b = $("#waiting");
    b.classList.toggle("hidden", !n);
    // The bell and the count; the word is its own span, for screen readers (styles.css hides it).
    b.replaceChildren(glyph("bell"), String(n), Object.assign(document.createElement("span"), { className: "lbl", textContent: " waiting" }));
    b.setAttribute("aria-label", `${n} waiting`);
    // The Overview, where every agent is, says so too: a dot on the rail, the count in the sidebar.
    $("#dashboard-btn").classList.toggle("has-waiting", n > 0);
    $("#side-waiting").textContent = n ? `${n} waiting` : "";
    // The beacon pulses for a newcomer, then holds still (styles.css #waiting.ping).
    if (more) (b.classList.remove("ping"), void b.offsetWidth, b.classList.add("ping"));
  }
  // Once per frame however many panes changed: a burst of state flips must not
  // rebuild the open list once per pane.
  if (picker.open && !pickerRaf) pickerRaf = requestAnimationFrame(() => ((pickerRaf = 0), picker.open && renderPicker()));
}

// Agents waiting for input, in sidebar order.
const picker = $<HTMLDialogElement>("#thread-picker");
const pickerQuery = $<HTMLInputElement>("#picker-query");

/** Ctrl+K lists every agent, the ones that want you first; the waiting chip
 * opens the same list narrowed to those. */
let pickAll = false;
function openPicker(all = false) {
  hideMenu();
  togglePreferences(false);
  pickAll = all;
  pickerQuery.value = "";
  pickerQuery.placeholder = all ? "Go to an agent, thread or project" : "Filter waiting agents";
  $("#picker-title").textContent = all ? "All agents" : "Waiting for you";
  renderPicker();
  picker.showModal();
  pickerQuery.focus();
}

const STATE_RANK: Record<string, number> = { waiting: 0, busy: 1, "": 2, dead: 3 };
const STATE_WORD: Record<string, string> = { waiting: "Waiting", busy: "Working", "": "Ready", dead: "Exited" };
const STATUS: Record<string, string> = { ...STATE_WORD, "": "Idle" }; // The overview's words: "Idle" says less than "Ready" about a quiet agent.
const paneState = (p: Pane) => p.dead ? "dead" : p.waiting ? "waiting" : p.busy ? "busy" : "";

let dashboardOpen = false;
let dashboardFilter = "all";
let dashboardTimer = 0;
let dashboardSignature = "";
let dashboardCompact = false;
type AgentGroup = { id: string; name: string };
let agentGroups: AgentGroup[] = [];
const groupDialog = $<HTMLDialogElement>("#agent-group");
const groupName = $<HTMLInputElement>("#agent-group-name");
let editingGroup: AgentGroup | undefined;

function editAgentGroup(group?: AgentGroup) {
  editingGroup = group;
  $("#agent-group-title").textContent = group ? "Edit group" : "Create group";
  groupName.value = group?.name ?? "";
  groupName.setCustomValidity("");
  const list = $("#agent-group-members");
  list.replaceChildren();
  for (const th of threads) for (const p of th.panes) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = p.id;
    checkbox.checked = !!group && p.groupIds.includes(group.id);
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = `${th.name} / ${p.agent} / Pane ${th.panes.indexOf(p) + 1}`;
    const detail = document.createElement("small");
    const existing = agentGroups.filter(g => p.groupIds.includes(g.id)).map(g => g.name);
    detail.textContent = `${th.repo} · ${STATUS[paneState(p)]}${existing.length ? ` · ${existing.join(", ")}` : ""}`;
    text.append(name, detail);
    label.append(checkbox, text);
    list.append(label);
  }
  if (!list.childElementCount) list.textContent = "No agents yet. You can add them later.";
  groupDialog.showModal();
  groupName.focus();
}

$("#dashboard-new-group").onclick = () => editAgentGroup();
$("#agent-group-cancel").onclick = () => groupDialog.close();
groupName.oninput = () => groupName.setCustomValidity("");
$("#agent-group-form").onsubmit = e => {
  e.preventDefault();
  const name = groupName.value.trim();
  if (!name || agentGroups.some(g => g !== editingGroup && g.name.toLowerCase() === name.toLowerCase())) {
    groupName.setCustomValidity(name ? "A group with this name already exists." : "Enter a group name.");
    groupName.reportValidity();
    return;
  }
  const group = editingGroup ?? { id: uid(), name };
  group.name = name;
  if (!editingGroup) agentGroups.push(group);
  const selected = new Set([...$("#agent-group-members").querySelectorAll<HTMLInputElement>("input:checked")].map(input => input.value));
  for (const p of threads.flatMap(t => t.panes)) {
    p.groupIds = p.groupIds.filter(id => id !== group.id);
    if (selected.has(p.id)) p.groupIds.push(group.id);
  }
  groupDialog.close();
  renderDashboard();
  save();
};

async function deleteAgentGroup(group: AgentGroup) {
  if (!await confirm(`Delete group "${group.name}"?`, { title: "Delete group", action: "Delete group", detail: "Only this group will be deleted. Its agents and their other group memberships will be kept." })) return;
  agentGroups = agentGroups.filter(g => g !== group);
  if (dashboardFilter === `group:${group.id}`) dashboardFilter = "all";
  for (const p of threads.flatMap(t => t.panes)) p.groupIds = p.groupIds.filter(id => id !== group.id);
  renderDashboard();
  save();
}

/** "Add to group", on the shared dropdown, for one card or the whole selection:
 * a row per group that toggles these agents in or out (lit only when all of
 * them are in it), and the input starts a group with them. */
const groupMenu = (ps: Pane[]): Menu => ({
  placeholder: "new group…",
  add: (v) => {
    const name = v.slice(0, 80); // The group dialog's maxlength.
    let g = agentGroups.find(g => g.name.toLowerCase() === name.toLowerCase());
    if (!g) agentGroups.push(g = { id: uid(), name });
    for (const p of ps) if (!p.groupIds.includes(g.id)) p.groupIds.push(g.id);
    renderDashboard();
  },
  rows: (list) => {
    for (const g of agentGroups) {
      const on = ps.length > 0 && ps.every(p => p.groupIds.includes(g.id));
      const row = document.createElement("div");
      row.className = `menu-item${on ? " on" : ""}`;
      row.setAttribute("aria-pressed", String(on));
      const label = document.createElement("span");
      label.textContent = g.name;
      label.title = g.name;
      row.onclick = () => {
        const at = [...list.children].indexOf(row);
        for (const p of ps) p.groupIds = on ? p.groupIds.filter(id => id !== g.id) : p.groupIds.includes(g.id) ? p.groupIds : [...p.groupIds, g.id];
        save();
        renderMenu();
        renderDashboard();
        (list.children[at] as HTMLElement | undefined)?.focus(); // The rows were rebuilt: keep the keyboard where it was.
      };
      row.append(label);
      list.append(row);
    }
  },
});

type DashboardMessages = { user: string; agent: string };
const dashboardMessages = new Map<string, DashboardMessages & { session: string; input: number; busy: number; waiting: number; dead: boolean }>();
const dashboardMessagesBusy = new Set<string>();
let dashboardMessagesPolled = 0;
let dashboardNext: Pane | undefined;
let dashboardRows: Pane[] = []; // The listed order, which the preview's previous/next follow.
let dashboardSelecting = false; // Checkboxes on the cards, and a bar of what to do to the ticked ones.
const dashboardSelected = new Set<string>(); // Pane ids; only ever the ones in view, so a bulk action never reaches a card you can't see.
let dashboardView: { p: Pane; state: string; menu: AgentMenu | null }[] = [];
let dashboardBulkBusy = false;
const dashboardDrafts = new Map<string, string>(); // Quick replies survive the list's rebuilds.
const dashboardAnswers = new Set<string>();
let dashboardPreviewPane: Pane | null = null;
let dashboardPreviewSlot: Comment | null = null;
const dashboardPreview = $<HTMLDialogElement>("#dashboard-preview");
const dashboardPreviewOutput = $("#dashboard-preview-output");
let dashboardControlBusy = false;
const dashboardQuery = $<HTMLInputElement>("#dashboard-query");
const dashboardProject = $<HTMLSelectElement>("#dashboard-project");
// Codex's title names its thread from startup; notify only once a turn ends.
const dashboardSession = (p: Pane) => p.agent === "claude" ? p.sid : p.codexThread || p.sessionId || "";

async function refreshDashboardMessages(force = false) {
  if (!dashboardOpen || dashboardCompact || !force && Date.now() - dashboardMessagesPolled < 4000) return;
  dashboardMessagesPolled = Date.now();
  const requests = threads.flatMap(t => t.panes).filter(p => p.agent !== "shell" && dashboardSession(p) && !dashboardMessagesBusy.has(p.id))
    // busy: a read in the moment after Enter can miss the new prompt; once the
    // agent is working, it is written. A reply sent from a card is no keystroke.
    .map(p => ({ p, session: dashboardSession(p), input: p.lastIn, busy: p.busySince, waiting: p.waitingSince, dead: p.dead, key: claudeMarker(p) }))
    .filter(({ p, session, input, busy, waiting, dead }) => {
      const old = dashboardMessages.get(p.id);
      return force || !old || old.session !== session || old.input !== input || old.busy !== busy || old.waiting !== waiting || old.dead !== dead;
    });
  if (!requests.length) return;
  requests.forEach(({ p }) => dashboardMessagesBusy.add(p.id));
  // Each opencode pane gets its own call: its export takes seconds, and the
  // others should not wait on it. Each batch shows as soon as it's in.
  const batches = [requests.filter(r => r.p.agent !== "opencode"), ...requests.filter(r => r.p.agent === "opencode").map(r => [r])];
  await Promise.all(batches.filter(b => b.length).map(async batch => {
    try {
      const got = await invoke<Record<string, DashboardMessages>>("last_messages", {
        panes: batch.map(({ p, session, key }) => [key, opencodeCommand(p.startup) || p.agent, p.th.dir, session]),
      });
      for (const { p, session, input, busy, waiting, dead, key } of batch) {
        if (gone(p) || dashboardSession(p) !== session) continue; // closed meanwhile: nothing to keep
        // A field left empty (a turn's tool output past what native reads back) keeps this session's last one.
        const was = dashboardMessages.get(p.id)?.session === session ? dashboardMessages.get(p.id) : undefined;
        dashboardMessages.set(p.id, { session, input, busy, waiting, dead, user: got[key]?.user || was?.user || "", agent: got[key]?.agent || was?.agent || "" });
      }
      dashboardSignature = "";
      if (dashboardOpen) renderDashboard();
    } catch { /* Keep the last messages and retry on the next poll. */ }
    finally { batch.forEach(({ p }) => dashboardMessagesBusy.delete(p.id)); }
  }));
}

function toggleDashboard(on = !dashboardOpen) {
  dashboardOpen = on;
  document.body.classList.toggle("dashboard-open", on);
  $("#dashboard").classList.toggle("hidden", !on);
  $("#dashboard-btn").setAttribute("aria-pressed", String(on));
  $("#rail-agents").setAttribute("aria-pressed", String(!on));
  $("#side-overview").setAttribute("aria-pressed", String(on));
  paintSpeak();
  clearInterval(dashboardTimer);
  if (on) {
    hideMenu();
    togglePreferences(false);
    closeFind(false);
    mic(micStop); // also a start still opening the microphone, once it has
    if (matchMedia("(max-width: 760px)").matches) toggleSide(false);
    renderDashboard();
    void refreshDashboardMessages(true);
    dashboardQuery.focus();
    // Only read the existing terminal buffers while the overview is visible.
    dashboardTimer = window.setInterval(() => { if (!backgroundHidden()) { renderDashboard(); void refreshDashboardMessages(); } }, 1000);
  } else {
    closeDashboardPreview();
    setSelecting(false);
    current?.panes.forEach(p => p.resize());
  }
  micRefresh();
  save();
}

/** The live screen, not wherever you scrolled, with wrapped rows joined. A
 * menu wants the rows as drawn (`joined` false): Claude pads rules and headers
 * to full width, the terminal flags the next row as their wrap, and a joined
 * rule no longer ends the question above the options. */
function liveScreen(p: Pane, joined = true, surveyOnly = false) {
  // Every read stops at the screen's width: the alternate screen never reflows, so a
  // narrower terminal leaves the cells it had past it on its rows (xterm's Buffer.resize).
  // Cursor's rows always come joined: its menu reader takes an option xterm wrapped as one row.
  // Never Grok's: it cuts its rows at the width, yet xterm flags nearly every row it draws as the previous one's wrap.
  joined = p.agent === "cursor" || (joined && p.agent !== "grok");
  const buf = p.term.buffer.active;
  const lines: string[] = [];
  let survey = false;
  for (let y = buf.baseY; y < buf.baseY + p.term.rows; y++) {
    const line = buf.getLine(y);
    const text = line?.translateToString(false, 0, p.term.cols) ?? "";
    const wasSurvey = survey;
    if (claudeComposer(text) || claudeDivider(text)) survey = false;
    const continueSurvey = wasSurvey && survey;
    if (/^\s*How\b/.test(text)) survey = true;
    if (joined && (!surveyOnly || continueSurvey) && line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n");
}

/** loomctl menu: the numbered question on a pane's screen, or Claude's survey, with the id choose --menu takes. */
function paneMenu(p: Pane) {
  const m = readMenu(liveScreen(p, false), p.agent) ?? (p.agent === "claude" ? readSurvey(liveScreen(p, true, true)) : null);
  return m && { ...m, rev: menuRev(m) };
}

/** The live screen's rows as readInput's cells. */
function screenCells(p: Pane): Cell[][] {
  const buf = p.term.buffer.active, cell = buf.getNullCell(), rows: Cell[][] = [];
  for (let y = buf.baseY; y < buf.baseY + p.term.rows; y++) {
    const line = buf.getLine(y), row: Cell[] = [];
    for (let x = 0; line && x < Math.min(line.length, p.term.cols); x++) {
      line.getCell(x, cell);
      // An unwritten cell has no chars; a wide character's second cell has no width.
      row.push({ ch: cell.getWidth() ? cell.getChars() || " " : "", dim: !!cell.isDim(), inverse: !!cell.isInverse() });
    }
    rows.push(row);
  }
  return rows;
}

/** What a pane's input holds (readInput), and its revision for send --input:
 * the launch, every input write Loom made to the pane, and any draft text it
 * can see. A suggestion coming or going isn't a change: typing replaces it. */
function inputState(p: Pane) {
  const buf = p.term.buffer.active;
  const input = readInput(screenCells(p), p.agent, { x: buf.cursorX, y: buf.cursorY, hidden: p.cursorHidden });
  const seen = input.kind === "draft" ? `draft\0${input.text}` : input.kind === "unknown" ? "unknown" : "clear";
  return { ...input, rev: `${p.generation}.${p.inputSeq}.${hash32(seen)}` };
}

/** read --styles: the live screen's rows as runs of text that share a style.
 * Colors are a palette index or #rrggbb; default styles are left out. */
/** Rows from..to of the buffer with their styles; the screen's by default. */
function styledRows(p: Pane, from = p.term.buffer.active.baseY, to = from + p.term.rows) {
  const buf = p.term.buffer.active, cell = buf.getNullCell();
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  const rows: { y: number; runs: Record<string, unknown>[] }[] = [];
  for (let y = 0; y < to - from; y++) {
    const line = buf.getLine(from + y), runs: Record<string, unknown>[] = [];
    let key = "";
    for (let x = 0; line && x < Math.min(line.length, p.term.cols); x++) {
      line.getCell(x, cell);
      if (!cell.getWidth()) continue;
      const style = {
        bold: !!cell.isBold() || undefined, dim: !!cell.isDim() || undefined, italic: !!cell.isItalic() || undefined,
        underline: !!cell.isUnderline() || undefined, inverse: !!cell.isInverse() || undefined,
        fg: cell.isFgDefault() ? undefined : cell.isFgRGB() ? hex(cell.getFgColor()) : cell.getFgColor(),
        bg: cell.isBgDefault() ? undefined : cell.isBgRGB() ? hex(cell.getBgColor()) : cell.getBgColor(),
      };
      const k = JSON.stringify(style);
      if (k === key) runs[runs.length - 1].text += cell.getChars() || " ";
      else runs.push({ x, text: cell.getChars() || " ", ...JSON.parse(k) }), (key = k);
    }
    // Trailing blanks in the default style are the row's padding.
    const last = runs[runs.length - 1];
    if (last && Object.keys(last).length === 2) (last.text = String(last.text).trimEnd()) || runs.pop();
    rows.push({ y, runs });
  }
  return rows;
}

function renderDashboard() {
  const projects = [...new Set(threads.map(t => t.repo))];
  if (JSON.stringify(projects) !== JSON.stringify([...dashboardProject.options].slice(1).map(o => o.value))) {
    const selected = dashboardProject.value;
    dashboardProject.replaceChildren(new Option("All projects", ""), ...projects.map(repo => new Option(basename(repo), repo)));
    dashboardProject.value = projects.includes(selected) ? selected : "";
  }
  const q = dashboardQuery.value.trim().toLowerCase();
  const all = threads.flatMap(th => th.panes.map(p => {
    const state = paneState(p);
    // Keep terminal lines searchable, including while the expanded card shows conversation messages.
    const screen = liveScreen(p);
    const preview = screen.split("\n").map(line => line.trim()).filter(Boolean).slice(-3).join("\n");
    // Not the last output: opencode and codex redraw while idle.
    const stamp = state === "waiting" ? p.waitingSince : state === "busy" ? p.busySince : state === "dead" ? p.exitedAt : p.quietSince;
    const age = stamp ? `${STATUS[state]} · ${ago(stamp)}` : STATUS[state];
    const cached = dashboardMessages.get(p.id);
    const messages = cached?.session === dashboardSession(p) ? cached : undefined;
    const menu = state === "waiting" && p.agent !== "shell" ? readMenu(liveScreen(p, false), p.agent) : null;
    return { th, p, state, preview, age, messages, menu };
  }));
  const scoped = all.filter(({ th, p, preview, messages }) => (!dashboardProject.value || th.repo === dashboardProject.value)
    && (!q || `${th.repo} ${th.name} ${th.branch} ${p.agent} ${p.label} ${agentGroups.filter(g => p.groupIds.includes(g.id)).map(g => g.name).join(" ")} ${preview} ${messages?.user || ""} ${messages?.agent || ""}`.toLowerCase().includes(q)));
  const counts = $("#dashboard-counts");
  const selectedGroup = agentGroups.find(g => dashboardFilter === `group:${g.id}`);
  const filters = [
    ...["all", "waiting", "busy", "", "dead"].map(state => ({ key: state, label: state === "all" ? "All" : STATUS[state], group: false })),
    ...agentGroups.map(g => ({ key: `group:${g.id}`, label: g.name, group: true })),
  ];
  const filterSignature = JSON.stringify(filters);
  if (counts.dataset.signature !== filterSignature) {
    const focused = counts.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.filter : undefined;
    counts.dataset.signature = filterSignature;
    counts.replaceChildren();
    for (const { key, label, group } of filters) {
      const button = document.createElement("button");
      button.dataset.filter = key;
      if (group) button.dataset.group = key.slice(6);
      else button.dataset.state = key;
      button.append(document.createElement("b"), document.createElement("span"));
      if (group) button.prepend(Object.assign(document.createElement("i"), { className: "i i-folder", ariaHidden: "true" }));
      button.querySelector("span")!.textContent = label;
      button.onclick = () => { dashboardFilter = key; renderDashboard(); };
      counts.append(button);
    }
    if (focused !== undefined) ([...counts.querySelectorAll("button")].find(b => b.dataset.filter === focused) ?? counts.querySelector("button"))?.focus();
  }
  for (const button of counts.querySelectorAll("button")) {
    const key = button.dataset.filter!;
    const n = key === "all" ? scoped.length : scoped.filter(r => button.dataset.group ? r.p.groupIds.includes(button.dataset.group) : r.state === key).length;
    button.querySelector("b")!.textContent = String(n);
    button.setAttribute("aria-pressed", String(dashboardFilter === key));
    button.disabled = !n && !button.dataset.group && key !== "all" && dashboardFilter !== key; // Empty groups stay editable.
  }
  $<HTMLButtonElement>("#dashboard-back").disabled = !current;
  const rows = scoped.filter(r => selectedGroup ? r.p.groupIds.includes(selectedGroup.id) : dashboardFilter === "all" || r.state === dashboardFilter)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.state === "waiting" ? a.p.waitingSince - b.p.waitingSince : 0));
  dashboardRows = rows.map(r => r.p);
  dashboardView = rows.map(({ p, state, menu }) => ({ p, state, menu }));
  for (const id of dashboardSelected) if (!dashboardRows.some(p => p.id === id)) dashboardSelected.delete(id);
  dashboardNext = rows.find(r => r.state === "waiting")?.p;
  $<HTMLButtonElement>("#dashboard-next").disabled = !dashboardNext;
  $("#dashboard-next").title = dashboardNext ? `Open the oldest waiting session in this view: ${dashboardNext.th.name} / ${dashboardNext.agent}` : "No waiting sessions match this view";
  const results = $("#dashboard-results");
  const resultCount = `${rows.length} of ${all.length} sessions`;
  if (results.textContent !== resultCount) results.textContent = resultCount;
  $("#dashboard-reset").classList.toggle("hidden", !q && !dashboardProject.value && dashboardFilter === "all");
  $("#dashboard").classList.toggle("compact", dashboardCompact);
  $("#dashboard-compact").setAttribute("aria-pressed", String(dashboardCompact));
  const list = $("#dashboard-list");
  // Keep the DOM and keyboard focus stable between unchanged refreshes. Only shell cards show the
  // screen preview; an agent redrawing its status line must not rebuild every card.
  const signature = JSON.stringify([dashboardCompact, dashboardFilter, agentGroups, rows.map(({ th, p, state, preview, age, messages, menu }) => [p.id, p.groupIds, th.changed, th.name, th.repo, th.branch, p.agent, p.label, state, p.agent === "shell" && preview, age, messages?.user, messages?.agent, menu,
    p.usage && [p.usage.liveModel || p.usage.model, p.usage.ctx, p.usage.window, p.usage.turns]])]);
  if (signature !== dashboardSignature) {
    dashboardSignature = signature;
    const active = list.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focused = active?.dataset.key;
    const focusedGroup = active?.closest<HTMLElement>(".dashboard-card")?.dataset.group;
    const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : undefined;
    const fragment = document.createDocumentFragment();
    if (selectedGroup) {
      const heading = document.createElement("div");
      heading.className = "dashboard-group";
      const title = document.createElement("h2");
      title.textContent = `${selectedGroup.name} (${rows.length})`;
      heading.append(title);
      for (const action of ["Edit", "Delete"]) {
        const button = document.createElement("button");
        button.textContent = action;
        button.dataset.key = `${action}-${selectedGroup.id}`;
        button.setAttribute("aria-label", `${action} group ${selectedGroup.name}`);
        button.onclick = () => action === "Edit" ? editAgentGroup(selectedGroup) : void deleteAgentGroup(selectedGroup);
        heading.append(button);
      }
      fragment.append(heading);
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = all.some(r => r.p.groupIds.includes(selectedGroup.id)) ? "No agents match the current filters." : "No agents in this group. Use Edit to add agents.";
        fragment.append(empty);
      }
    }
    for (const { th, p, state, preview, age, messages, menu } of rows) {
      const card = document.createElement("div");
      card.className = "dashboard-card";
      card.dataset.group = selectedGroup?.id ?? "";
      card.dataset.pane = p.id;
      const row = document.createElement("button");
      row.className = "dashboard-row";
      row.dataset.key = p.id;
      row.dataset.state = state;
      row.title = `${dashboardCompact ? "Open" : "Preview"} ${p.agent} in ${th.name}`;
      if (!dashboardCompact) row.setAttribute("aria-haspopup", "dialog");
      const identity = document.createElement("span");
      identity.className = "dashboard-identity";
      identity.append(icon(p.agent));
      const name = document.createElement("strong");
      name.textContent = `${th.name} / ${p.agent}`;
      identity.append(name);
      const location = document.createElement("span");
      location.className = "dashboard-location";
      location.textContent = `${basename(th.repo)} / ${th.branch || th.dir} / Pane ${th.panes.indexOf(p) + 1}`;
      // The thread's uncommitted changes (every pane of a thread shares one worktree), then this agent's groups.
      if (th.changed.add || th.changed.del) {
        location.title = `${th.changed.files} changed file${th.changed.files === 1 ? "" : "s"} in this thread`;
        // A no-break space between the two, or "−6" wraps onto a line of its own.
        for (const [cls, text] of [["add", `+${th.changed.add}`], ["del", `−${th.changed.del}`]]) location.append(cls === "add" ? " " : " ", Object.assign(document.createElement("span"), { className: `dashboard-stat ${cls}`, textContent: text }));
      }
      for (const g of agentGroups) if (p.groupIds.includes(g.id)) location.append(" ", Object.assign(document.createElement("span"), { className: "dashboard-tag", textContent: g.name }));
      const activity = document.createElement("span");
      activity.className = "dashboard-activity";
      if (p.agent === "shell") {
        const title = document.createElement("span");
        title.textContent = p.label;
        const output = document.createElement("pre");
        output.textContent = preview || "No terminal output yet. Open the session to get started.";
        output.setAttribute("aria-label", "Latest terminal lines");
        activity.append(title, output);
      } else if (menu?.question.length) {
        // A menu's question is on screen, not in the transcript the messages come from.
        const question = document.createElement("pre");
        question.className = "dashboard-question";
        question.textContent = menu.question.join("\n");
        question.setAttribute("aria-label", `What ${p.agent} is asking`);
        activity.append(question);
      } else {
        activity.setAttribute("aria-label", "Last messages");
        // Not read yet is not the same as nothing said: opencode's export takes seconds.
        const loading = !messages && !!dashboardSession(p);
        for (const [label, value] of [["You", loading ? "Loading…" : messages?.user || "No message yet."], ["Agent", loading ? "Loading…" : messages?.agent || "No reply yet."]]) {
          const line = document.createElement("span");
          line.className = "dashboard-message";
          const who = document.createElement("b");
          who.textContent = label;
          const text = document.createElement("span");
          text.textContent = value;
          text.title = value;
          line.append(who, text);
          activity.append(line);
        }
      }
      const status = document.createElement("span");
      status.className = "dashboard-status";
      status.textContent = age;
      const usage = document.createElement("span");
      usage.className = "dashboard-usage";
      if (p.usage?.window) {
        const gauge = document.createElement("span");
        paintGauge(gauge, p.usage);
        usage.append(p.usage.liveModel || p.usage.model, gauge);
      }
      row.append(identity, location, activity, status, usage);
      const previewPane = () => openDashboardPreview(p);
      row.onclick = dashboardCompact ? () => revealPane(p) : previewPane;
      const open = document.createElement("button");
      open.className = dashboardCompact ? "dashboard-preview-button" : "dashboard-open-terminal";
      open.innerHTML = dashboardCompact ? '<i class="i i-eye" aria-hidden="true"></i>' : '<i class="i i-terminal" aria-hidden="true"></i><span>Open terminal</span>';
      open.dataset.key = `${dashboardCompact ? "preview" : "open"}-${p.id}`;
      open.title = `${dashboardCompact ? "Preview" : "Open"} ${p.agent} in ${th.name}, pane ${th.panes.indexOf(p) + 1}`;
      open.setAttribute("aria-label", open.title);
      if (dashboardCompact) open.setAttribute("aria-haspopup", "dialog");
      open.onclick = dashboardCompact ? previewPane : () => revealPane(p);
      const joined = agentGroups.filter(g => p.groupIds.includes(g.id));
      const add = document.createElement("button");
      add.className = "dashboard-group-add";
      add.innerHTML = '<i class="i i-folder-plus" aria-hidden="true"></i><span>Group</span>';
      if (joined.length) add.append(Object.assign(document.createElement("b"), { textContent: String(joined.length) }));
      add.dataset.key = `group-${p.id}`;
      add.title = joined.length ? `In ${joined.map(g => g.name).join(", ")}. Change groups for ${p.agent} in ${th.name}` : `Add ${p.agent} in ${th.name} to a group`;
      add.setAttribute("aria-label", add.title);
      add.onclick = () => showMenu(add, groupMenu([p]));
      const actions = document.createElement("div");
      actions.className = "dashboard-card-actions";
      actions.append(open, add);
      const pick = document.createElement("input");
      pick.type = "checkbox";
      pick.className = "dashboard-select";
      pick.dataset.key = `select-${p.id}`;
      pick.checked = dashboardSelected.has(p.id);
      pick.setAttribute("aria-label", `Select ${p.agent} in ${th.name}`);
      pick.onchange = () => { pick.checked ? dashboardSelected.add(p.id) : dashboardSelected.delete(p.id); renderBulk(); };
      card.append(pick, row, actions);
      if (!dashboardCompact && state === "waiting" && p.agent !== "shell") card.append(menu ? choiceRow(p, th, menu) : replyForm(p, th));
      if (dashboardAnswers.has(p.id)) card.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".dashboard-reply input, .dashboard-reply button").forEach(el => (el.disabled = true));
      fragment.append(card);
    }
    list.replaceChildren(fragment);
    if (!anchor.isConnected && !menu.classList.contains("hidden")) { // An open group menu belongs to a card that was just rebuilt.
      const next = list.querySelector<HTMLElement>(`[data-key="${anchor.dataset.key}"]`);
      if (next) { anchor = next; place(); } else hideMenu();
    }
    const restored = focused ? [...list.querySelectorAll<HTMLElement>("[data-key]")].find(el => el.dataset.key === focused && el.closest<HTMLElement>(".dashboard-card")?.dataset.group === focusedGroup) : undefined;
    if (focused) (restored ?? dashboardQuery).focus({ preventScroll: true });
    if (caret && restored instanceof HTMLInputElement) restored.setSelectionRange(caret[0], caret[1]);
  }
  renderBulk();
  $("#dashboard-empty").classList.toggle("hidden", rows.length > 0 || !!selectedGroup);
  $("#dashboard-empty").textContent = !all.length ? "No sessions yet. Create a thread to start an agent."
    : q || dashboardProject.value ? "No sessions match. Try another search or project."
    : dashboardFilter === "waiting" ? "Nothing waiting for you. Other sessions will appear here when they need attention."
    : "No sessions with this status.";
  if (dashboardPreview.open) {
    const selected = all.find(r => r.p === dashboardPreviewPane);
    if (!selected) return closeDashboardPreview();
    const { p, th, state, age } = selected;
    $("#dashboard-preview-title").textContent = `${th.name} / ${p.agent}`;
    $("#dashboard-preview-meta").textContent = `${basename(th.repo)} / ${th.branch || th.dir} / Pane ${th.panes.indexOf(p) + 1}`;
    $("#dashboard-preview-meta").title = th.dir;
    $("#dashboard-preview-status").textContent = age;
    $("#dashboard-preview-status").dataset.state = state;
    const at = dashboardRows.indexOf(p);
    $("#dashboard-preview-position").textContent = at < 0 ? "Not in this view" : `${at + 1} of ${dashboardRows.length}`;
    const elsewhere = dashboardRows.some(r => r !== p);
    $<HTMLButtonElement>("#dashboard-preview-prev").disabled = dashboardControlBusy || !elsewhere;
    $<HTMLButtonElement>("#dashboard-preview-next").disabled = dashboardControlBusy || !elsewhere;
    const u = p.usage;
    $("#dashboard-preview-usage").textContent = u ? [u.liveModel || u.model, u.window ? `${Math.round(u.ctx / u.window * 100)}% context` : "", `${u.mainTurns} turns`].filter(Boolean).join(" · ") : "";
    $<HTMLButtonElement>("#dashboard-preview-open").disabled = dashboardControlBusy;
    $<HTMLButtonElement>("#dashboard-preview-close").disabled = dashboardControlBusy;
    const process = $<HTMLButtonElement>("#dashboard-process");
    process.disabled = dashboardControlBusy;
    process.textContent = p.dead ? needsSession(p) ? "Choose session" : "Relaunch" : "Stop process";
  }
}

/** Put the previewed pane back where it came from, still running. */
function returnPreviewPane(p: Pane) {
  if (dashboardPreviewSlot) {
    if (p.th.panes.includes(p)) {
      dashboardPreviewSlot.replaceWith(p.el);
      p.resize();
    } else dashboardPreviewSlot.remove();
    dashboardPreviewSlot = null;
  }
  dashboardPreviewPane = null;
}

/** Open the preview on a pane, or switch an open preview to it. */
function openDashboardPreview(p: Pane) {
  const typing = dashboardPreviewOutput.contains(document.activeElement); // F3 from the terminal keeps you typing.
  if (dashboardPreviewPane) returnPreviewPane(dashboardPreviewPane);
  dashboardPreviewPane = p;
  dashboardPreviewSlot = document.createComment("preview pane returns here");
  p.el.replaceWith(dashboardPreviewSlot);
  dashboardPreviewOutput.append(p.el);
  $("#dashboard-control-result").textContent = "";
  if (!dashboardPreview.open) {
    dashboardPreview.showModal();
    $("#dashboard-preview-close").focus(); // Opening a preview should not focus the terminal or acknowledge an alert.
  }
  p.gpu(true);
  p.resize();
  if (typing) p.term.focus();
  renderDashboard();
}

/** Previous/next session in the listed order, wrapping; F3 skips to the oldest other waiting one. */
function stepDashboardPreview(step: 1 | -1 | "waiting") {
  const p = dashboardPreviewPane;
  if (!p || dashboardControlBusy) return;
  renderDashboard(); // Replying moves sessions between groups; follow the current order.
  const rows = dashboardRows, i = rows.indexOf(p);
  const next = step === "waiting" ? rows.filter(r => r !== p && r.waiting).sort((a, b) => a.waitingSince - b.waitingSince)[0]
    : i < 0 ? rows[step > 0 ? 0 : rows.length - 1] : rows[(i + step + rows.length) % rows.length];
  if (next && next !== p) openDashboardPreview(next);
}

/** Keys straight to the agent. Navigation leaves the waiting alert alone;
 * wrote() acknowledges a delivered answer (Enter or one key). */
function keys(p: Pane, data: string) {
  p.lastIn = Date.now(); // The echo is not the agent working.
  // An Enter Loom writes itself (loomctl's, the Overview reply's) explains the
  // next turn better than an earlier Enter of a person's that named no
  // prompt: those claim none now.
  if (data === "\r") (p.typed = null), (p.manual = p.manual.filter((m) => m.match !== null));
  p.inputSeq++;
  p.usePrompt(data);
  const sent = p.sending(data);
  return invoke<number>("pty_write", { id: p.id, data }).then((began) => p.wrote(data, true, sent, began || undefined), (e) => {
    p.wrote(data, false, sent);
    throw e;
  });
}
/** Enter, then clear the alert the way typing it would. */
async function submit(p: Pane) {
  const since = p.waitingSince, gen = p.generation;
  await keys(p, "\r");
  if (p.waitingSince === since && p.generation === gen) p.seen(); // A new alert raised meanwhile stays, and so does a new launch's.
}

/** Input that stopped short of Enter. `typed`: the text is in the running
 * process's input already, so sending it again would type it twice.
 * `pressed`: how many of a key sequence went in before it stopped. */
class NotSubmitted extends Error {
  /** Fields for loomctl's --json beside the message (a receipt to look up). */
  details: Record<string, unknown> = {};
  constructor(message: string, readonly typed: boolean, readonly pressed?: number) {
    super(message);
  }
}

/** Why input meant for launch `gen` of `p` can't go in any more, or "". */
const changed = (p: Pane, gen: number) =>
  !p.th.panes.includes(p) ? "was closed" : p.dead ? "stopped" : p.generation !== gen ? "was restarted" : "";

/** One input sequence per pane at a time. A reply pastes, waits for the echo,
 * then presses Enter; a second one arriving in between (the Overview and
 * loomctl, or two loomctl calls) would join both texts into one submission.
 * A sequence belongs to the process that was running when it was queued (or
 * to launch `gen`, which loomctl's --gen names): if the pane stops or restarts
 * before or during it, `live` stops it, so text meant for one session never
 * lands in the next. */
const inputTurns = new WeakMap<Pane, Promise<unknown>>();
function inTurn<T>(p: Pane, sequence: (live: (typed: boolean) => void) => Promise<T>, gen = p.generation): Promise<T> {
  // Whatever was typed went with the process it was typed into, so a retry is safe.
  const live = (typed: boolean) => {
    const why = changed(p, gen);
    if (why) throw new NotSubmitted(`${p.agent} ${why} ${typed ? "while Loom was typing, so Enter wasn't pressed" : "before Loom typed anything, so nothing was sent"}.`, false);
  };
  const run = (inputTurns.get(p) ?? Promise.resolve()).catch(() => {}).then(() => {
    live(false);
    return sequence(live);
  });
  inputTurns.set(p, run.catch(() => {}));
  return run;
}

const paste = (p: Pane, text: string) => (p.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
/** How long a paste may take to show before sendReply holds its Enter: three
 * times the slowest draw probed (Codex 0.160, 6,000 characters, 1.6 s). */
const ECHO_WAIT_MS = 5000;

/** The text didn't show on screen, so Enter wasn't pressed (sendReply). */
class NotShown extends NotSubmitted {}

/** How far a send got, as times: Loom began writing the text (`typing`), that
 * write finished (`typed`), it began writing Enter (`entering`), and that one
 * finished (`submitted`). A write that failed may have gone in part-way. */
type SendSteps = { typing?: number; typed?: number; entering?: number; submitted?: number };

/** Paste, then press Enter only if the text shows up on screen. On a menu or
 * anything else that doesn't take text, Enter would pick an option instead.
 * From the paste to the Enter, the paste is the only input Loom expects: other
 * loomctl calls wait their turn, but typing in the window, dictation or a drop
 * don't, and would join the text. So any of them before the paste stops the
 * send with nothing typed, and after it holds the Enter back. `beforePaste`
 * may wait (for a shell's prompt); `check` is the caller's last look, run
 * with nothing awaited between it and the paste write. */
function sendReply(p: Pane, text: string, { gen, beforePaste, check, beforeEnter, steps = {} }: { gen?: number; beforePaste?: (live: (typed: boolean) => void) => Promise<void>; check?: () => void; beforeEnter?: () => void; steps?: SendSteps } = {}) {
  return inTurn(p, async (live) => {
    const start = p.inputSeq;
    await beforePaste?.(live);
    // From here to the write starting, one synchronous stretch: nothing can
    // write between what was checked and what is typed.
    live(false);
    if (p.inputSeq !== start) {
      throw new NotSubmitted(`Something else was typed into ${p.agent} while Loom waited to type, so it typed nothing. Look at its input before sending again.`, false);
    }
    check?.();
    const before = echoes(liveScreen(p), text);
    // Counted before the write starts, so a writer during the write counts too.
    const own = p.inputSeq + 1;
    steps.typing = Date.now();
    await keys(p, paste(p, text));
    steps.typed = Date.now();
    // The echo is waited for, not read once: an agent can go quiet partway
    // through drawing a paste, longer than a settle's 150 ms (Codex 0.160 did
    // for 0.4 s on its first input after starting; its 6,000-character paste
    // took 1.6 s in all).
    for (const until = Date.now() + ECHO_WAIT_MS; ; ) {
      await p.settle(150, 1000);
      live(true);
      // Other input first: a NotShown means Loom's paste is all that went in (a held task's Enter, sendText).
      if (p.inputSeq !== own) {
        throw new NotSubmitted(`Something else was typed into ${p.agent} while Loom was pasting, so it didn't press Enter: its input holds both. Open the session and check it before sending anything.`, true);
      }
      if (echoed(before, echoes(liveScreen(p), text))) break;
      if (Date.now() >= until) {
        throw new NotShown(`${p.agent} didn't show your text, so Loom didn't press Enter. It may be typed there already: open the session before sending it again.`, true);
      }
    }
    beforeEnter?.();
    steps.entering = Date.now();
    await submit(p);
    steps.submitted = Date.now();
  }, gen);
}

/** What send --receipt hands back a token for. A shell's receipt rides on the
 * command line as a comment, and Pane.mark pairs the ;E that carries it with
 * the ;D after it, so another command on the same pane can't answer for it.
 * An agent's is the first turn after the Enter: two callers sending to one
 * agent at once can't be told apart, since it may answer both in one turn. */
/** Where an agent's "finished or needs you" came from: the terminal bell,
 * OSC 9 (Codex), OSC 99 (OpenCode's TUI) or a marker file (Claude's hooks,
 * OpenCode's plugin). */
type WakeSource = "bell" | "osc9" | "osc99" | "osc7501" | "hook";
/** What Loom wrote is kept apart from what came back. Written: the SHA-256 and
 * byte count of the text's UTF-8 (never the text: prompts hold secrets), the
 * caller's --key, when Loom accepted it, and how far its writes got (`steps`).
 * `unsent` when Enter was never written; `uncertain` names the write that
 * failed and may have gone in anyway. Back: `result` and `resultAt`, the
 * pane's own signal, which says a turn ended or a command exited, not that
 * the job was done. */
/** `pane` is the pane's id, not the pane: the last 500 settled receipts
 * outlive their panes, and must not keep a closed one's terminal alive. */
type Receipt = {
  pane: string; ref: string; gen: number; turnsAt?: number;
  result?: { failed: boolean | null; exit: number | null } | { turn: number }; resultAt?: number; settledAt?: number;
  key: string | null; sha256: string; bytes: number; acceptedAt: number; steps: SendSteps; unsent?: boolean; uncertain?: "type" | "submit";
};
const receipts = new Map<string, Receipt>();
/** Counts settlings, keys' and receipts' alike: their order decides which finished ones are kept. */
let settlings = 0;
/** A result for receipt `token`, kept only if it comes from the pane and the
 * launch the receipt was sent to: a token copied into another pane's command,
 * or a restarted pane's next turns, aren't its outcome. */
function finishReceipt(token: string, from: Pane, result: NonNullable<Receipt["result"]>) {
  const r = receipts.get(token);
  if (!r || r.result || r.pane !== from.id || r.gen !== from.generation) return;
  r.result = result;
  r.resultAt = Date.now();
  r.settledAt = ++settlings;
  keepReceipts();
}
/** A receipt is settled once it has its outcome, or can't get one (its pane
 * restarted, exited or closed). The last 500 to settle stay, however many are
 * pending; send --receipt refuses a 2001st pending one rather than drop one. */
const receiptLost = (r: Receipt) => {
  const p = paneById(r.pane);
  return !p || p.dead || p.generation !== r.gen;
};
const receiptSettled = (r: Receipt) => !!r.result || !!r.unsent || receiptLost(r);
function keepReceipts() {
  // One cut off by its pane is noticed here, not when it happened: it counts as settling now.
  for (const r of receipts.values()) if (r.settledAt === undefined && receiptSettled(r)) r.settledAt = ++settlings;
  pruneSettled(receipts, (r) => r.settledAt, 500);
}
/** An agent's turn just came in, ended `at`: it completes that launch's
 * receipts whose Enter went in before then. One whose Enter came after (Loom
 * read the turn's end late) waits for the next turn. */
function turnReceipts(p: Pane, at: number) {
  for (const [token, r] of receipts) {
    if (r.turnsAt === undefined || p.turns <= r.turnsAt || r.pane !== p.id || r.gen !== p.generation) continue;
    if ((r.steps.entering ?? 0) > at) r.turnsAt = p.turns;
    else finishReceipt(token, p, { turn: r.turnsAt + 1 });
  }
}

/** loomctl submit's tasks (task.ts), oldest first. A task's id is also its
 * receipt's token, which a shell's command line carries. One with no events
 * is still being checked, before its reservation is written: if its send
 * stops before that write, it never existed. */
const tasks = new Map<string, Task>();
/** The last event's number. The journal carries it across restarts, so a
 * watcher's place stays good. */
let taskSeq = 0;
/** Input stays usable during startup, but turns and reports cannot allocate
 * event numbers until replay initializes the journal counter. Keep their
 * order, timestamps and launch identities while the read is outstanding. */
let startupTurns: (() => void)[] | undefined = [];
/** Saved overrides under runtime owner ids, including aliases. A pane can
 * close before its buffered completion is numbered or its policy recorded. */
const startupNotify = new Map<string, PaneNotify>();
function finishTaskReplay() {
  const pending = startupTurns;
  startupTurns = undefined;
  // Reports held for an Enter still being written came after every buffered
  // one, so they go back behind what replay adds (review 2026-10-04 13:46,
  // F3). No replayed closure takes or releases a hold.
  const later = [...enterHeld.values()].map((h) => [h, h.signals.splice(0)] as const);
  pending?.forEach((run) => run());
  for (const [h, s] of later) h.signals.push(...s);
  // The pre-replay snapshot now owns these settings, including on a failed
  // write: journal recovery rewrites notifyHistory with the numbered tasks.
  startupNotify.clear();
}
/** The highest event number pruned away: a watcher behind it missed some.
 * The journal carries it too, since the tasks kept can't show it. */
let taskPruned = 0;
/** What the sweep remembers per open task, never saved: since when the agent
 * looked idle, the last Esc it judged, and when Claude's Stop hook said the
 * turn ended (the task completes once Claude is seen idle too) and the final
 * message that Stop named. */
const taskWatch = new Map<string, { quietSince?: number; escSeen?: number; stopAt?: number; response?: string; ask?: { seq: number; seen?: boolean; gone?: number } }>();
const watched = (t: Task) => taskWatch.get(t.id) ?? taskWatch.set(t.id, {}).get(t.id)!;
const paneById = (id: string) => threads.flatMap((t) => t.panes).find((p) => p.id === id);

/** Where pane `p` is now (task.ts TaskContext): its thread, its place there
 * and Loom's own title for it. Once it has left its thread, where it was then. */
function paneContext(p: Pane): TaskContext {
  if (p.left) return { ...p.left, origin: "last-known" };
  return taskContext({ threadId: p.th.id, threadName: p.th.name, paneNumber: p.th.panes.indexOf(p) + 1, paneTitle: paneTitle(p.appTitle, p.agent), capturedAt: Date.now(), origin: "event" });
}
/** The copy a new event of `t` takes: its pane as it is now, while the pane
 * is in its thread on the task's launch, else the task's last copy. */
const pendingContextTasks = new Set<Task>();
// Weak keys release the close copy when neither replay nor task history needs it.
const closedTaskContexts = new WeakMap<Task, TaskContext>();
function contextOf(t: Task): TaskContext | undefined {
  const p = paneById(t.pane);
  if (p && p.generation === t.gen) return paneContext(p);
  const last = closedTaskContexts.get(t) ?? t.context;
  return last && { ...last, origin: "last-known" };
}
/** Before panes leave their thread (closePane, Thread.dispose), each keeps
 * where it was, and so does each open task of theirs: what comes after (the
 * sweep's pane-closed, a report held for an Enter, a startup replay) names the
 * place it had, never number 0 or the pane there now. */
function keepContext(panes: Pane[]) {
  for (const p of panes) p.left ??= paneContext(p);
  for (const t of [...tasks.values(), ...pendingContextTasks]) {
    const p = !isFinal(t.state) && panes.find((q) => q.id === t.pane);
    if (p && p.generation === t.gen) {
      t.context = p.left;
      closedTaskContexts.set(t, p.left!);
    }
  }
}

let journalQueue: Promise<unknown> = Promise.resolve();
let journalLines = 0;
/** Journal calls so far, and how many a whole rewrite had seen when it was
 * taken: it holds their changes already, so they write nothing more, or a
 * queued older field could undo its newer snapshot on replay. */
let journalCalls = 0, snapshotCalls = 0;
/** The highest event number the journal holds. Watchers see no event past
 * it, so after a crash or restart (numbering goes on from the journal) no
 * number a watcher saw is used again. Appends land in event order, and an
 * append runs only after every write before it landed (a failed one makes
 * the next a whole rewrite), so landing one makes all before it durable. */
let writtenSeq = 0;
/** Wakes `watch` when a journal write lands (and when a reservation joins
 * its task, after its write), instead of a timer. */
const taskEventGate = new TaskEventGate();
/** Tasks whose latest change the journal may not have, because a write
 * failed. While any are, the next write rewrites the journal whole, which
 * puts them back. `task` shows them as `saved: false`. */
const unsaved = new Set<string>();
/** Latest queued mutation per task. An older write cannot certify a newer one. */
const pendingJournal = new Map<string, number>();
/** Policy-only writes have no task ids, but a failed one still needs recovery. */
let journalDirty = false;
/** Every journal write queued so far, landed, for a close: a failed one is
 * retried as a whole rewrite, and one that still fails rejects. A journal
 * that was never readable has nothing of its own to lose. */
async function drainJournal() {
  for (let q = journalQueue; ; q = journalQueue) {
    await q;
    if (q === journalQueue) break;
  }
  if (journalLoaded && !journalUnreadable && (journalDirty || unsaved.size)) await journal([], []);
}
/** Tasks that were reserved, the ones the journal keeps. */
const typedTasks = () => [...tasks.values()].filter((t) => t.events.length);
/** Writes to the journal, in order: appends, or the whole journal after a
 * failed write or past 5000 lines (so pruned tasks leave the file). Resolves
 * once it's written and rejects if it couldn't be; `ids` are the tasks whose
 * changes it carries. A whole rewrite holds every reserved task as it stands,
 * which covers these lines, except a reservation still being written: that
 * task has no events yet, so its line goes in after them (the first version
 * left it out and still answered `saved: true`). */
function journal(lines: object[], ids: string[]): Promise<void> {
  if (!journalLoaded || journalUnreadable) {
    ids.forEach((id) => unsaved.add(id));
    return Promise.reject(new Error(journalUnavailable()));
  }
  journalLines += lines.length;
  const call = ++journalCalls, upTo = taskSeq;
  ids.forEach((id) => pendingJournal.set(id, call));
  const write = journalQueue.then(() => {
    const covered = call <= snapshotCalls;
    const whole = !covered && (journalDirty || unsaved.size > 0 || journalLines > 5000);
    const reserving = lines.filter((l) => "task" in l && !tasks.get((l as { task: Task }).task.id)?.events.length);
    const body = covered || whole ? reserving : lines;
    if (covered && !body.length) return;
    const seenCalls = journalCalls, seenSeq = taskSeq;
    // A write that fails before reaching disk is a failed write too: the next is whole.
    const failed = (e: unknown) => {
      journalDirty = true;
      ids.forEach((id) => unsaved.add(id));
      throw e;
    };
    let text: string;
    try {
      let oldest = taskSeq + 1;
      const kept = whole ? typedTasks() : [];
      // A loop, not Math.min(...): a long history's numbers overflow an argument list.
      for (const t of kept) for (const e of t.events) if (e.seq < oldest) oldest = e.seq;
      text = (whole ? writeJournal(kept, taskSeq, taskPruned, keptNotify(notifyHistory, oldest)) : "") + body.map((l) => JSON.stringify(l)).join("\n") + "\n";
    } catch (e) {
      return failed(e);
    }
    return invoke("task_journal_write", { text, append: !whole }).then(
      () => {
        writtenSeq = Math.max(writtenSeq, whole ? seenSeq : upTo);
        if (whole) {
          snapshotCalls = seenCalls;
          unsaved.clear();
          journalDirty = false;
          journalLines = 0;
        }
        taskEventGate.notify();
      },
      failed,
    );
  });
  const settled = write.finally(() => {
    for (const id of ids) if (pendingJournal.get(id) === call) pendingJournal.delete(id);
  });
  journalQueue = settled.catch(() => {});
  return settled;
}
/** A task as loomctl shows it, with whether the journal has its latest change. */
const taskLocation = (t: Task) => {
  const p = paneById(t.pane);
  return { ref: p ? paneName(p) : null, paneClosed: !p };
};
const record = (t: Task) => ({ ...taskRecord(t), ...taskLocation(t), saved: !unsaved.has(t.id) && !pendingJournal.has(t.id) });

/** The task's first record, written before Loom types anything, so a crash
 * after the Enter still leaves its key in the journal and a retry finds the
 * task instead of typing it again. A journal that can't take it stops the
 * send with nothing typed, and the task ends cancelled. Runs in the pane's
 * input turn, before the last synchronous checks (sendReply), so input
 * arriving meanwhile still stops it. */
async function reserveTask(t: Task) {
  requireJournal();
  const accepted: TaskEvent = { seq: ++taskSeq, task: t.id, at: Date.now(), state: "accepted", signal: "loomctl", context: t.context };
  try {
    await journal([{ task: { ...t, events: [accepted] } }], [t.id]);
  } catch (e) {
    // Its number is spent, and a reader stops at a missing number that isn't
    // a gap (review 2026-10-04 13:46, F2). So the task stays, cancelled, and
    // the next write, whole since this one failed, carries both events. Its
    // key goes: nothing was typed, so a retry types it.
    t.key = null;
    t.events.push(accepted);
    moveTask(t, { state: "cancelled", signal: "loomctl", reason: "not-recorded" });
    throw new NotSubmitted(`Loom couldn't record the task in its journal (${e instanceof Error ? e.message : String(e)}), so it typed nothing.`, false);
  }
  t.events.push(accepted);
  taskEventGate.notify();
  sweepSoon();
}

/** A task moves. Fields always change and are journaled; a new state is
 * also an event, numbered. Every line carries the task's fields as they
 * stand, so a change made on its own (an answer's write in doubt) survives a
 * restart too. A final task stays as it is. Resolves to whether the journal
 * took it. A new event takes `ctx`, where the task is when the move is asked
 * for (contextOf), copied before any deferral or await. */
const taskWrites = new WeakMap<Task, Promise<void>>();
function moveTask(t: Task, c: TaskChange, at = Date.now(), ctx = contextOf(t)): Promise<boolean> {
  if (startupTurns) return new Promise((resolve) => {
    const change = { ...c };
    startupTurns!.push(() => { void moveTask(t, change, at, ctx).then(resolve); });
  });
  if (isFinal(t.state)) {
    const pending = taskWrites.get(t);
    if (pending) return pending.then(() => true, () => false);
    if (!unsaved.has(t.id)) return Promise.resolve(true);
    const recovery = journal([], [t.id]);
    taskWrites.set(t, recovery);
    return recovery.then(() => true, () => false).finally(() => taskWrites.delete(t));
  }
  const { state, signal } = c, fields = changeFields(t, c);
  const changed = Object.entries(fields).some(([k, v]) => t[k as keyof Task] !== v);
  Object.assign(t, fields);
  if (state === t.state) return changed ? journal([{ update: t.id, set: taskFields(t) }], [t.id]).then(() => true, () => false) : Promise.resolve(true);
  t.state = state;
  if (state === "working") t.startedAt ??= at;
  if (isFinal(state)) t.endedAt = at;
  const detail = c.detail ?? c.reason ?? undefined;
  const response = state === "completed" && c.response ? { response: c.response } : {};
  const event: TaskEvent = { seq: ++taskSeq, task: t.id, at, state, signal, ...(detail ? { detail } : {}), ...response, context: ctx };
  if (closedTaskContexts.has(t)) t.context = closedTaskContexts.get(t);
  else if (ctx?.origin === "event") t.context = ctx;
  t.events.push(event);
  const write = journal([{ event, set: taskFields(t) }], [t.id]);
  taskWrites.set(t, write);
  const saved = write.then(() => true, () => false).finally(() => {
    if (taskWrites.get(t) === write) taskWrites.delete(t);
  });
  // A notice goes to the phones too, once it is on record (as loomctl watch sees it).
  if (notifyKind(state)) void saved.then((ok) => { if (ok) return pushNotice(t, event); }).catch(() => {});
  if (isFinal(state)) {
    t.settledAt = event.seq;
    taskWatch.delete(t.id);
    // The pane's output so far was this turn's, never a later one's (agentTurn).
    const p = paneById(t.pane);
    if (p) p.workSince = 0;
    // Ended with its Enter still held (another write, the pane gone or
    // restarted): that Enter will never be pressed, so its receipt settles.
    const held = heldEnter.get(t.id);
    if (held) {
      heldEnter.delete(t.id);
      held.receipt.unsent = true;
      keepReceipts();
    }
    keepTasks();
  }
  return saved;
}

/** Loom's Web Push key (push.ts): made once, kept by remote.rs. */
async function pushKey(): Promise<PushKey> {
  const kept = (await invoke<{ key: PushKey | null }>("push_targets")).key;
  return kept ?? invoke<PushKey>("push_key", { key: await newPushKey() });
}

let lastPush = ""; // what the last push did, for loomctl remote
/** A notification on every phone that turned them on (docs/phone-notifications-study.md). */
async function push(message: Omit<PushMessage, "at">): Promise<{ sent: number; failed: string[] }> {
  const { key, subs } = await invoke<{ key: PushKey | null; subs: PushSub[] }>("push_targets");
  const out = { sent: 0, failed: [] as string[] };
  if (!subs.length) return out;
  const signing = key ?? (await pushKey());
  for (const sub of subs) {
    try {
      const r = await pushRequest(sub, signing, { ...message, at: Date.now() });
      const status = await invoke<number>("push_post", { endpoint: r.endpoint, headers: r.headers, body: Array.from(r.body) });
      // Its push service no longer knows it: the phone turned them off, or its browser let the subscription go.
      if (status === 404 || status === 410) await invoke("push_forget", { endpoint: sub.endpoint });
      if (status >= 200 && status < 300) out.sent++;
      else out.failed.push(`${new URL(sub.endpoint).host} answered ${status}`);
    } catch (e) {
      out.failed.push(String(e));
    }
  }
  lastPush = `${new Date().toLocaleTimeString()}: ${out.sent} sent${out.failed.length ? `, ${out.failed.join("; ")}` : ""}`;
  return out;
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", omp: "OMP", cursor: "Cursor" };
/** A task notice the policy sends, as a phone notification: what ended, and a tap opens the agent. */
async function pushNotice(t: Task, e: TaskEvent) {
  const kind = notifyKind(e.state);
  const p = paneById(t.pane);
  if (!kind || !p || !notifies(e, t.pane, notifyHistory)) return;
  const ref = paneName(p), agent = AGENT_NAMES[p.agent] ?? p.agent;
  const mins = t.startedAt ? Math.round((e.at - t.startedAt) / 60_000) : 0;
  const took = mins < 1 ? "" : mins < 60 ? ` · ${mins} min` : ` · ${Math.floor(mins / 60)} h ${mins % 60} min`;
  const menu = kind === "blocked" ? readMenu(liveScreen(p, false), p.agent) : null;
  const title = kind === "finish" ? `${ref} · ${agent} finished${took}` : kind === "blocked" ? `${ref} · ${agent} asks` : `${ref} · ${agent} failed`;
  const body = kind === "blocked"
    ? (menu ? [menu.question.join(" ").trim(), ...menu.options.map((o, i) => `${menu.keys?.[i] ?? i + 1}. ${o}`)].join("\n") : "It's waiting on you.")
    // Never e.response: it names the agent's answer (promptMatch), it isn't the answer.
    : e.detail || (kind === "finish" ? "Its task is done." : "Its task failed.");
  // stableId finds the pane again once Loom restarts and the id is gone (remote/agents.ts follow).
  await push({ title, body: body.slice(0, 600), tag: p.id, url: `/#/pane/${encodeURIComponent(p.id)}/${encodeURIComponent(ref)}/${encodeURIComponent(p.stableId)}` });
}

/** The last 500 tasks to finish stay, however many are open. */
function keepTasks() {
  const before = [...tasks.values()];
  pruneSettled(tasks, (t) => t.settledAt, 500);
  for (const t of before) if (!tasks.has(t.id)) taskPruned = Math.max(taskPruned, t.events[t.events.length - 1]?.seq ?? 0);
}

/** What a pane reported while a task's Enter was being written there, held
 * by pane until that write's outcome is on the task (sendText), then
 * replayed in order. Until then nothing says whether that Enter went in: a
 * turn of its text could be an earlier prompt's (an untracked send), and had
 * it settled the task, the write's failure would have found it final and been
 * lost. Sends to a pane take turns, but a person's Enters don't, so several
 * may be written at once: each holds the pane (holdSignals), and what came
 * meanwhile goes in only when the last of them has its outcome (review
 * 2026-10-03 19:10). The pane's other tasks wait too: what they saw before (a
 * Stop, a quiet spell, an Esc) may be overtaken by a report held here, so
 * sweepTasks judges none of them until the replay has gone in. Reports and
 * sweepTasks are the only ways an open task ends, so none ends before its own
 * Enter's outcome is on it.
 * ponytail: a write returns once the process reads its input or the pane is
 * killed; one that reads none leaves the pane's tasks open until then (or
 * until Loom restarts: unknown). A deadline if that's ever seen. */
const enterHeld = new Map<string, { signals: { signal: Signal; context?: TaskContext }[]; holds: number }>();
/** Holds a pane's reports for one Enter being written. Returns its release,
 * for once that Enter's outcome is on its task; a second call does nothing. */
function holdSignals(p: Pane): () => void {
  const held = enterHeld.get(p.id) ?? { signals: [], holds: 0 };
  held.holds++;
  enterHeld.set(p.id, held);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--held.holds > 0) return;
    enterHeld.delete(p.id);
    held.signals.forEach(({ signal, context }) => taskSignal(p, signal, context));
  };
}

/** Tasks whose text Loom typed and then didn't press Enter for, because the
 * text didn't show (sendText), with the pane's input count right after: the
 * paste was the only input of that turn, so the text may be waiting there,
 * alone. They stay `accepted`, `uncertain: "enter"`. `keys <pane> enter`
 * with nothing written since presses that Enter for the task (enterTask), and
 * it goes on as if submit had. Anything else written first may have sent the
 * text or changed it, so the task ends unknown (sweepTasks). Not kept across
 * restarts: an open task ends unknown then anyway. Each holds its receipt
 * too, unsettled (so the last-500 history never prunes it) until the Enter
 * goes in or the task ends (moveTask), and recovery updates that one. */
const heldEnter = new Map<string, { seq: number; receipt: Receipt }>();

/** The task whose held Enter `keys <pane> enter` presses: task `id`, or the
 * pane's one whose text nothing has been written after. Without `id`, none
 * (a plain Enter) when it can't be; with it, an error and nothing pressed. */
function heldTask(p: Pane, id?: string): Task | undefined {
  const t = id === undefined ? [...tasks.values()].find((t) => t.pane === p.id && heldEnter.get(t.id)?.seq === p.inputSeq) : tasks.get(id);
  const kind = (p.agent === "claude" || p.agent === "codex") && inputState(p).kind;
  const why =
    !t ? `there's no task ${id}`
    : !heldEnter.has(t.id) ? `task ${t.id} isn't waiting for its Enter (it's ${t.state})`
    : t.pane !== p.id ? `task ${t.id} is on another pane (${t.ref})`
    : t.gen !== p.generation ? `${paneName(p)} restarted since task ${t.id} was typed`
    : heldEnter.get(t.id)!.seq !== p.inputSeq ? `something else was written to ${paneName(p)} after task ${t.id}'s text`
    : p.agent !== "shell" && readMenu(liveScreen(p, false), p.agent) ? `${paneName(p)} is asking a question, which Enter would answer`
    : kind && kind !== "draft" ? `${paneName(p)}'s input reads as ${kind}, not the task's text`
    : "";
  if (!why) return t;
  if (id !== undefined) throw new NotSubmitted(`${why}, so Loom pressed nothing.`, false);
}

/** A held task's Enter (heldTask), pressed as sendText presses one: what
 * the pane reports meanwhile waits (enterHeld), and from the Enter on a
 * report of the task's text may be its (submittedAt). */
/** A task for a turn no submit asked for (task.ts TaskSource), from its Enter
 * on: accepted now, and journaled without being waited for, so a journal that
 * can't take it never stops the turn (the record says `saved: false`). Its
 * text is never kept, only its match, which the agent's reports name it by.
 * Where the pane is (`ctx`) is copied now, before the startup read can defer
 * its event. */
function turnTask(p: Pane, source: TaskSource, match: string, at: number, more: Partial<Task> = {}, ctx = paneContext(p)): Task {
  const t: Task = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), source, key: null, what: null, pane: p.id, ref: paneName(p), agent: p.agent, gen: p.generation,
    sha256: "", bytes: 0, match, input: "unknown", state: "accepted", correlation: null, uncertain: null, reason: null, detail: null, exit: null,
    acceptedAt: at, submittedAt: null, startedAt: null, endedAt: null, events: [], context: ctx, ...more,
  };
  const accept = () => {
    const accepted: TaskEvent = { seq: ++taskSeq, task: t.id, at, state: "accepted", signal: source, context: ctx };
    t.events.push(accepted);
    tasks.set(t.id, t);
    pendingContextTasks.delete(t);
    void journal([{ task: { ...t, events: [accepted] } }], [t.id]).catch(() => {});
    sweepSoon();
  };
  if (startupTurns) {
    unsaved.add(t.id);
    pendingContextTasks.add(t);
    startupTurns.push(accept);
  } else accept();
  return t;
}

/** A turn Loom saw go in, at its Enter (`at`): submitted from then on, so a
 * report of its text written before it can't be its. */
function enterTurn(t: Task, at: number, ctx = contextOf(t)) {
  if (startupTurns) return void startupTurns.push(() => enterTurn(t, at, ctx));
  t.submittedAt = at;
  moveTask(t, { state: "submitted", signal: "enter" }, at, ctx);
}

/** Text an agent shows in its input instead of what it holds: a collapsed paste or an image. */
const PLACEHOLDER = /\[Pasted text #\d+|\[Pasted Content \d+ chars\]|\[Image #\d+\]/;

/** A person gave an agent pane an Enter in Loom's window: typing in the pane,
 * the Overview's reply box, or dictation. If it may have sent a prompt (no
 * question on screen, which Enter would answer, and an input with something
 * in it where Loom can read it), it is noted with the prompt's match when Loom
 * has it (the reply's own text, or the input read off the screen), never the
 * text. Codex reports only a finished turn, so a prompt of its Loom could read
 * is a task now; anything else waits for the agent to report the turn
 * (adoptManual), so an Enter that sent nothing never becomes a task. */
function manualEnter(p: Pane, text?: string): ManualEnter | Task | undefined {
  if (p.agent === "shell" || p.dead || readMenu(liveScreen(p, false), p.agent)) return;
  // OMP sends a prompt only between turns: mid-turn it joins the turn that
  // runs (whose one done ends both), and while OMP asks, it answers.
  if (p.agent === "omp" && !(p.programState === "idle" || p.programState === "done" || p.programState === "error")) return;
  let read = text;
  if (read === undefined && p.agent !== "opencode") {
    const input = inputState(p);
    if (input.kind === "empty" || input.kind === "suggestion") return; // Enter sends nothing
    if (input.kind === "draft") read = input.text ?? undefined;
  }
  // The reply's own text is what it sent; text read off the screen may be a placeholder for it.
  const match = text !== undefined ? promptMatch(text) : read !== undefined && !PLACEHOLDER.test(read) ? promptMatch(read) : null;
  // An input Loom couldn't read, with nothing typed or pasted into this
  // launch since its last Enter, is most likely empty (reviews 2026-10-03
  // 15:52 and 19:10): an Enter there must not claim a later turn that some
  // other Enter sent.
  if (match === null && p.typed !== p.generation) return;
  const at = Date.now();
  // A slash or bang command may run no turn at all: Codex's would wait for its report.
  if (p.agent === "codex" && match && !/^\s*[/!]/.test(read!)) {
    const t = turnTask(p, "manual", match, at);
    enterTurn(t, at);
    return t;
  }
  const m: ManualEnter = { at, launch: p.generation, match };
  // An hour is longer than any one turn; the eight newest are plenty.
  p.manual = [...p.manual.filter((x) => at - x.at < 3_600_000), m].slice(-8);
  return m;
}

/** A person's Enter whose write to the process failed (review 2026-10-03
 * 15:52, P2): it may have sent nothing, so what manualEnter noted can't be
 * proven sent. A report of the same text, from an earlier prompt say, leaves
 * the doubt (uncertain: "submit"), and the turn ends unknown, never completed. */
function manualFailed(mark: ManualEnter | Task) {
  if (startupTurns) return void startupTurns.push(() => manualFailed(mark));
  if ("events" in mark) moveTask(mark, { state: mark.state, signal: "enter", uncertain: "submit" });
  else mark.uncertain = true;
}

/** Holds a pane's reports while a person's noted Enter is written, as
 * sendText does for its own, so its write's outcome is on what was noted
 * before any report of the turn is judged. Its own hold, whatever else holds
 * the pane. Returns the release. */
function holdForEnter(p: Pane, mark: ManualEnter | Task | undefined): () => void {
  return mark ? holdSignals(p) : () => {};
}

/** The Overview's reply, sent as a person's turn: its own text names it
 * (manualEnter), the pane's reports wait while its Enter is written, and an
 * Enter whose write failed leaves its turn in doubt. */
async function replyAsPerson(p: Pane, text: string) {
  const steps: SendSteps = {};
  let mark: ManualEnter | Task | undefined, release = () => {};
  try {
    await sendReply(p, text, { steps, beforeEnter: () => ((mark = manualEnter(p, text)), (release = holdForEnter(p, mark))) });
  } catch (e) {
    if (mark && steps.entering && !steps.submitted) manualFailed(mark);
    throw e;
  } finally {
    release();
  }
}

/** A report no task claimed, after a person's Enter waiting for one
 * (manualEnter): the turn it reports is theirs, a task of its own from that
 * Enter on, and the report goes to it. Claude and Cursor name a prompt as it goes in
 * (start, with its match), OpenCode and OMP only that a run started, Codex only a
 * finished turn's prompts (an end, with its mentions). A report with no such
 * Enter (a background notice's turn, say) isn't a person's: Claude's becomes
 * its own task (agentTurn). Enters older than the one a report took stay
 * untracked. True when it took the report. `ctx`:
 * where the pane was when a report the startup read deferred came. */
function adoptManual(p: Pane, s: Signal, launch: number, moved: [Task, TaskChange][], ctx?: TaskContext): boolean {
  // A replaced process's late report is stale: it starts no task, whatever Enter it went with.
  if (!p.manual.length || launch !== p.generation) return false;
  const take = (at: number, match: string | null, window: number) => {
    const i = claimManual(p.manual, at, launch, match, window);
    if (i < 0) return null;
    const m = p.manual[i];
    p.manual = p.manual.slice(i + 1);
    return m;
  };
  if (s.kind === "start" && !s.token && !moved.length && (p.agent === "claude" || reportsTurns(p.agent) ? s.match : (p.agent === "opencode" || p.agent === "omp") && !s.match)) {
    const m = take(s.at, s.match ?? null, p.agent === "claude" || reportsTurns(p.agent) ? 10_000 : Infinity);
    if (!m) return false;
    enterTurn(turnTask(p, "manual", s.match ?? m.match ?? "", m.at, { gen: launch, ...(m.uncertain ? { uncertain: "submit" } : {}) }, ctx), m.at, ctx);
    taskSignal(p, s, ctx);
    return true;
  }
  if (s.kind === "end" && p.agent === "codex" && s.matches?.length) {
    // The mentions no task took, one each, made tasks; then the turn's end goes to all of them again.
    const left = [...s.matches];
    for (const [t] of moved) {
      const i = left.indexOf(t.match);
      if (i >= 0) left.splice(i, 1);
    }
    let made = false;
    for (const match of left) {
      const m = take(s.at, match, Infinity);
      if (m) (enterTurn(turnTask(p, "manual", match, m.at, { gen: launch, ...(m.uncertain ? { uncertain: "submit" } : {}) }, ctx), m.at, ctx), (made = true));
    }
    if (made) taskSignal(p, s, ctx);
    return made;
  }
  return false;
}

/** A turn of Claude's that no Enter in Loom explains: one Claude began by
 * itself (a finished background job's notice, a scheduled wake-up) or one sent
 * from outside Loom's window. Claude reports no start for it, so Loom meets it
 * at its first Stop, question or failure, with no task open on the pane. It
 * becomes a task of its own (source "agent"), working since its output began
 * after the pane's last task ended (Pane.workSince: a report can reach Loom
 * before any output of its own turn does) or else since the report, and the
 * report then goes to it, so it ends and notifies as any turn does. Never
 * with a task open (the report is that task's, or comes between its Enter and
 * its start), and never from a replaced process. True when it made one. */
function agentTurn(p: Pane, s: Signal, launch: number, open: Task[], ctx?: TaskContext): boolean {
  if (p.agent !== "claude" || open.length || launch !== p.generation || !(s.kind === "stop" || s.kind === "approval" || s.kind === "fail")) return false;
  const at = p.workSince > 0 && p.workSince <= s.at ? p.workSince : s.at;
  const t = turnTask(p, "agent", "", at, { gen: launch }, ctx);
  void moveTask(t, { state: "working", signal: "agent", correlation: "sequence" }, at, ctx);
  // An Esc or Ctrl-C before its report didn't end it (Claude reported on after
  // it), so the sweep never judges that one.
  if (p.interruptAt <= s.at) watched(t).escSeen = p.interruptAt;
  taskSignal(p, s, ctx);
  return true;
}

/** The notification policy's history as the journal keeps it (task.ts notifies), oldest first. */
let notifyHistory: NotifySnapshot[] = [];
let notifyOwners: NonNullable<NotifySnapshot["owners"]> = {};
/** The current snapshot's outstanding write, including its rejection. */
let notifyWrite: Promise<void> | undefined;
/** The policy as it stands, including each restored pane's historical ids.
 * Closed panes keep their last setting while their tasks or Enter-held
 * reports remain. A new pane at the same ref has no aliases to the closed one. */
const currentNotify = (): Omit<NotifySnapshot, "at"> => {
  const live = threads.flatMap((t) => t.panes), last = notifyHistory[notifyHistory.length - 1];
  const kept = new Set([...tasks.values()].map((t) => t.pane));
  return {
    on: notifyPolicy.on, kinds: { ...notifyPolicy.kinds },
    ...(journalLoaded ? { owners: Object.fromEntries(Object.entries(notifyOwners).filter(([id]) => kept.has(id))) } : {}),
    panes: {
      // A captured inherit removes an old explicit override, just as a live pane does.
      ...Object.fromEntries(Object.entries(last?.panes ?? {}).filter(([id]) => (kept.has(id) || enterHeld.has(id)) && !startupNotify.has(id) && !live.some((p) => p.notifyIds.includes(id)))),
      ...Object.fromEntries([...startupNotify].filter((entry): entry is [string, "on" | "off"] => entry[1] !== "inherit" && !live.some((p) => p.notifyIds.includes(entry[0])))),
      ...Object.fromEntries(live.filter((p) => p.notify !== "inherit").flatMap((p) => p.notifyIds.map((id) => [id, p.notify as "on" | "off"]))),
    },
  };
};
/** Journals the policy when it changed. It decides every event from the next
 * one on, and an event it turns off stays off (notifies). */
async function recordNotify() {
  requireJournal();
  const now = currentNotify(), last = notifyHistory[notifyHistory.length - 1];
  const same = sameNotify(last ?? DEFAULT_NOTIFY, now);
  if (same && notifyWrite) return notifyWrite;
  if (same && !journalDirty) return;
  if (!same) notifyHistory.push({ at: taskSeq, ...now });
  const write = journal([{ notify: now, at: taskSeq }], []).catch((e) => {
    throw new Error(`Notification policy changed in memory but was not saved to the task journal (${e instanceof Error ? e.message : String(e)}). Retry the change to save it.`);
  });
  notifyWrite = write;
  try {
    await write;
  } finally {
    if (notifyWrite === write) notifyWrite = undefined;
  }
}
/** Apply the complete policy synchronously, then await its single snapshot. */
async function setNotify(change: Partial<typeof notifyPolicy>, own?: { pane: Pane; value: PaneNotify }) {
  requireJournal();
  notifyPolicy = { ...notifyPolicy, ...change };
  if (own) own.pane.notify = own.value;
  paintNotifications();
  save();
  await recordNotify();
}
function setPaneNotify(p: Pane, v: PaneNotify) {
  return setNotify({}, { pane: p, value: v });
}
/** A pane's bell: like every pane, or its own on or off. */
const notifyMenu = (p: Pane): Menu => ({
  placeholder: "",
  rows: (list) => {
    for (const [v, label] of [["inherit", `Like every pane (now ${notifyPolicy.on ? "on" : "off"})`], ["on", "On for this pane"], ["off", "Off for this pane"]] as const)
      menuItem(list, `${p.notify === v ? "✓ " : "   "}${label}`, () => void setPaneNotify(p, v).catch(notifyError));
  },
});
/** Each pane's notices as they stand: its setting, and whether each kind goes out now. */
const notifyRow = (p: Pane) => ({
  pane: p.id, ref: paneName(p), notify: p.notify,
  ...Object.fromEntries(NOTIFY_KINDS.map((k) => [k, allows(currentNotify(), p.id, k)])),
});
/** A reusable ref is only a hint for a person reviewing an old owner, never identity. */
const unresolvedNotices = () => Object.entries(notifyOwners).filter(([, v]) => v === "held").flatMap(([owner]) => {
  const owned = typedTasks().filter((t) => t.pane === owner);
  return owned.length ? [{ owner, refs: [...new Set(owned.map((t) => t.ref))], tasks: owned.map((t) => t.id) }] : [];
});
const unresolvedText = () => unresolvedNotices().map((r) => `held owner ${r.owner} (${r.refs.join(", ")}); review with notify --resolve-owner ${r.owner} release|mute`).join("\n");

async function enterTask(p: Pane, t: Task) {
  const r = heldEnter.get(t.id)!.receipt;
  heldEnter.delete(t.id);
  const release = holdSignals(p);
  if (p.agent !== "shell") r.turnsAt = p.turns;
  const entering = Date.now();
  r.steps.entering = entering;
  try {
    await submit(p);
  } catch (e) {
    r.uncertain = "submit";
    t.submittedAt = entering;
    moveTask(t, { state: "submitted", signal: "enter", uncertain: "submit", detail: null }, entering);
    release();
    throw Object.assign(new NotSubmitted(`Writing Enter into ${paneName(p)} failed (${e instanceof Error ? e.message : String(e)}), so it may or may not have gone in. Don't press it again: loomctl read ${paneName(p)} shows whether the text still waits.`, true), { details: { task: t.id, uncertain: "submit" } });
  }
  r.steps.submitted = Date.now();
  t.submittedAt = entering;
  const saved = moveTask(t, { state: "submitted", signal: "enter", uncertain: null, detail: null }, entering);
  release();
  await saved;
}

/** What an agent or the pane's own marks reported: it moves the tasks that
 * it concerns (task.ts route), only those on the launch that reported it. A
 * Stop is held until Claude is seen idle (sweepTasks). One the startup read
 * defers takes where the pane is now (`ctx`) along, for its launch's tasks. */
function taskSignal(p: Pane, s: Signal, ctx?: TaskContext) {
  const held = enterHeld.get(p.id);
  if (held) return void held.signals.push({ signal: { ...s, launch: s.launch ?? p.generation }, context: ctx });
  if (startupTurns) {
    const signal = { ...s, launch: s.launch ?? p.generation };
    const now = ctx ?? (signal.launch === p.generation ? paneContext(p) : undefined);
    return void startupTurns.push(() => taskSignal(p, signal, now));
  }
  const launch = s.launch ?? p.generation;
  let open = [...tasks.values()].filter((t) => t.pane === p.id && t.gen === launch && t.events.length && !isFinal(t.state));
  // A report naming its turn goes to the task that turn's start moved, however
  // late, and never to a task another turn's start moved (turnTasks). Cursor's
  // question names the turn running when it shows (cursorAsks).
  const turn = s.kind === "end" || s.kind === "fail" || s.kind === "interrupt" || s.kind === "approval" ? s.turn : undefined;
  if (turn) {
    const own = turnTasks.get(`${p.id}:${launch}:${turn}`), tied = new Set(turnTasks.values());
    open = open.filter((t) => (own ? t.id === own : !tied.has(t.id)));
  }
  // An agent's start names a prompt by its text alone, never by the Enter
  // that sent it, so it can't prove a doubted Enter went in: an earlier prompt
  // of the same text, its report written late, looks the same (task.ts
  // changeFields keeps the doubt; only a shell's token, which is this task's
  // own, clears it).
  const moved = route(open, s);
  if (s.kind === "start" && s.turn) {
    for (const [t, c] of moved) if (c.state === "working") turnTasks.set(`${p.id}:${launch}:${s.turn}`, t.id);
    if (turnTasks.size > 1000) turnTasks.delete(turnTasks.keys().next().value!);
  }
  if (adoptManual(p, s, launch, moved, ctx) || (!moved.length && agentTurn(p, s, launch, open, ctx))) return;
  for (const [t, c] of moved) {
    // The latest Stop's final message is the one its completion names.
    if (c.signal === "stop") Object.assign(watched(t), { stopAt: Date.now(), response: s.kind === "stop" ? s.response : undefined });
    else {
      // Asking after a Stop: another Stop hook sent Claude on, so that Stop ended nothing.
      if (c.state === "approval") Object.assign(watched(t), { stopAt: undefined, response: undefined });
      moveTask(t, c, s.at, ctx);
    }
  }
}

/** What a write means to the process, read as it's typed (Pane.sending). */
type Meant = { gen: number; answer: boolean; menu?: string; stop?: { turn?: string; at: number; release: () => void } };
/** A Grok Stop the pane holds (Pane.grokStop). */
type GrokStop = Extract<Signal, { kind: "stop" }>;

/** A Cursor pane's reports, held unjudged while an Esc or Ctrl-C that stops
 * its turn is written (Pane.sending). Cursor's stop reports can arrive before
 * the write is acknowledged, and its error is that interrupt only if the key
 * went in, and before Cursor wrote it (Pane.wrote, agentReport): judged at
 * once, a real Esc's error would fail the turn, and its aborted would then be
 * a duplicate. Judged in order once every such write's outcome is in.
 * ponytail: as with an Enter's hold (holdSignals), a write returns once the
 * process reads its input or the pane is killed. */
const reportsHeld = new Map<string, { events: [string, unknown][]; holds: number }>();
/** Holds a pane's reports for one write. Returns its release; a second call does nothing. */
function holdReports(p: Pane): () => void {
  const held = reportsHeld.get(p.id) ?? { events: [], holds: 0 };
  held.holds++;
  reportsHeld.set(p.id, held);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--held.holds > 0) return;
    reportsHeld.delete(p.id);
    agentEvents(held.events);
  };
}

/** Turns whose stop already counted, by pane, launch and the agent's own
 * turn id: Codex's end, which can come twice, and Cursor's first stop of a
 * turn, which an Esc or Ctrl-C makes two (aborted and an error, in either
 * order, both naming it). A turn reported again moves nothing. */
const turnsSeen = new Set<string>();
/** The task each turn's start moved, by pane, launch and the turn's own id
 * (Cursor's generation_id), kept after the task ends. A report naming the
 * turn goes to that task alone (taskSignal): a slow hook's stop for a turn
 * that a newer one followed still ends its own, and never the newer one's. */
const turnTasks = new Map<string, string>();
/** The last numbered batch of reports handled: closing waits for every one Rust sent before it shut the panes down. */
let agentBatch = 0;
const agentBatches = new Map<number, [string, unknown][]>();
function receiveAgentBatch(batch: { seq: number; events: [string, unknown][] }) {
  if (batch.seq <= agentBatch) return;
  agentBatches.set(batch.seq, batch.events);
  // ponytail: a batch that never lands holds back at most 64 behind it, then is given up on.
  routeAgentBatches(agentBatches.size > 64 ? Math.min(...agentBatches.keys()) : agentBatch);
}
/** Routes the held batches in order: every one up to `skipTo`, a missing one
 * below it given up on, then those that follow on without a gap. */
function routeAgentBatches(skipTo: number) {
  for (const seq of [...agentBatches.keys()].sort((a, b) => a - b)) {
    if (seq > skipTo && seq !== Math.max(agentBatch, skipTo) + 1) break;
    agentEvents(agentBatches.get(seq)!);
    agentBatches.delete(seq);
    agentBatch = seq;
  }
  agentBatch = Math.max(agentBatch, skipTo);
}
/** An agent's report from its event file (lib.rs send_task_events). */
/** Reports from the agents, as Rust hands them over (send_task_events, pty_shutdown). */
function agentEvents(events: [string, unknown][]) {
  const started = new Set<Pane>();
  for (const [id, ev] of events) {
    const held = reportsHeld.get(id);
    if (held) {
      held.events.push([id, ev]);
      continue;
    }
    const p = paneById(id), s = parseSignal(ev);
    if (!p || !s) continue;
    // A report names the agent whose hooks wrote it. Another agent's isn't this
    // pane's: Grok's hooks are global, so a grok Claude starts runs them here too.
    const src = (ev as { src?: unknown }).src;
    if (typeof src === "string" && ["claude", "codex", "cursor", "grok", "opencode"].includes(src) && src !== p.agent) continue;
    agentReport(p, s);
    if (s.kind === "start") started.add(p);
  }
  // A question Cursor drew before Loom read its turn's start asked in no task:
  // the task was still submitted. It asks once the whole batch has said which
  // turn runs now, never after an older start the batch replays.
  for (const p of started) if (reportsTurns(p.agent) && p.cursorAsking) p.cursorAsks();
}
function agentReport(p: Pane, s: Signal) {
  if (p.agent === "grok") {
    const now = p.grokReport(s);
    if (!now) return;
    s = now;
  }
  const stopped = s.kind === "end" || (reportsTurns(p.agent) && (s.kind === "fail" || s.kind === "interrupt")) ? s.turn : undefined;
  if (stopped) {
    const key = `${p.id}:${s.launch ?? p.generation}:${stopped}`;
    if (turnsSeen.has(key)) return;
    turnsSeen.add(key);
    if (turnsSeen.size > 1000) turnsSeen.delete(turnsSeen.values().next().value!);
  }
  if (reportsTurns(p.agent) && (s.launch ?? p.generation) === p.generation) {
    // The first Esc or Ctrl-C that went in after this turn's prompt hook
    // stopped it, even one Loom sent before it heard of the turn (the hooks
    // are read every 250 ms). Starts come in order, so one before this start
    // stops no turn Loom has yet to hear of.
    if (s.kind === "start" && s.turn) {
      p.cursorEscs = p.cursorEscs.filter((at) => at >= s.at);
      if (p.cursorEscs.length) p.cursorEsc.set(s.turn, p.cursorEscs[0]);
    }
    // The newest start is the pane's current turn, and it runs.
    if (s.kind === "start") (p.cursorGen = s.turn), p.cursorRuns(true);
    if (s.kind === "end" || s.kind === "fail" || s.kind === "interrupt") {
      // A turn's first stop (turnsSeen) goes to that turn's task (taskSignal),
      // even after a newer turn started. The error of a turn an Esc or Ctrl-C
      // went into, written after it, is that interrupt. Any other error is its
      // own, even one Loom reads after the Esc: Loom sent the Esc to the turn
      // it last heard of, which may have failed already.
      const turn = s.turn;
      if (turn) {
        const esc = p.cursorEsc.get(turn);
        if (s.kind === "fail" && esc !== undefined && esc <= s.at) s = { at: s.at, launch: s.launch, kind: "interrupt", turn };
        p.cursorEsc.delete(turn);
      }
      // The current turn's stop ends it on the pane. Done or failed raises the
      // alert, and stopped raises none (OMP's idle after Esc raises none
      // either). An older turn's stop ends its own task, which notifies, while
      // the pane and its receipts wait for the newer turn's end. The stop's
      // own time counts the turn: a send whose Enter went in after it, before
      // Loom read it, waits for its own turn (turnReceipts). The alert goes
      // first: cursorRuns redraws an open Overview, which then shows it.
      if (!s.turn || s.turn === p.cursorGen) {
        if (s.kind !== "interrupt" && !p.dead) p.wake(undefined, "hook", s.at);
        p.cursorRuns(false);
      }
    }
  }
  taskSignal(p, s);
}

/** How long an agent may look idle, with a task working and no end reported,
 * before the task's outcome is unknown, and how long a shell may leave a
 * submitted line unstarted. Claude's and Codex's own reports come within a
 * second of a turn's end, and a shell at its prompt starts a line at once.
 * ponytail: one fixed wait; a per-agent one if an agent reports slower. */
const QUIET_MS = 30_000;
let sweepTimer = 0;
function sweepSoon() {
  if (!sweepTimer) sweepTimer = window.setInterval(() => sweepTasks(), 500);
}
/** What no agent reports, read off the pane every half second while a task
 * is open: the pane closed, restarted or exited; a shell never started its
 * line; an agent with no report of its own began working (screen); Esc or
 * Ctrl-C interrupted it (no hint 2 s later; a turn that ended first has
 * reported by then); Claude's Stop stuck (it's idle: no other Stop hook sent
 * it on working); or an agent sat idle with no end reported (unknown, never
 * completed). `closing`: Loom is shutting down and the panes are gone, so a
 * Stop is judged on the screen they left now, and one it can't confirm ends
 * unknown rather than wait for a next sweep that won't come. */
/** Closing, once shutdown's reports are in: each Grok Stop still held asks
 * Grok's session log how its turn ended (Pane.grokOver), and every read of it
 * still out, the ones routing those reports started too, comes back before
 * the sweep ends what's left. */
async function closeTasks() {
  const panes = new Set([...tasks.values()].filter((t) => !isFinal(t.state)).map((t) => paneById(t.pane)));
  for (const p of panes) if (p?.grokStop) p.grokOver(p.grokStop, true);
  await Promise.all([...panes].map((p) => p?.grokReads));
  sweepTasks(true);
}
function sweepTasks(closing = false) {
  if (shuttingDown && !closing) return;
  const now = Date.now();
  let open = 0;
  for (const t of tasks.values()) {
    if (isFinal(t.state) || (t.state === "accepted" && !heldEnter.has(t.id))) {
      if (t.state === "accepted") open++; // its send decides; the sweep waits for it
      continue;
    }
    // The pane's reports are held while a task's Enter is written (taskSignal),
    // and one may decide this task: an old Stop, the pane's state or a quiet
    // spell mustn't first. Idle seen before the hold doesn't count after it.
    if (enterHeld.has(t.pane)) {
      open++;
      watched(t).quietSince = undefined;
      continue;
    }
    const p = paneById(t.pane);
    if (!p || gone(p)) {
      moveTask(t, { state: "cancelled", signal: "pane", reason: "pane-closed" });
      continue;
    }
    if (p.generation !== t.gen) {
      moveTask(t, { state: "cancelled", signal: "pane", reason: p.dead ? "pane-stopped" : "pane-restarted" });
      continue;
    }
    if (p.dead && !closing) {
      moveTask(t, { state: "failed", signal: "pane", reason: "exited" });
      continue;
    }
    open++;
    if (heldEnter.has(t.id)) {
      // Written to since its text was typed, by anything but its own Enter
      // (enterTask): that may have sent the text, or changed it.
      if (p.inputSeq !== heldEnter.get(t.id)!.seq) moveTask(t, { state: "unknown", signal: "pane", reason: "not-submitted", detail: "something else was written to the pane while its text waited for Enter, so Loom can't tell whether it was sent" });
      continue;
    }
    if (p.agent === "shell") {
      // OSC 133 reports the rest of a shell's command; an Enter that never took leaves no mark.
      if (t.state === "submitted" && now - (t.submittedAt ?? now) >= QUIET_MS) moveTask(t, { state: "unknown", signal: "quiet", reason: "no-start-signal" });
      continue;
    }
    const w = watched(t);
    // Claude Code 2.1.288 draws no hint while it works: its working line says so instead.
    // Codex hides its status row, hint and all, while it streams an answer (seen
    // live 2026-10-04: two turns ended unknown mid-answer, after web searches):
    // its title's run state says the turn still runs, and once it has one, it
    // alone does. A hint is read only where the agent draws it (interruptHint).
    const screen = p.screen(true);
    const busy = p.agent === "omp" ? p.programState === "working"
      : p.agent === "grok" ? p.grokBusy()
      : reportsTurns(p.agent) && p.cursorTurn !== undefined ? p.cursorTurn
      : p.agent === "codex" && p.codexState !== undefined ? codexRunning(p.codexState)
      : (p.agent === "claude" && claudeWorking(screen)) || interruptHint(p.screen(true, true), p.agent, () => screenCells(p));
    // Esc or Ctrl-C after the Enter (a turn Claude began by itself has none:
    // after it began) and after any Stop, judged once, 2 s on.
    const esc = p.interruptAt;
    const escNew = esc > (t.submittedAt ?? t.startedAt ?? Infinity) && esc > (w.stopAt ?? 0) && esc !== w.escSeen;
    if (escNew && now - esc >= 2000) {
      w.escSeen = esc;
      if (!busy) {
        moveTask(t, unproven(t, { state: "cancelled", signal: "interrupt", reason: "interrupted" }));
        continue;
      }
    }
    // A Stop holds once Claude is seen idle at its input: no hint, and its
    // input line on screen (readInput reads it: a permission dialog, numbered
    // or not, takes its place and shows no hint either), and no numbered
    // question. An asking task holds none: an approval clears it (taskSignal),
    // and route gives it no Stop.
    const idleInput = () => readInput(screenCells(p), "claude").kind !== "unknown" && !readMenu(liveScreen(p, false), p.agent);
    if (w.stopAt !== undefined && !busy && (closing || now - w.stopAt >= 500) && !(escNew && w.escSeen !== esc) && idleInput()) {
      moveTask(t, unproven(t, { state: "completed", signal: "turn-end", ...(w.response ? { response: w.response } : {}) }));
      continue;
    }
    // Grok's Stop for this task's turn, still held: its session log never said it succeeded (closeTasks).
    const grok = p.agent === "grok" && p.grokStop && (!p.grokStop.turn || turnTasks.get(`${p.id}:${t.gen}:${p.grokStop.turn}`) === t.id) ? p.grokStop : undefined;
    if (closing && (w.stopAt !== undefined || grok)) {
      // Only a completed event names a final message (loomctl watch --metadata): this one keeps it in its detail.
      const response = grok ? grok.response : w.response;
      const why = grok ? "its session log never recorded the turn succeeding, and no report said how it ended" : "its screen never showed it idle";
      moveTask(t, { state: "unknown", signal: "stop", reason: "loom-closed", detail: `${grok ? "Grok" : "Claude"} reported the end of its turn as Loom closed, but ${why}${response ? ` (final message ${response})` : ""}` });
      continue;
    }
    if (t.state === "approval") {
      // An answer delivered moves it on (Pane.wrote). One given where Loom
      // can't see it (Claude's own remote control) still takes the question
      // off the screen: its menu seen, then gone for 2 s, the agent works on.
      // A question Loom can't read as a menu (Codex's free-text ones) waits
      // for its answer. Each approval, by the event that began it, starts unseen.
      const seq = t.events[t.events.length - 1]?.seq ?? 0;
      const ask = w.ask?.seq === seq ? w.ask : (w.ask = { seq });
      if (p.agent !== "opencode" && readMenu(liveScreen(p, false), p.agent)) Object.assign(ask, { seen: true, gone: undefined });
      else if (ask.seen && now - (ask.gone ??= now) >= 2000) moveTask(t, { state: "working", signal: "answered", detail: null });
      continue;
    }
    if (busy) {
      w.quietSince = undefined;
      if (t.state === "submitted") moveTask(t, { state: "working", signal: "screen", correlation: "screen" });
    } else if (now - (w.quietSince ??= now) >= QUIET_MS) {
      moveTask(t, { state: "unknown", signal: "quiet", reason: "no-end-signal" });
    }
  }
  if (!open) {
    clearInterval(sweepTimer);
    sweepTimer = 0;
  }
}

/** Why the journal couldn't be read at start, if it couldn't: submit then
 * refuses, since it can't find an earlier task's --key, and nothing rewrites
 * the file. */
let journalUnreadable = "";
let journalLoaded = false;
const journalUnavailable = () => journalUnreadable
  ? `Task history is unavailable because Loom couldn't read its journal (${journalUnreadable}). Fix or move the file and restart Loom. Durable tracking and policy changes are unavailable until then.`
  : "Task history is still loading. Retry after startup finishes. Durable tracking and policy changes are unavailable until then.";
function requireJournal() {
  if (!journalLoaded || journalUnreadable) throw new Error(journalUnavailable());
}
const notifyError = (error: unknown) => toast(error instanceof Error ? error.message : String(error));
/** The journal read back at start. Tasks still open belonged to processes
 * that ended with the Loom before, so their outcome is unknown. Then the
 * journal is rewritten with only what was kept. lib.rs keeps the lines
 * before a tail an interrupted append tore. */
async function loadTasks() {
  let text: string, got: ReturnType<typeof readJournal>;
  try {
    text = (await invoke<string>("task_journal_read")) ?? "";
    got = readJournal(text); // throws on a record of the wrong shape: unavailable, never shorter
  } catch (e) {
    journalUnreadable = e instanceof Error ? e.message : String(e);
    finishTaskReplay(); // Keep turns visible as unsaved; the journal remains unavailable.
    return;
  }
  journalUnreadable = "";
  notifyHistory = got.notify;
  const lastPolicy = got.notify[got.notify.length - 1];
  notifyOwners = { ...lastPolicy?.owners };
  // Numbering goes on from the journal: no watcher saw an event it doesn't hold (writtenSeq).
  taskSeq = writtenSeq = got.seq;
  taskPruned = Math.max(taskPruned, got.pruned);
  // This run's policy, with the panes' own settings under their new ids, is
  // in force before any startup turn or restart event is numbered (review
  // 2026-10-04 13:46, F1). For a journal without owners it is the migration.
  if (!text && !got.tasks.size) {
    journalLoaded = true;
    void recordNotify().catch(notifyError);
    finishTaskReplay();
    return;
  }
  for (const t of got.tasks.values()) (tasks.set(t.id, t), unsaved.add(t.id)); // the first write is the whole journal
  if (lastPolicy?.owners === undefined) {
    // A hold never guesses which live pane, if any, owns a legacy task's reused reference.
    const linked = new Set([...startupNotify.keys(), ...threads.flatMap((t) => t.panes.flatMap((p) => p.notifyIds))]);
    for (const t of got.tasks.values()) if (!linked.has(t.pane)) notifyOwners[t.pane] = "held";
  }
  journalLoaded = true; // Classification is complete, even for a journal with no owners.
  void recordNotify().catch(notifyError);
  for (const t of got.tasks.values()) if (!isFinal(t.state)) moveTask(t, { state: "unknown", signal: "restart", reason: "loom-restarted" });
  keepTasks();
  void journal([], []).catch(() => {}); // rewritten with only what was kept, even with nothing to move
  finishTaskReplay();
}

/** Pick option `i` the way a person would: one arrow key at a time, reading the
 * screen after each, and Enter only once `i` is highlighted. If the menu on
 * screen stops being the one the button came from (its question, options or
 * kind, see menuRev), nothing is chosen. */
function choose(p: Pane, menu: AgentMenu, i: number, gen?: number) {
  return inTurn(p, async (live) => {
    const want = menuRev(menu);
    for (let step = 0; step <= menu.options.length; step++) {
      live(step > 0);
      const screen = liveScreen(p, false);
      const now = readMenu(screen, p.agent) ?? (p.agent === "claude" ? readSurvey(liveScreen(p, true, true)) : null);
      if (!now || menuRev(now) !== want) throw new Error(`The question on ${p.agent}'s screen changed, so nothing was chosen.`);
      if (now.keys) return keys(p, now.keys[i]);
      if (now.selected === i) return submit(p);
      await keys(p, (p.term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + (now.selected > i ? "A" : "B"));
      await p.settle(80, 800);
    }
    throw new Error(`Loom couldn't move ${p.agent}'s highlight to that option. Open the session to answer.`);
  }, gen);
}

/** Lock every copy of an agent while sending, including cards in other groups. */
async function answer(p: Pane, send: () => Promise<void>) {
  if (dashboardAnswers.has(p.id)) return;
  dashboardAnswers.add(p.id);
  const controls = [...$("#dashboard-list").querySelectorAll<HTMLInputElement | HTMLButtonElement>(`[data-pane="${p.id}"] .dashboard-reply :is(input, button)`)];
  controls.forEach(c => (c.disabled = true));
  try {
    await send();
  } catch (error) {
    toast(error instanceof Error ? error.message : `Could not answer ${p.agent}: ${String(error)}`); // Write failures arrive as strings.
  } finally {
    dashboardAnswers.delete(p.id);
    controls.forEach(c => (c.disabled = false));
    dashboardSignature = "";
    renderDashboard();
    ($("#dashboard-list").querySelector<HTMLElement>(".dashboard-reply :is(input, button)") ?? dashboardQuery).focus();
  }
}

/** One line to answer a waiting agent without opening it. */
function replyForm(p: Pane, th: Thread) {
  const form = document.createElement("form");
  form.className = "dashboard-reply";
  const input = document.createElement("input");
  input.dataset.key = `reply-${p.id}`;
  input.placeholder = `Reply to ${p.agent}`;
  input.setAttribute("aria-label", `Reply to ${p.agent} in ${th.name}`);
  input.spellcheck = false;
  input.value = dashboardDrafts.get(p.id) ?? "";
  input.oninput = () => {
    dashboardDrafts.set(p.id, input.value);
    $("#dashboard-list").querySelectorAll<HTMLInputElement>(`[data-key="reply-${p.id}"]`).forEach(copy => { if (copy !== input) copy.value = input.value; });
  };
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  send.title = `Send to ${p.agent} and press Enter`;
  form.append(input, send);
  form.onsubmit = e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) void answer(p, async () => {
      await replyAsPerson(p, text);
      dashboardDrafts.delete(p.id);
    });
  };
  return form;
}

/** The options of a menu on the agent's screen, one button each. */
function choiceRow(p: Pane, th: Thread, menu: AgentMenu) {
  const row = document.createElement("div");
  row.className = "dashboard-reply dashboard-choices";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `Answer ${p.agent} in ${th.name}`);
  if (menu.multi) {
    const note = document.createElement("span");
    note.textContent = "This question takes several choices. Open it to answer in the terminal.";
    row.append(note);
    return row;
  }
  menu.options.forEach((label, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = `choice-${p.id}-${i}`;
    b.dataset.n = String(i + 1); // Drawn by CSS: the number key that picks it, the agent's own numbering.
    b.textContent = label;
    b.title = menu.unnumbered ? `Choose "${label}" in ${p.agent}` : `Choose "${label}" in ${p.agent} (key ${i + 1} on the session)`;
    b.onclick = () => void answer(p, () => choose(p, menu, i));
    row.append(b);
  });
  return row;
}

function closeDashboardPreview() {
  const p = dashboardPreviewPane;
  if (!p) return;
  returnPreviewPane(p);
  dashboardPreview.close();
  const key = dashboardCompact ? `preview-${p.id}` : p.id;
  if (dashboardOpen) ([...$("#dashboard-list").querySelectorAll<HTMLButtonElement>("button")].find(b => b.dataset.key === key) ?? dashboardQuery).focus({ preventScroll: true });
}

// --- Selecting: tick cards, then add them to a group or answer them together. ---
const bulkInput = $<HTMLInputElement>("#dashboard-bulk-input");
const bulkSend = $<HTMLButtonElement>("#dashboard-bulk-send");
/** Ticked agents that can take a message: waiting or idle, at a text prompt. A
 * terminal would run it as a command, and one on a menu would take it as a
 * choice, so those stay out; a working or exited agent has no prompt to type
 * into. Idle is a guess ("no activity seen"), so a quiet agent that is still
 * thinking may queue the message behind its work. */
const bulkTargets = () => dashboardView.filter(r => dashboardSelected.has(r.p.id) && (r.state === "waiting" || r.state === "") && r.p.agent !== "shell" && !r.menu).map(r => r.p);

function renderBulk() {
  $("#dashboard").classList.toggle("selecting", dashboardSelecting);
  $("#dashboard-bulk").classList.toggle("hidden", !dashboardSelecting);
  $("#dashboard-select").setAttribute("aria-pressed", String(dashboardSelecting));
  if (!dashboardSelecting) return;
  const n = dashboardSelected.size, targets = bulkTargets();
  $("#dashboard-bulk-count").textContent = `${n} selected`;
  $("#dashboard-bulk-all").textContent = n && n === dashboardView.length ? "Select none" : "Select all in view";
  $<HTMLButtonElement>("#dashboard-bulk-all").disabled = !dashboardView.length;
  $<HTMLButtonElement>("#dashboard-bulk-group").disabled = !n;
  bulkInput.readOnly = dashboardBulkBusy; // Not disabled: a disabled box drops focus, and the agents that just answered are no longer waiting.
  bulkSend.disabled = dashboardBulkBusy || !targets.length;
  bulkInput.placeholder = targets.length ? `Message ${targets.length} agent${targets.length === 1 ? "" : "s"}` : n ? "None of these can take a message" : "Tick agents to message them together";
  bulkSend.textContent = targets.length ? `Send to ${targets.length}` : "Send";
  // Say who is left out and why: a dimmed Send with typed text otherwise looks broken.
  const why = new Map<string, number>();
  for (const { p, state, menu } of dashboardView) if (dashboardSelected.has(p.id) && !targets.includes(p)) {
    const reason = p.agent === "shell" ? "terminal" : menu ? "asking a menu question" : state === "busy" ? "working" : "exited"; // Anything else is a target.
    why.set(reason, (why.get(reason) ?? 0) + 1);
  }
  $("#dashboard-bulk-note").textContent = why.size ? `Left out: ${[...why].map(([reason, k]) => `${k} ${reason === "terminal" && k > 1 ? "terminals" : reason}`).join(", ")}. A message goes to agents that are waiting or idle.` : "";
}

function selectCards(ids: Iterable<string>) {
  dashboardSelected.clear();
  for (const id of ids) dashboardSelected.add(id);
  for (const box of $("#dashboard-list").querySelectorAll<HTMLInputElement>(".dashboard-select")) box.checked = dashboardSelected.has(box.closest<HTMLElement>(".dashboard-card")!.dataset.pane!);
  renderBulk();
}

function setSelecting(on: boolean) {
  dashboardSelecting = on;
  if (on) renderBulk(); else selectCards([]);
}

$("#dashboard-select").onclick = () => setSelecting(!dashboardSelecting);
$("#dashboard-bulk-done").onclick = () => (setSelecting(false), $("#dashboard-select").focus());
$("#dashboard-bulk-all").onclick = () => selectCards(dashboardSelected.size === dashboardView.length ? [] : dashboardView.map(r => r.p.id));
$("#dashboard-bulk-group").onclick = e => showMenu(e.currentTarget as HTMLElement, groupMenu(dashboardView.filter(r => dashboardSelected.has(r.p.id)).map(r => r.p)));
$("#dashboard-bulk-reply").onsubmit = async e => {
  e.preventDefault();
  const text = bulkInput.value.trim(), targets = bulkTargets();
  if (!text || !targets.length || dashboardBulkBusy) return;
  dashboardBulkBusy = true;
  renderBulk();
  let sent = 0;
  await Promise.all(targets.map(p => answer(p, async () => { await replyAsPerson(p, text); sent++; }))); // Each failure toasts for itself.
  dashboardBulkBusy = false;
  if (sent === targets.length) bulkInput.value = "";
  toast(sent === targets.length ? `Sent to ${sent} agent${sent === 1 ? "" : "s"}` : `Sent to ${sent} of ${targets.length} agents. Open the others to finish`);
  renderBulk();
  bulkInput.focus();
};

dashboardQuery.oninput = renderDashboard;
// ↑/↓ walk the sessions, Home/End jump to the ends; Enter already previews.
const dashboardRowButtons = () => [...$("#dashboard-list").querySelectorAll<HTMLButtonElement>(".dashboard-row")];
dashboardQuery.onkeydown = e => {
  if (e.key === "ArrowDown" && dashboardRowButtons()[0]) (e.preventDefault(), dashboardRowButtons()[0].focus());
};
$("#dashboard-list").onkeydown = e => {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>(".dashboard-card");
  if (!card || e.ctrlKey || e.altKey || e.metaKey) return;
  if (t.matches(".dashboard-reply input")) { // Esc leaves the reply box for its card, so ↓ moves on to the next.
    if (e.key === "Escape") (e.preventDefault(), card.querySelector<HTMLElement>(".dashboard-row")!.focus());
    return;
  }
  if (e.key === "Escape" && dashboardSelecting) return void (setSelecting(false), card.querySelector<HTMLElement>(".dashboard-row")!.focus());
  // On a card: R jumps to its reply box or first option, 1–9 pick that option, X ticks it.
  const key = e.key.toLowerCase();
  if (key === "r" || /^[1-9]$/.test(key) || key === "x") {
    const target = key === "r" ? card.querySelector<HTMLElement>(".dashboard-reply :is(input, button)") : key === "x" ? card.querySelector<HTMLElement>(".dashboard-select") : card.querySelectorAll<HTMLElement>(".dashboard-choices button")[+key - 1];
    if (!target) return;
    e.preventDefault();
    if (key === "x") { if (!dashboardSelecting) setSelecting(true); target.click(); } else if (key === "r") target.focus(); else target.click();
    return;
  }
  if (t instanceof HTMLInputElement && t.type !== "checkbox") return;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = dashboardRowButtons(), i = rows.indexOf(card.querySelector(".dashboard-row")!);
  const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  e.preventDefault();
  (rows[to] ?? (to < 0 ? dashboardQuery : rows[i])).focus();
};
dashboardProject.onchange = renderDashboard;
$("#dashboard-btn").onclick = () => { if (dashboardOpen) show(current); else toggleDashboard(true); };
// The rest of the rail: back to the thread, its changes, both accounts' usage.
$("#rail-agents").onclick = () => { if (dashboardOpen && current) show(current); };
$("#side-overview").onclick = () => $("#dashboard-btn").click();
$("#rail-changes").onclick = () => {
  if (!current) return;
  if (dashboardOpen) show(current);
  toggleChanges();
};
$("#rail-usage").onclick = () => showMenu($("#rail-usage"), planMenus.both);
$("#dashboard-back").onclick = () => show(current);
$("#dashboard-next").onclick = jumpWaiting;
$("#dashboard-reset").onclick = () => {
  dashboardQuery.value = "";
  dashboardProject.value = "";
  dashboardFilter = "all";
  renderDashboard();
  dashboardQuery.focus();
};
$("#dashboard-compact").onclick = () => { dashboardCompact = !dashboardCompact; renderDashboard(); void refreshDashboardMessages(true); save(); };
$("#dashboard-preview-close").onclick = closeDashboardPreview;
$("#dashboard-preview-prev").onclick = () => stepDashboardPreview(-1);
$("#dashboard-preview-next").onclick = () => stepDashboardPreview(1);
// Capture phase, so F3 never reaches the terminal. ←/→ belong to the terminal while it has focus.
dashboardPreview.addEventListener("keydown", e => {
  const free = !dashboardPreviewOutput.contains(e.target as Node) && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  const step = e.key === "F3" ? "waiting" : !free ? undefined : e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : undefined;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  stepDashboardPreview(step);
}, true);
dashboardPreview.onclick = e => {
  if (dashboardControlBusy || e.target !== dashboardPreview) return;
  const { left, right, top, bottom } = dashboardPreview.getBoundingClientRect();
  if (e.clientX < left || e.clientX >= right || e.clientY < top || e.clientY >= bottom) closeDashboardPreview();
};
dashboardPreview.oncancel = e => {
  e.preventDefault();
  if (!dashboardControlBusy && !dashboardPreviewOutput.contains(document.activeElement)) closeDashboardPreview();
};
$("#dashboard-preview-open").onclick = () => {
  if (dashboardPreviewPane && dashboardPreviewPane.th.panes.includes(dashboardPreviewPane)) revealPane(dashboardPreviewPane);
};
dashboardPreview.onclose = () => {
  if (!dashboardPreview.open) closeDashboardPreview(); // Also restore if another caller closes the native dialog.
};
const needsSession = (p: Pane) => (p.agent === "codex" || p.agent === "opencode") && !p.sessionId && !ownSession(p.startup);
$("#dashboard-process").onclick = async () => {
  const p = dashboardPreviewPane;
  if (!p || dashboardControlBusy) return;
  if (p.dead && needsSession(p)) return void p.chooseSession();
  const stop = !p.dead;
  if (stop && !(await confirm(`Stop ${p.agent} in ${p.th.name}?`, {
    title: "Stop process", kind: "warning", action: "Stop process",
    detail: "This terminates this pane's process and its child processes. Unsaved work in those processes may be lost. The pane stays available to relaunch.",
  }))) return;
  if (stop && p.dead) return;
  dashboardControlBusy = true;
  renderDashboard();
  try {
    if (stop) await p.stop();
    else await p.spawn(true);
  } catch (error) {
    if (dashboardPreviewPane === p) $("#dashboard-control-result").textContent = String(error);
  } finally {
    dashboardControlBusy = false;
    renderDashboard();
  }
};

/** The agent overlay (overlay.ts): a small always-on-top window listing the
 * agents waiting on you, then the ones working. "background" shows it while
 * Loom is minimized or behind another app and something is waiting or working;
 * "always" keeps it up either way. Clicking an agent brings Loom back on the
 * overview with that agent previewed. It never takes focus on its own. */
/** Whether Loom's window is the active one. WebView2 keeps document.hasFocus()
 * true while the window is minimized or behind another app, so this follows
 * the native window instead. */
let loomFocused = true;
let loomMinimized = false;
const backgroundHidden = () => document.hidden || loomMinimized;
let resumePolls = () => {};
// Ask on every change rather than trust the event: clicking the overlay
// activates it, and its focus event reaches this window's listener too.
const readFocus = () => Promise.all([getCurrentWindow().isFocused(), getCurrentWindow().isMinimized()])
  .then(([f, m]) => {
    const restored = loomMinimized && m !== true;
    const was = loomFocused;
    loomMinimized = m === true;
    loomFocused = f !== false && !loomMinimized;
    // The page keeps its focus behind other apps, so xterm would blink a cursor
    // nobody sees, a redraw each time (~1-2% of a core, perf-native-check.mjs idle).
    if (loomFocused !== was) for (const t of threads) for (const p of t.panes) p.term.options.cursorBlink = loomFocused;
    syncOverlay();
    syncSpin();
    if (restored) resumePolls();
  }, () => {});
/** The clock behind every working spinner. A running animation redraws the
 * whole window at the display's rate (144 Hz here), on the compositor or not:
 * one infinite 9 px ring cost ~40% of a core with 24 panes, a steps() spinner
 * ~20% (perf-native-check.mjs idle). One timer steps them all instead, and only
 * while Loom is in front and an agent works. ponytail: 8 Hz; slow it if a
 * focused, working Loom shows up in a profile. */
let spinTimer = 0;
let spinFrame = 0;
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
function syncSpin() {
  const on = loomFocused && !backgroundHidden() && !stillMotion.matches && threads.some((t) => t.panes.some((p) => p.busy));
  if (on === !!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = on ? window.setInterval(() => $("#threads").style.setProperty("--spin", String((spinFrame = (spinFrame + 1) % 10))), 125) : 0;
}
stillMotion.addEventListener("change", syncSpin);
void readFocus();
void getCurrentWindow().onFocusChanged(readFocus);
void getCurrentWindow().onResized(readFocus);
let overlayShown = false;
// Its close button: hidden until Loom next comes to the front or goes behind.
// Holds the focus state it was closed in.
let overlayClosedAt: boolean | null = null;
let overlaySent = "";
const OVERLAY_VARS = ["--panel", "--text", "--muted", "--faint", "--edge", "--edge-hi", "--hover", "--accent", "--accent-dim", "--glow", "--warn", "--warn-dim", "--warn-glow", "--ui"];
// In order: a build and a show sent back to back must not race to create the window.
let overlayCall: Promise<unknown> = Promise.resolve();
const overlayWindow = (show: boolean | null) =>
  (overlayCall = overlayCall.then(() => invoke("overlay", { show })).catch(e => toast(`Could not update the agent overlay: ${String(e)}`)));

function syncOverlay() {
  if (overlayMode === "off") return;
  if (overlayClosedAt !== null && overlayClosedAt !== loomFocused) overlayClosedAt = null;
  const wanted = overlayClosedAt === null && (overlayMode === "always" || !loomFocused);
  const rows = !wanted ? [] : threads.flatMap(th => th.panes.map(p => ({ th, p, state: paneState(p) })))
    .filter(r => r.state === "waiting" || r.state === "busy")
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.state === "waiting" ? a.p.waitingSince - b.p.waitingSince : a.p.busySince - b.p.busySince))
    .map(({ th, p, state }): OverlayRow => ({
      id: p.id,
      agent: p.agent,
      waiting: state === "waiting",
      name: th.panes.length > 1 ? `${th.name} · ${th.panes.indexOf(p) + 1}` : th.name,
      time: ago(state === "waiting" ? p.waitingSince : p.busySince),
      ask: state === "waiting" && p.agent !== "shell" ? asking(readMenu(liveScreen(p, false), p.agent)) : "",
    }));
  const show = wanted && (rows.length > 0 || overlayMode === "always");
  if (show) {
    const style = getComputedStyle(document.documentElement);
    const state: OverlayState = { rows, vars: Object.fromEntries(OVERLAY_VARS.map(k => [k, style.getPropertyValue(k).trim()])), scheme: theme.scheme ?? "dark" };
    const sent = JSON.stringify(state);
    if (sent !== overlaySent) void emit("overlay-rows", state).then(() => (overlaySent = sent));
  }
  if (show === overlayShown) return;
  overlayShown = show;
  void overlayWindow(show);
}

/** One line for what a menu on the agent's screen asks: the specific lines
 * (the tool, the command, the file) over the generic "Do you want to proceed?",
 * which is kept only when it is all there is. */
function asking(menu: AgentMenu | null) {
  if (!menu) return "";
  const specific = menu.question.filter(line => !line.endsWith("?"));
  return (specific.length ? specific : menu.question).join(" · ") || "Asks you to choose";
}

/** Back from the overlay: Loom in front, on the overview, previewing `p`. */
async function comeBack(p?: Pane) {
  const w = getCurrentWindow();
  await w.unminimize().catch(() => {});
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
  if (!dashboardOpen) toggleDashboard(true);
  if (p && p.th.panes.includes(p)) openDashboardPreview(p);
}

// A freshly loaded overlay missed whatever was sent before it listened.
void listen("overlay-ready", () => ((overlaySent = ""), syncOverlay()));
void listen<string>("overlay-pick", e => void comeBack(threads.flatMap(t => t.panes).find(p => p.id === e.payload)));
void listen("overlay-open", () => void comeBack());
void listen("overlay-dismiss", () => ((overlayClosedAt = loomFocused), syncOverlay()));

function paintOverlayPref() {
  const b = $("#overlay-pref");
  b.textContent = { off: "off", background: "in background", always: "always" }[overlayMode];
  b.title = {
    off: "Click to show a small window over other apps with the agents waiting and working",
    background: "Shown over other apps while Loom is minimized or behind them, when an agent is waiting or working. Click to keep it up all the time",
    always: "Always shown, over Loom too. Click to turn it off",
  }[overlayMode];
  b.setAttribute("aria-pressed", String(overlayMode !== "off"));
}

function renderPicker() {
  const list = $("#picker-list");
  const focused = document.activeElement as HTMLElement | null;
  const focusKey = list.contains(focused) ? focused?.dataset.key : undefined;
  const q = pickerQuery.value.trim().toLowerCase();
  // Sidebar order within each state: sort() is stable.
  const rows = threads
    .flatMap((th) => th.panes.map((p) => ({ th, p, state: paneState(p) })))
    .filter(({ state }) => pickAll || state === "waiting")
    .filter(({ th, p }) => !q || `${basename(th.repo)} ${th.name} ${th.branch} ${p.agent} ${p.appTitle}`.toLowerCase().includes(q))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  list.replaceChildren();
  for (const { th, p, state } of rows) {
    const row = document.createElement("button");
    row.className = "picker-row";
    row.dataset.key = p.id;
    row.dataset.state = state;
    const label = document.createElement("span");
    label.className = "picker-label";
    label.textContent = `${th.name} / ${p.agent}`;
    const detail = document.createElement("span");
    detail.className = "picker-detail";
    detail.textContent = p.label;
    const project = document.createElement("span");
    project.className = "picker-project";
    project.textContent = basename(th.repo);
    const tag = document.createElement("span");
    tag.className = "picker-state";
    tag.textContent = STATE_WORD[state];
    row.append(icon(p.agent), label, tag, detail, project);
    row.onclick = () => {
      picker.close();
      revealPane(p);
    };
    list.append(row);
  }
  $("#picker-empty").classList.toggle("hidden", list.childElementCount > 0);
  $("#picker-empty").textContent = q ? "No matches. Try a project, thread, branch or agent name."
    : pickAll ? "No agents yet. Start a thread to add one." : "Nothing waiting. Agents that need you will appear here.";
  if (focusKey) {
    const next = [...list.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.dataset.key === focusKey);
    (next ?? pickerQuery).focus();
  }
}

pickerQuery.oninput = renderPicker;
$("#picker-close").onclick = () => picker.close();
picker.onkeydown = (e) => {
  if (e.key === "Escape") {
    e.preventDefault(); // A search input otherwise consumes Escape to clear its text.
    picker.close();
    return;
  }
  const rows = [...$("#picker-list").querySelectorAll<HTMLButtonElement>("button")];
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = e.key === "ArrowDown" ? i + 1 : i < 0 ? rows.length - 1 : i - 1;
    (rows[next] ?? pickerQuery).focus();
  } else if (e.key === "Enter" && document.activeElement === pickerQuery) {
    e.preventDefault();
    rows[0]?.click();
  }
};

/** "now", "3m", "2h", "5d": how long ago `t` was. */
function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the thread after (before) this one, wrapping. */
function cycleThread(back: boolean) {
  if (!current || threads.length < 2) return;
  const i = threads.indexOf(current);
  show(threads[(i + (back ? -1 : 1) + threads.length) % threads.length]);
}

/** Drag a sidebar row up or down its own list, mouse events only (the OS
 * owns HTML5 drag here, see the pane header). `peers` are the rows it may
 * land among; `done` gets the target and whether to land after it. */
function dragRow(el: HTMLElement, peers: () => HTMLElement[], done: (over: HTMLElement, after: boolean) => void) {
  el.addEventListener("mousedown", (e) => {
    const inner = (e.target as HTMLElement).closest("button:not(.thread-select), .agent, input");
    if (e.button || (inner && inner !== el)) return;
    const from = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let over: HTMLElement | null = null;
    let after = false;
    const clear = () => peers().forEach((p) => p.classList.remove("drop-before", "drop-after"));
    const move = (m: MouseEvent) => {
      if (!dragging && Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < 6) return;
      dragging = true;
      el.classList.add("dragging");
      clear();
      over = null;
      for (const p of peers()) {
        const r = p.getBoundingClientRect();
        if (p !== el && m.clientY >= r.top && m.clientY <= r.bottom) {
          over = p;
          after = m.clientY > r.top + r.height / 2;
          p.classList.add(after ? "drop-after" : "drop-before");
        }
      }
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      clear();
      el.classList.remove("dragging");
      if (dragging && over) done(over, after);
      // A drag is not a click: the row would otherwise switch threads on drop.
      if (dragging) el.addEventListener("click", (c) => c.stopImmediatePropagation(), { capture: true, once: true });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });
}

/** Move `x` next to `target` in `list`. */
function moveNextTo<T>(list: T[], x: T, target: T, after: boolean) {
  list.splice(list.indexOf(x), 1);
  list.splice(list.indexOf(target) + (after ? 1 : 0), 0, x);
}

/** The sidebar: project groups in `repos` order, each folding, each row a
 * thread in `threads` order; both reorder by drag. Rebuilt whole — it is a
 * few dozen nodes, and the rows are the threads' own elements, so nothing
 * is lost. The filter box hides what it doesn't match rather than rebuilding. */
function renderSide() {
  const side = $("#threads");
  side.textContent = "";
  const rowsOf = (repo: string) => threads.filter((t) => t.repo === repo);
  for (const repo of repos.filter((r) => rowsOf(r).length)) {
    const h = document.createElement("div");
    h.className = "repo";
    h.tabIndex = 0;
    h.setAttribute("role", "button");
    h.setAttribute("aria-label", `Project ${basename(repo)}, ${rowsOf(repo).length} threads`);
    h.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h.click(); }
    };
    h.dataset.repo = repo;
    h.title = repo;
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = basename(repo);
    const count = document.createElement("span");
    count.className = "project-n";
    count.textContent = String(rowsOf(repo).length);
    h.append(glyph("folder"), name, count, mini(glyph("plus"), `New worktree in ${basename(repo)}`, () => newThread(repo)));
    const group = document.createElement("div");
    group.className = "group";
    group.id = `project-${uid()}`;
    h.setAttribute("aria-controls", group.id);
    group.append(...rowsOf(repo).map((t) => t.row));
    const fold = (f: boolean) => {
      h.classList.toggle("folded", f);
      h.setAttribute("aria-expanded", String(!f));
      group.classList.toggle("hidden", f);
    };
    fold(reposFolded.has(repo));
    h.onclick = () => {
      const f = !reposFolded.has(repo);
      f ? reposFolded.add(repo) : reposFolded.delete(repo);
      fold(f);
      save();
    };
    dragRow(h, () => [...side.querySelectorAll<HTMLElement>(".repo")], (over, after) => {
      moveNextTo(repos, repo, over.dataset.repo!, after);
      renderSide();
      save();
    });
    side.append(h, group);
  }
  filterSide();
}

function filterSide() {
  const q = sideQuery;
  for (const t of threads) t.row.classList.toggle("hidden", !!q && !t.matches(q));
  for (const h of $("#threads").querySelectorAll<HTMLElement>(".repo")) {
    const any = threads.some((t) => t.repo === h.dataset.repo && (!q || t.matches(q)));
    h.classList.toggle("hidden", !any);
    const folded = !q && reposFolded.has(h.dataset.repo!);
    h.classList.toggle("folded", folded);
    h.setAttribute("aria-expanded", String(!folded));
    h.nextElementSibling?.classList.toggle("hidden", folded);
  }
  $("#side-empty").classList.toggle("hidden", !q || threads.some((t) => t.matches(q)));
}

function show(th: Thread | null) {
  if (dashboardOpen) toggleDashboard(false);
  // A Changes selection is the thread's it was made in: the same path in
  // another worktree is other work, and Discard would throw that away.
  if (th !== current) (sel.clear(), (selSec = null), (selAnchor = ""));
  current = th;
  if (matchMedia("(max-width: 760px)").matches) toggleSide(false);
  for (const t of threads) {
    t.grid.classList.toggle("hidden", t !== th);
    t.paint();
    t.panes.forEach((p) => {
      if (t === th) p.gpu(true); // the budget in gpu() retires other threads' contexts
      p.row.classList.toggle("on", t === th && p === t.active);
    });
  }
  $("#empty").classList.toggle("hidden", threads.length > 0);
  paintHead();
  $<HTMLTextAreaElement>("#commit-msg").value = th?.commitDraft ?? "";
  paintTabs();
  void showTab();
  if (changesOpen) void refreshChanges();
  paintLayout(th?.layout ?? "cols");
  // The grid was display:none, so its terminals measured 0 — refit on reveal.
  th?.panes.forEach((p) => p.resize());
  th?.focusPane(th.active ?? th.panes[0] ?? null);
  save();
}

/** The top bar's breadcrumb (project, thread, branch, change stats) and the
 * Changes toggle's badge. The folder is the breadcrumb's tooltip. */
function paintHead() {
  const th = current;
  $("#wsrepo").textContent = th ? basename(th.repo) : "";
  $("#wsname").textContent = th?.name ?? "";
  // Worktree branches are loom/<name>: say it only when it says something new.
  const branch = th?.branch && th.branch !== `loom/${th.name}` && th.branch !== th.name ? th.branch : "";
  $("#wsbranch").textContent = branch;
  $("#wsbranch").classList.toggle("hidden", !branch);
  $("#wsstat").innerHTML = th ? statHtml(th.changed) : "";
  $("#crumbs").title = th ? `${th.name}\n${th.branch ? `Branch ${th.branch}` : "Folder without a Git branch"}\n${th.dir}` : "";
  $("#changes-n").textContent = th?.changed.files ? String(th.changed.files) : "";
  for (const id of ["#changes-btn", "#wsmore", "#add-pane", "#layout", "#vscode"]) {
    $<HTMLButtonElement>(id).disabled = !th;
  }
}

type ThreadState = {
  repo: string; dir: string; branch: string; name: string; open?: boolean;
  /** Pre-redesign: agents collapsed by hand. Read once as open: false. */
  folded?: boolean;
  active?: number; zoomed?: number; colW?: number[]; rowH?: number[];
  tabs?: Omit<DiffTab, "load">[]; tab?: number; commitDraft?: string;
};

async function openThread(st: ThreadState, panes: PaneState[], layout: LayoutMode = "cols", fromSave = false) {
  const th = new Thread(st.repo, st.dir, st.branch, st.name);
  th.layout = layout;
  th.restoring = fromSave;
  th.open = st.open ?? (st.folded ? false : undefined);
  threads.push(th); // before any await, so restore order is saved order
  // A thread on the checkout itself follows whatever branch is checked out
  // there, so ask git rather than trust what was saved.
  if (st.dir === st.repo)
    headBranch(th)
      .then((b) => ((th.branch = b), th.setStat(th.changed)))
      .catch(() => {});
  if (!repos.includes(st.repo)) repos.push(st.repo);
  $("#stage").append(th.grid);
  // Restoring N threads used to show() each in turn: N sidebar rebuilds, and
  // every pane got a WebGL context only to lose it when the next thread showed.
  // main() renders the sidebar and shows the saved thread once all are up.
  if (fromSave) th.grid.classList.add("hidden");
  else (renderSide(), show(th));
  // Parallel: a spawn is up to ~1s. addPane pushes its pane before the first
  // await, so mapping in order still lands them in order, and the saved layout
  // goes on now: main() shows this thread while its panes are still starting.
  // Restored panes don't take focus as they start, or it would jump around.
  const started = Promise.all(panes.slice(0, MAX_PANES).map((st) => th.addPane(st, !fromSave)));
  th.colW = st.colW?.filter(w => Number.isFinite(w) && w > 0) ?? [];
  th.rowH = st.rowH?.filter(w => Number.isFinite(w) && w > 0) ?? [];
  th.active = th.panes[st.active ?? 0] ?? th.panes[0];
  if (th.panes[st.zoomed ?? -1]) th.toggleZoom(th.panes[st.zoomed!]);
  th.commitDraft = st.commitDraft ?? "";
  th.tabs = (st.tabs ?? []).filter(t => t.source).map(t => ({ ...t, load: diffLoader(th, t.source) }));
  th.tab = th.tabs[st.tab ?? -1] ?? null;
  th.relayout();
  await started;
  th.restoring = false;
  if (!threads.includes(th)) return th; // Closed while its processes were starting.
  if (!th.panes.length) await th.addPane();
  save();
  void pollStats();
  return th;
}

const git = (dir: string, ...args: string[]) => invoke<string>("git_run", { dir, args });

/** A diff to show: bounded natively (4 MiB, 5 s), so a huge one fails fast
 * instead of crossing IPC whole. Numstat and the polls aren't previews.
 * Extra exit codes count as success — `git diff --no-index` says 1 for "they differ". */
const gitPreview = (dir: string, ok: number[], ...args: string[]) =>
  invoke<string>("git_run", { dir, args, ok, preview: true });

/** The branch checked out in a thread, after a git action may have moved it.
 * Detached (a rebase stopped on a conflict), a worktree keeps its own
 * branch's name: "HEAD" there would have deletion count and delete the main
 * checkout's. The checkout itself says HEAD, which is what it has. */
async function headBranch(th: Pick<Thread, "dir" | "repo" | "branch">) {
  const ref = (await git(th.dir, "symbolic-ref", "-q", "HEAD").catch(() => "")).replace(/\r?\n$/, "");
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : th.dir === th.repo ? "HEAD" : th.branch;
}

/** The thread's branch as git has it now, kept: a git switch in its own
 * terminal moves it under Loom. Read before status, Create PR, the deletion
 * inventory (what it counts and deletes) and branches. */
async function syncBranch(th: Thread) {
  const b = await headBranch(th);
  if (b !== th.branch) ((th.branch = b), save());
  return b;
}

/** What deleting a worktree destroys that exists nowhere else: changed and
 * untracked files, ignored files (.env, node_modules/: a wholly ignored folder
 * is one entry), and with `branch` the commits no other branch or remote
 * holds. HEAD rides along, so a new commit is a change too, and so does the
 * branch and its tip, which deletion takes. Throws when git can't say: unknown is
 * never "nothing to lose". */
type Inventory = { fingerprint: string; branch: string; branchTip: string; head: string; tracked: string[]; untracked: string[]; ignored: string[]; commits: number; loose: number; discard: Loss[] };
/** Contents count only for the files the approval names and doesn't discard;
 * the rest (ignored build output above all) count by name, size and time. */
const hashedFiles = (status: { tracked: string[]; untracked: string[] }, discard: Loss[]) =>
  (["tracked", "untracked"] as const).flatMap((k) => (discard.includes(k) ? [] : status[k]));
async function inventory(th: Thread, branch: boolean, discard: Loss[] = []): Promise<Inventory> {
  const name = await syncBranch(th);
  const branchTip = branch && name ? (await git(th.repo, "rev-parse", "--verify", `refs/heads/${name}^{commit}`)).trim() : "";
  const status = lossInventory(await git(th.dir, "status", "--porcelain=v1", "-z", "-uall", "--ignored=matching"));
  const hashed = hashedFiles(status, discard);
  const count = (where: string) => (s: string) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`git counted "${s.trim()}" commits on ${where}`);
    return n;
  };
  const [head, commits, loose, fingerprint] = await Promise.all([
    git(th.dir, "rev-parse", "HEAD").then((s) => s.trim(), () => ""), // no commits yet
    branch && name
      ? git(th.repo, "rev-list", "--count", branchTip, "--not", `--exclude=${name}`, "--branches", "--remotes").then(count(name))
      : 0,
    // A detached HEAD's own commits (an agent checked one out and committed)
    // are on no branch: the worktree's HEAD and reflog are all that keep them,
    // whichever mode deletes it.
    git(th.dir, "symbolic-ref", "-q", "HEAD").then(() => 0, () => git(th.dir, "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes").then(count("a detached HEAD"))),
    invoke<string>("worktree_fingerprint", { dir: th.dir, hashed }),
  ]);
  if (!fingerprint) throw new Error("Could not fingerprint the worktree; nothing was deleted");
  return { branch: name, branchTip, head, ...status, commits, loose, fingerprint, discard };
}
const lossCounts = (inv: Inventory): Record<Loss, number> => ({ tracked: inv.tracked.length, untracked: inv.untracked.length, ignored: inv.ignored.length, commits: inv.commits + inv.loose });

/** An inventory as warning lines for the confirm's detail, or "" when deleting loses nothing. */
function riskText(inv: Inventory | null): string {
  const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
  if (!inv) return "\n⚠ Could not read the worktree's status or its branch.\n";
  const uncommitted = inv.tracked.length + inv.untracked.length, ignored = inv.ignored;
  const lines = [
    uncommitted ? `⚠ ${plural(uncommitted, "uncommitted file")} will be deleted.` : "",
    ignored.length ? `⚠ ${plural(ignored.length, "ignored file or folder", "ignored files or folders")} will be deleted: ${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ", …" : ""}` : "",
    inv.commits ? `⚠ ${plural(inv.commits, "commit")} ${inv.commits === 1 ? "exists" : "exist"} only on ${inv.branch}.` : "",
    inv.loose ? `⚠ ${plural(inv.loose, "commit")} on its detached HEAD ${inv.loose === 1 ? "is" : "are"} on no branch.` : "",
  ].filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/** Which of two inventories' parts differ, for the message that says why nothing was closed. */
const inventoryDiff = (was: Inventory, now: Inventory) =>
  (["branch", "branchTip", "head", "tracked", "untracked", "ignored", "commits", "loose", "fingerprint"] as const).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]))
    .map((k) => (k === "branch" ? `the branch it's on (${now.branch}, not ${was.branch})` : k === "branchTip" ? "the branch's commit" : k === "fingerprint" ? "file or index contents" : k === "head" ? "a new commit" : k === "commits" ? "the branch's own commits" : k === "loose" ? "commits on no branch" : `its ${k} files`)).join(", ");

/** Take a thread out of the list, and out of git as far as `mode` says:
 * "close" keeps the worktree on disk, "worktree" removes the folder and keeps
 * the branch, "all" deletes the branch too. Panes go first either way — a
 * folder with a shell still in it cannot be removed. */
/** Threads on their way out. A second close of the same thread (two clicks, two
 * loomctl calls) stops here: after the awaits below it would find no thread,
 * and splice(-1) would drop the last, unrelated one. */
const closingThreads = new WeakSet<Thread>();

/** `removed` once the thread is out of Loom. Then, for a worktree being
 * deleted, what became of its folder and branch: `removed` into Loom's
 * `trash`, or `failed`, with `error` saying which and why (the window shows it). */
type Removal = { removed: boolean; error?: string; worktree?: "removed" | "pending" | "failed"; branch?: "deleted" | "kept" | "failed"; trash?: string };

/** `ask`: false when loomctl already checked what deleting loses, so there is
 * no dialog. Otherwise the dialog asks, showing what would be lost, and
 * nothing closes unless that still holds when you answer. The folder goes to
 * Loom's trash for a day (deletion.rs), with whatever its panes wrote as they
 * closed: what the dialog showed is a summary, not a lock on the folder.
 * `approved` and `expected`: with `ask` false, the branch and tip loomctl approved deleting. */
async function removeThread(th: Thread, mode: "close" | "worktree" | "all", ask = true, approved = th.branch, expected = ""): Promise<Removal> {
  if (closingThreads.has(th) || !threads.includes(th)) return { removed: false, error: `${th.name} is already closing or closed.` };
  closingThreads.add(th);
  try {
    const deleting = mode !== "close" && th.isWorktree;
    // The branch deletion takes: the one the dialog names, or the one loomctl
    // approved. Never th.branch after an await: a git switch in the worktree,
    // read by any status poll, moves it.
    let named = approved;
    if (ask) {
      let why = "";
      const seen = deleting ? await inventory(th, mode === "all").catch((e) => ((why = `: ${String(e)}`), null)) : null;
      if (deleting && !seen) {
        const error = `Could not inspect the complete worktree${why}. Nothing was closed or deleted.`;
        toast(error);
        return { removed: false, error };
      }
      if (seen) { named = seen.branch; expected = seen.branchTip; }
      const risk = deleting ? riskText(seen) : "";
      const what =
        mode === "close"
          ? `Close ${th.name}?`
          : mode === "worktree"
            ? `Delete the worktree folder for ${th.name}?\n${th.dir}\n${risk}\nThe branch ${named} is kept. The folder waits in Loom's trash for a day.`
            : `Delete the worktree AND the branch ${named}?\n${th.dir}\n${risk}\nCommits only on that branch are lost. The folder waits in Loom's trash for a day.`;
      if (th.panes.length || mode !== "close") {
        if (!(await confirm(what, { title: "Loom", kind: mode === "close" ? "info" : "warning", action: mode === "close" ? "Close thread" : "Delete worktree" }))) return { removed: false };
      }
      // The dialog may have stood open a while: what it said must still be so.
      const now = seen && (await inventory(th, mode === "all").catch(() => null));
      if (seen && (!now || inventoryDiff(seen, now))) {
        const error = `${th.name}'s worktree changed while the dialog was open (${now ? inventoryDiff(seen, now) : "its status can't be read now"}), so nothing was closed. Look again before deleting it.`;
        toast(error);
        return { removed: false, error };
      }
    }
    // Force skips the loss inventory, but still captures the tip before panes close.
    if (deleting && mode === "all" && named && !expected) expected = (await git(th.repo, "rev-parse", "--verify", `refs/heads/${named}^{commit}`)).trim();
    const i = threads.indexOf(th);
    if (i === -1) return { removed: false, error: `${th.name} is already closed.` };
    threads.splice(i, 1);
    const cleanup = th.dispose();
    renderSide();
    show(threads[Math.min(i, threads.length - 1)] ?? null);
    save();
    await cleanup;
    if (!deleting) return { removed: true };
    const branch = mode === "all" && named ? "kept" : undefined;
    const partial = (r: Removal & { error: string }) => (toast(`Closed ${th.name}, but ${r.error}`), r);
    let trash = "";
    try {
      // The killed panes' processes take a beat to die, and Windows refuses to
      // move a folder that is still some process's cwd — retry a few times.
      for (let n = 0; ; n++) {
        try {
          // Not `git worktree remove`: it follows junctions and empties their targets.
          trash = await invoke<string>("worktree_remove", { repo: th.repo, dir: th.dir });
          break;
        } catch (e) {
          if (n === 10) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch (e) {
      // The folder went to the trash, but something held git's record of it:
      // the hourly purge finishes that move (deletion.rs), and the branch stays
      // checked out there until it has.
      const held = /^retained (.+?), but git administration at /.exec(String(e));
      if (held) {
        trash = held[1];
        if (branch) return partial({ removed: true, worktree: "pending", branch, trash, error: `moved its worktree folder to Loom's trash (${trash}), but git's record of it was in use, so the branch ${named} was kept. Loom finishes the move within the hour.` });
        toast(`Deleted ${th.name}'s worktree folder. It waits in Loom's trash for a day: ${trash}. Git's record of it was in use; Loom finishes moving it within the hour.`);
        return { removed: true, worktree: "pending", trash };
      }
      return partial({ removed: true, worktree: "failed", branch, error: `couldn't move its worktree folder to Loom's trash${branch ? ", so its branch was kept" : ""}: ${String(e)}` });
    }
    if (branch) {
      try {
        const configured = (await git(th.repo, "config", "--local", "--name-only", "--list", "-z")).split("\0").some((key) => key.slice(0, key.lastIndexOf(".")) === `branch.${named}`);
        // The approved tip only, and never while a worktree has the branch: one ref transaction checks
        // both with the ref locked, and puts the branch back if a checkout lands anyway (deletion.rs).
        await invoke("branch_delete", { repo: th.repo, branch: named, tip: expected });
        if (configured) {
          try { await git(th.repo, "config", "--local", "--remove-section", `branch.${named}`); }
          catch (e) {
            return partial({ removed: true, worktree: "removed", branch: "deleted", trash, error: `deleted the branch ${named}, but couldn't remove its local Git settings: ${String(e)}` });
          }
        }
      } catch (e) {
        return partial({ removed: true, worktree: "removed", branch: "failed", trash, error: `moved its worktree folder to Loom's trash and couldn't delete the branch ${named}: ${String(e)}` });
      }
    }
    if (trash) toast(`Deleted ${th.name}'s worktree folder. It waits in Loom's trash for a day: ${trash}`);
    return { removed: true, worktree: "removed", branch: branch && "deleted", trash };
  } finally {
    closingThreads.delete(th);
  }
}

const renameDlg = $<HTMLDialogElement>("#rename");
function renameThread(th: Thread) {
  const input = $<HTMLInputElement>("#rename-name");
  input.value = th.name;
  renameDlg.showModal();
  input.select();
  $<HTMLFormElement>("#rename-form").onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) th.rename(v);
    renameDlg.close();
  };
}

/** One row of a ⋯ menu: a label that closes the menu and does something. */
function menuItem(list: HTMLElement, label: string, fn: () => void, danger = false) {
  const d = document.createElement("div");
  d.className = `menu-item${danger ? " danger" : ""}`;
  const s = document.createElement("span");
  s.textContent = label;
  d.append(s);
  d.onclick = () => (hideMenu(), fn());
  list.append(d);
}

/** The ⋯ on a thread row, and right-click on it. */
const threadMenu = (th: Thread): Menu => ({
  placeholder: "",
  rows: (list) => {
    const item = (label: string, fn: () => void, danger = false) => menuItem(list, label, fn, danger);
    item("Changes", () => (show(th), toggleChanges(true)));
    item("Open in VS Code", () => void invoke("open_vscode", { dir: th.dir }).catch((e) => toast(String(e))));
    item("Rename…", () => renameThread(th));
    item(th.listed ? "Fold agents" : "List agents", () => th.setOpen(!th.listed));
    item("Close thread" + (th.isWorktree ? " (keep worktree)" : ""), () => removeThread(th, "close"));
    if (th.isWorktree) {
      item("Delete worktree (keep branch)", () => removeThread(th, "worktree"), true);
      item("Delete worktree and branch", () => removeThread(th, "all"), true);
    }
  },
});

// --- diff tabs: Orca opens a diff as a tab beside the agent; so do we -------
// The tabs are the diff view's header; closing the last one shows the panes
// again. Each holds a loader that re-reads git whenever the tab is shown, so
// a diff never goes stale behind a refresh.
type DiffSource = { sec: Sec; paths: string[] } | { commit: string } | { file: string };
type DiffTab = { label: string; load: () => Promise<string>; source: DiffSource; sec?: Sec; rendered?: string };
/** Hunks with git's three lines around them, or the whole file: `-U` big
 * enough that every hunk swallows the file. Read at load time so flipping it
 * re-reads the open tab. */
let diffFull = false;
const ctx = () => (diffFull ? ["-U999999"] : []);
const diffLoader = (th: Thread, source: DiffSource) => "commit" in source
  ? () => gitPreview(th.dir, [], "show", "--stat", "--patch", ...ctx(), source.commit)
  : "file" in source
    ? () => invoke<string>("read_file", { dir: th.dir, path: source.file })
    : diffOf(th, source.sec, source.paths);
const tabsEl = $("#tabs");
const diffView = $("#diff");
let showGen = 0; // reject an async load after its tab is gone
let shownTab: DiffTab | null = null; // whose rows #diff-body holds right now
let disposeDiffRows = () => {};

function openTab(th: Thread, label: string, source: DiffSource) {
  const load = diffLoader(th, source);
  const sec = "sec" in source ? source.sec : undefined;
  let t = th.tabs.find((x) => x.label === label);
  if (!t) th.tabs.push((t = { label, load, sec, source }));
  else ((t.load = load), (t.sec = sec), (t.source = source));
  th.tab = t;
  if (th !== current) show(th);
  else (paintTabs(), void showTab());
  save();
}

function closeTab(th: Thread, t: DiffTab) {
  const i = th.tabs.indexOf(t);
  th.tabs.splice(i, 1);
  if (th.tab === t) th.tab = th.tabs[i] ?? th.tabs[i - 1] ?? null; // a neighbour takes over; none left = the panes
  if (th === current) (paintTabs(), void showTab());
  save();
}

function paintTabs() {
  const th = current;
  tabsEl.textContent = "";
  $("#strip").classList.toggle("hidden", !th); // only the empty state has no bar
  paintSpeak();
  if (!th) return;
  // The panes are the first tab: a way back that keeps the diffs open. It wears
  // the focused pane's agent mark, so it reads as the agent, not another diff.
  const n = th.panes.length;
  mk(th.active ? icon(th.active.agent) : "▦", n === 1 ? (th.active?.agent ?? "pane") : `${n} panes`, !th.tab, () => ((th.tab = null), paintTabs(), void showTab()))
    .classList.add("panes");
  function mk(glyph: string | Node, label: string, on: boolean, pick: () => void, close?: () => void) {
    const b = document.createElement("div");
    b.className = `tab${on ? " on" : ""}`;
    b.title = label;
    const g = document.createElement("i");
    g.append(glyph);
    const s = document.createElement("span");
    s.textContent = label;
    b.append(g, s);
    b.onclick = () => { pick(); save(); };
    b.onauxclick = (e) => e.button === 1 && close?.();
    if (close) b.append(mini("✕", "Close", close));
    tabsEl.append(b);
    return b;
  }
  for (const t of th.tabs)
    mk("commit" in t.source ? "◆" : "file" in t.source ? "≡" : "±", t.label, th.tab === t,
      () => ((th.tab = t), paintTabs(), void showTab()), () => closeTab(th, t));
  tabsEl.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}
// The strip scrolls sideways, so the wheel does too — Orca's tab bar does the same.
tabsEl.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  tabsEl.scrollLeft += e.deltaY;
}, { passive: false });

/** Mark each run of added or removed rows on the overview ruler, at the run's
 * share of the row count.
 * ponytail: rows are taken as equal height — a wrapped line or a hunk header
 * is a little taller, so marks drift by a few px on long diffs; measure the
 * rows once drawn if that ever matters. */
function ruler(rows: DiffRow[]) {
  const marks: HTMLElement[] = [];
  for (let i = 0; i < rows.length; i++) {
    const kind = rows[i].kind;
    if (kind !== "add" && kind !== "del") continue;
    let j = i + 1;
    while (j < rows.length && rows[j].kind === kind) j++;
    const m = document.createElement("i");
    m.className = kind;
    m.style.top = `${(i / rows.length) * 100}%`;
    m.style.height = `${((j - i) / rows.length) * 100}%`;
    marks.push(m);
    i = j - 1;
  }
  $("#diff-ruler").replaceChildren(...marks);
}
/** The ruler stands for the scroll range: the viewport once the rows overflow
 * it, else the rows themselves, so a short diff's marks sit beside their lines. */
function rulerFit() {
  const body = $("#diff-body");
  const last = body.lastElementChild as HTMLElement | null; // offsets are from .diff-scroll, where the pre starts at 0
  const rows = last ? last.offsetTop + last.offsetHeight : 0;
  $("#diff-ruler").style.height = `${Math.min(rows, body.clientHeight)}px`;
}
new ResizeObserver(rulerFit).observe($("#diff-body"));

/** Show the current thread's active tab: its panes, or a diff read fresh. */
async function showTab() {
  const th = current;
  const t = th?.tab;
  if (!th || !t) {
    disposeDiffRows();
    disposeDiffRows = () => {};
    $("#diff-body").replaceChildren();
    shownTab = null;
    return void (showGen++, diffView.classList.add("hidden"));
  }
  $("#diff-name").textContent = t.label;
  const body = $("#diff-body");
  const isFile = "file" in t.source;
  $("#diff-full").classList.toggle("hidden", isFile); // a file is already all of it
  diffView.classList.remove("hidden");
  const gen = ++showGen;
  // A commit can't change: once its rows are up there is nothing to re-read.
  if ("commit" in t.source && shownTab === t && t.rendered !== undefined) return;
  if (t.rendered === undefined) {
    disposeDiffRows();
    disposeDiffRows = () => {};
    body.textContent = "Loading…";
    ruler([]);
  } // else keep the old rows up while git answers
  const imagePath = "file" in t.source && imageMime(t.source.file) ? t.source.file : null;
  body.classList.toggle("image-preview", !!imagePath);
  if (imagePath) {
    ruler([]);
    const img = document.createElement("img");
    img.alt = imagePath;
    try {
      // After one failed ipc:// fetch, Tauri answers over postMessage for the
      // rest of the window's life, and raw bytes then arrive as a number array.
      const bytes = await invoke<ArrayBuffer | number[]>("read_image", { dir: th.dir, path: imagePath });
      if (current !== th || th.tab !== t || gen !== showGen) return;
      disposeDiffRows();
      disposeDiffRows = () => {};
      const url = URL.createObjectURL(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], { type: imageMime(imagePath) }));
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => { URL.revokeObjectURL(url); if (body.contains(img)) body.textContent = "Could not display this image."; };
      img.src = url;
      body.replaceChildren(img);
      shownTab = t;
    } catch (e) {
      if (current !== th || th.tab !== t || gen !== showGen) return;
      disposeDiffRows();
      disposeDiffRows = () => {};
      const matches = e && typeof e === "object" && "matches" in e ? e.matches : null;
      if (Array.isArray(matches) && matches.length > 1 && matches.every(path => typeof path === "string")) {
        const choices = document.createElement("div");
        choices.className = "image-choices";
        const heading = document.createElement("strong");
        heading.textContent = "Choose an image";
        choices.append(heading);
        for (const path of matches) {
          const relative = path.slice(th.dir.length + 1);
          choices.append(mini(relative, path, () => openTab(th, t.label, { file: path })));
        }
        body.replaceChildren(choices);
      } else body.textContent = `Could not open image: ${String(e)}`;
    }
    return;
  }
  const text = await t.load().catch((e) => String(e));
  if (current !== th || th.tab !== t || gen !== showGen) return; // moved on while git was answering
  // The panel re-reads every poll to stay in step; the DOM only moves when the
  // diff did. A full-file view is tens of thousands of rows — not for redrawing
  // every ten seconds, and a redraw would drop the scroll position.
  if (text === t.rendered && shownTab === t) return; // else another tab's rows are up
  t.rendered = text;
  shownTab = t;
  disposeDiffRows();
  body.textContent = "";
  const CAP = 50_000;
  const parsed = isFile ? fileRows(text, CAP) : undefined;
  const rows = parsed?.rows ?? diffRows(text, CAP + 1);
  const count = parsed?.count ?? rows.length;
  // Which way a hunk moves depends on the side the tab is showing: an unstaged
  // hunk goes into the index or out of the file, a staged one comes back out.
  const moves: [string, string, string[]][] =
    !isFile && rows.length > CAP ? [] : t.sec === "unstaged"
      ? [
          ["Stage", "Stage this hunk", ["apply", "--cached"]],
          ["Discard", "Throw this hunk away", ["apply", "--reverse"]],
        ]
      : t.sec === "staged"
        ? [["Unstage", "Take this hunk out of the index", ["apply", "--cached", "--reverse"]]]
        : [];
  // ponytail: preview only the first 50k lines; open larger files in an editor.
  const end = Math.min(rows.length, CAP);
  ruler(rows.slice(0, end));
  const line = (r: DiffRow, i: number) => {
    const d = document.createElement("div");
    d.className = `line ${r.kind}`;
    const o = document.createElement("i");
    o.textContent = r.old ? String(r.old) : "";
    const n = document.createElement("i");
    n.textContent = r.neu ? String(r.neu) : "";
    const s = document.createElement("span");
    s.textContent = r.text || " ";
    d.append(o, n, s);
    if (r.kind === "hunk")
      for (const [label, title, args] of moves)
        d.append(mini(label, title, async () => {
          // Discarding throws work away: it asks first, as the phone and loomctl do.
          const patch = hunkPatch(rows, i), file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? t.label;
          if (label === "Discard" && !(await confirm("Discard this hunk?", { title: "Loom", kind: "warning", action: "Discard", detail: `Its changes to ${file} can't be brought back.` }))) return;
          void applyHunk(th, patch, args);
        }));
    return d;
  };
  disposeDiffRows = renderRows(body, body, end, 18, i => line(rows[i], i));
  if (count > CAP) note(body, !isFile ? "Preview limited to 50,000 lines. Open in an editor; hunk actions are disabled." : `… ${count - CAP} more lines`);
  if (!rows.length) note(body, "no differences");
  rulerFit();
}

/** Every file of a section as one diff, against the base that section is
 * measured from: the index for staged rows, the file on disk for the rest.
 * Untracked files have no base at all, so they go against nothing.
 * That base is also what makes a hunk button meaningful — a diff of `HEAD`
 * mixes both sides and cannot be applied to either. */
const diffOf = (th: Thread, sec: Sec, paths: string[], full = diffFull) => async () => {
  if (sec !== "untracked") return gitPreview(th.dir, [], "diff", ...(full ? ["-U999999"] : []), ...(sec === "staged" ? ["--cached"] : []), "--", ...literal(paths));
  const parts: string[] = [];
  let bytes = 0;
  for (const u of paths) {
    const part = await gitPreview(th.dir, [1], "diff", "--no-index", "--", "/dev/null", u);
    bytes += new TextEncoder().encode(part).length + 1;
    if (bytes > 4 * 1024 * 1024) throw new Error("Diff preview exceeds 4 MiB. Open the files in an editor.");
    parts.push(part);
  }
  return parts.join("\n");
};

/** Move one hunk. git reads the patch on stdin, so nothing hits the disk. */
async function applyHunk(th: Thread, patch: string, args: string[]) {
  if (!patch) return;
  try {
    await invoke("git_stdin", { dir: th.dir, args, patch });
  } catch (e) {
    toast(String(e));
  }
  await refreshChanges();
  void pollStats();
}

// --- changes panel: Orca's right-hand side --------------------------------
// Read from git on open and every poll while open. Sections fold, folders
// fold, "View all" opens the whole section as one diff, a file opens its own.
const changes = $("#changes");
const changesBtn = $("#changes-btn");
let changesOpen = false;
const foldedSections = new Set<string>(["Commits"]);
const foldedDirs = new Set<string>();
// ponytail: one count for every thread; each poll re-reads this many, a few hundred is still one cheap git log
let commitLimit = 10; // Commits rows; "Show more" adds 50, "Show less" goes back to 10
/** The right panel is Orca's: git's view of the thread, or every file in it. */
let panel: "changes" | "files" = "changes";
const openDirs = new Set<string>(); // Files tree folders unfolded; shut by default, the repo is big
let panelSig = ""; // what the panel body last drew, so an unchanged poll leaves the DOM alone
let disposeFileRows = () => {};

function toggleChanges(on = !changesOpen) {
  changesOpen = on;
  changes.classList.toggle("hidden", !on);
  changesBtn.classList.toggle("on", on);
  changesBtn.setAttribute("aria-pressed", String(on));
  current?.panes.forEach((p) => p.resize()); // the stage just changed width
  if (on) void refreshChanges();
  save();
}

function setPanel(p: typeof panel) {
  panel = p;
  changes.classList.toggle("files", p === "files");
  for (const q of ["changes", "files"] as const)
    $(`#panel-${q}`).setAttribute("aria-selected", String(q === p));
  save();
  void refreshChanges();
}

/** The Files tab: what git tracks or would track, else whatever is on disk.
 * Folders fold; a file opens as a tab beside the panes, like a diff does. */
async function refreshFiles(th: Thread, body: HTMLElement) {
  const paths = await git(th.dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .then((z) => z.split("\0").filter(Boolean), () => invoke<string[]>("list_files", { dir: th.dir }))
    .catch((e) => (toast(String(e)), [] as string[]));
  if (th !== current || panel !== "files") return;
  paths.sort();
  // Same list, same folds: leave the tree alone — the poll runs every ten seconds.
  const sig = JSON.stringify([th.dir, paths, [...openDirs]]);
  if (sig === panelSig && body.childElementCount) return;
  panelSig = sig;
  disposeFileRows();
  body.textContent = "";
  const entries: { node: Tree | Tree["files"][number]; depth: number }[] = [];
  const walk = (node: Tree, depth: number) => {
    for (const d of node.dirs) {
      entries.push({ node: d, depth });
      if (openDirs.has(d.path)) walk(d, depth + 1);
    }
    for (const f of node.files) entries.push({ node: f, depth });
  };
  walk(tree(paths), 0);
  const fileRow = (i: number) => {
    const { node: entry, depth } = entries[i];
    if ("dirs" in entry) {
      const d = entry;
      const row = document.createElement("div");
      row.className = `dir${openDirs.has(d.path) ? "" : " folded"}`;
      row.style.setProperty("--depth", String(depth));
      row.innerHTML = `<i class="chev"></i><span>${esc(d.name)}</span><b>${d.count}</b>`;
      row.onclick = () => {
        openDirs.has(d.path) ? openDirs.delete(d.path) : openDirs.add(d.path);
        save();
        void refreshChanges();
      };
      return row;
    } else {
      const f = entry;
      const path = paths[f.i];
      const row = document.createElement("div");
      row.className = "file";
      row.title = path;
      row.style.setProperty("--depth", String(depth));
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = f.name;
      row.append(name);
      row.onclick = () => openTab(th, f.name, { file: path });
      row.oncontextmenu = (e) => (
        e.preventDefault(),
        showMenu(row, {
          placeholder: "",
          rows: (list) => {
            menuItem(list, "Copy path", () => void navigator.clipboard.writeText(path));
            menuItem(list, "Open in VS Code", () =>
              void invoke("open_vscode", { dir: th.dir, goto: path }).catch((e) => toast(String(e))),
            );
          },
        })
      );
      return row;
    }
  };
  // The same band the Changes sections wear: the folder's name, how many
  // files, and a way back to a folded tree once you have opened half of it.
  const collapse = () => (openDirs.clear(), save(), void refreshChanges());
  const h = document.createElement("div");
  h.className = `changes-h${openDirs.size ? "" : " folded"}`;
  h.onclick = collapse;
  const chev = document.createElement("i");
  chev.className = "chev";
  const t = document.createElement("span");
  t.textContent = `${basename(th.dir)} ${paths.length}`;
  const fold = document.createElement("a");
  fold.textContent = "Collapse all";
  fold.hidden = !openDirs.size;
  fold.onclick = (e) => (e.stopPropagation(), collapse());
  h.append(chev, t, fold);
  body.append(h);
  const list = document.createElement("div");
  body.append(list);
  disposeFileRows = renderRows(list, body, entries.length, 22, fileRow);
  if (!paths.length) note(body, "no files");
  if (th.tab) void showTab();
}

const LETTER: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", "?": "U", U: "U", T: "T" };

// Staging, unstaging and discarding from the tree, so none of it needs a
// shell. One section owns the selection at a time: the same path means a
// different git command in each list, and mixing them is how work gets lost.
let selSec: Sec | null = null;
const sel = new Set<string>();
let selAnchor = "";
let hasStaged = false;

const clearSel = () => ((sel.clear(), (selSec = null)), void refreshChanges());

/** ctrl-click toggles rows in and out, shift-click takes the run since the
 * last one, and a folder brings its whole subtree. */
function select(sec: Sec, paths: string[], add: boolean, anchor = selAnchor) {
  if (selSec !== sec) (sel.clear(), (selSec = sec));
  const off = !add && paths.every((p) => sel.has(p));
  for (const p of paths) off ? sel.delete(p) : sel.add(p);
  selAnchor = anchor;
  if (!sel.size) selSec = null;
  void refreshChanges();
}

/** The rows between the last click and this one, in the order they are drawn. */
const runTo = (order: string[], to: string) => {
  const a = order.indexOf(selAnchor);
  const b = order.indexOf(to);
  return a < 0 || b < 0 ? [to] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
};

/** The verbs a row carries: glyphs on hover, words in the selection bar.
 * `files` is read at click time — the row may have been redrawn since. */
function actBtns(th: Thread, sec: Sec, files: () => Change[], words = false) {
  const b: HTMLButtonElement[] = [];
  const add = (glyph: string, word: string, title: string, act: Act) =>
    b.push(mini(words ? word : glyph, title, () => void doAct(th, sec, act, files())));
  if (sec === "staged") add("−", "Unstage", "Unstage", "unstage");
  else add("+", "Stage", "Stage", "stage");
  if (sec === "untracked") add("✕", "Delete", "Delete — git has no copy of it", "discard");
  else add("↺", "Discard", "Discard these changes", "discard");
  return b;
}

/** Run one verb over some files, asking first when it throws work away.
 * `th` is the thread the rows were drawn for: the panel shows them until the
 * next thread's status arrives, and the same path there is someone else's. */
async function doAct(th: Thread, sec: Sec, act: Act, files: Change[]) {
  if (!files.length) return;
  const what = files.length === 1 ? files[0].path : `${files.length} files`;
  if (act === "discard") {
    const q =
      sec === "untracked"
        ? `Delete ${what}?\n\nUntracked — git has no copy to bring it back.`
        : `Discard changes in ${what}?\n\nThis cannot be undone.`;
    if (!(await confirm(q, { title: "Loom", kind: "warning", action: sec === "untracked" ? "Delete files" : "Discard changes" }))) return;
  }
  try {
    for (const args of gitAct(sec, act, files)) await git(th.dir, ...args);
  } catch (e) {
    toast(String(e));
  }
  sel.clear();
  selSec = null;
  await refreshChanges();
  void pollStats();
}

/** Right-click a file or folder: the verbs with names on them, plus the two
 * things you would otherwise open a shell for. Hits the whole selection when
 * the row is part of one. */
const fileMenu = (th: Thread, sec: Sec, files: Change[]): Menu => ({
  placeholder: "",
  rows: (list) => {
    const n = files.length > 1 ? ` ${files.length} files` : "";
    const fight = files.every(conflicted);
    if (fight) {
      menuItem(list, `Keep ours${n}`, () => void resolve(th, "ours", files));
      menuItem(list, `Keep theirs${n}`, () => void resolve(th, "theirs", files));
    }
    menuItem(list, fight ? `Mark resolved${n}` : sec === "staged" ? `Unstage${n}` : `Stage${n}`, () =>
      void doAct(th, sec, !fight && sec === "staged" ? "unstage" : "stage", files),
    );
    menuItem(
      list,
      sec === "untracked" ? `Delete${n || " file"}` : `Discard changes${n}`,
      () => void doAct(th, sec, "discard", files),
      true,
    );
    menuItem(list, `Copy path${n}`, () => void navigator.clipboard.writeText(files.map((c) => c.path).join("\n")));
    menuItem(list, "Open in VS Code", () =>
      void invoke("open_vscode", { dir: th.dir, goto: files[0].path }).catch((e) => toast(String(e))),
    );
  },
});

/** One repo-wide git command from the ⋯: confirm when it can lose work, show
 * the button busy while it runs, and put git's own words up when it refuses.
 * Re-reads HEAD afterwards because half of these move the branch. `th` is the
 * thread the menu or bar was drawn for, not whichever is open by the time you
 * click or confirm. False when you cancelled or git refused. */
async function gitDo(th: Thread, ask: string, ...args: string[]) {
  if (ask && !(await confirm(ask, { title: "Loom", kind: "warning" }))) return false;
  const b = $<HTMLButtonElement>("#changes-more");
  b.disabled = true;
  let ok = true;
  try {
    await git(th.dir, ...args);
  } catch (e) {
    ok = false;
    toast(String(e));
  }
  b.disabled = false;
  th.branch = await headBranch(th);
  th.setStat(th.changed);
  save();
  await refreshChanges();
  void pollStats();
  return ok;
}

/** A conflicted file: both sides touched it and git wants a decision. */
const conflicted = (c: Change) => c.x === "U" || c.y === "U" || (c.x === c.y && (c.x === "A" || c.x === "D"));

/** Take one side of a conflict wholesale and mark it resolved. */
async function resolve(th: Thread, side: "ours" | "theirs", files: Change[]) {
  try {
    for (const args of resolveArgs(side, files.map((c) => c.path))) await git(th.dir, ...args);
  } catch (e) {
    toast(String(e));
  }
  await refreshChanges();
  void pollStats();
}

/** Right-click a commit in the log. */
const commitMenuFor = (th: Thread, sha: string): Menu => ({
  placeholder: "",
  rows: (list) => {
    menuItem(list, "Revert this commit", () =>
      void gitDo(th, `Revert ${sha}?\nA new commit undoing it lands on this branch.`, "-c", "core.editor=true", "revert", "--no-edit", sha),
    );
    menuItem(
      list,
      "Reset to here (keep changes)",
      () => void gitDo(th, `Move the branch back to ${sha}?\nEverything after it stays in the tree, staged.`, "reset", "--soft", sha),
      true,
    );
    menuItem(
      list,
      "Reset to here (throw changes away)",
      () => void gitDo(th, `Reset hard to ${sha}?\nEvery change after it is lost.`, "reset", "--hard", sha),
      true,
    );
    menuItem(list, "Copy SHA", () => void navigator.clipboard.writeText(sha));
  },
});

/** The ⋯'s menu for a list git just gave for `th`. Dropped when you left `th`
 * while git answered: it would put one thread's list over another's. */
const showGitMenu = (th: Thread, m: Menu) => void (th === current && showMenu($("#changes-more"), m));

/** Branches, newest first, with the input adding one. `switch` refuses while
 * the tree is dirty or the branch is checked out in another worktree — git's
 * complaint goes to the toast, which is the answer either way. */
async function showBranches(th: Thread) {
  const out = await git(th.dir, "branch", "--format=%(refname)", "--sort=-committerdate").catch(() => "");
  const names = out.split(/\r?\n/).filter((s) => s.startsWith("refs/heads/")).map((s) => s.slice("refs/heads/".length)).slice(0, 40);
  showGitMenu(th, {
    placeholder: "new branch…",
    add: (v) => void gitDo(th, "", "switch", "-c", v),
    rows: (list) => {
      if (!names.length) return note(list, "no branches yet");
      for (const n of names)
        menuItem(list, n === th.branch ? `${n} ✓` : n, () => void gitDo(th, "", "switch", n));
    },
  });
}

/** The stash, applied rather than popped and picked by name: the stack is
 * shared with every other worktree of this repo, so "the top one" is not
 * necessarily yours. */
async function showStashes(th: Thread) {
  const rows = await listStashes((...args) => git(th.dir, ...args)).catch(() => []);
  showGitMenu(th, {
    placeholder: "",
    rows: (list) => {
      if (!rows.length) return note(list, "no stashes");
      // By commit: the menu may stand open while another worktree stashes onto stash@{0} (stash.ts).
      for (const { ref, sha, message } of rows) {
        const d = document.createElement("div");
        d.className = "menu-item";
        const s = document.createElement("span");
        s.textContent = `${ref}  ${message}`;
        s.title = message || ref;
        d.append(
          s,
          mini("✕", "Drop this stash", () => (hideMenu(), void dropListed(th, ref, sha))),
        );
        d.onclick = () => (hideMenu(), void gitDo(th, "", "stash", "apply", sha));
        list.append(d);
      }
    },
  });
}

/** The menu's drop, confirmed as gitDo asks: the stash it listed, by commit (stash.ts). */
async function dropListed(th: Thread, ref: string, sha: string) {
  if (!(await confirm(`Drop ${ref}?`, { title: "Loom", kind: "warning" }))) return;
  await invoke("stash_drop", { dir: th.dir, sha }).catch((e) => toast(String(e)));
  await refreshChanges();
  void pollStats();
}

/** Amend with whatever is staged; the message box replaces the message when
 * it has something in it. The box empties only once git has amended with it. */
async function amend(th: Thread) {
  const draft = th.commitDraft;
  const m = draft.trim();
  const ok = await gitDo(
    th,
    `Amend the last commit?\n${m ? "Its message becomes what is in the box." : "Its message is kept."}`,
    "commit",
    "--amend",
    ...(m ? ["-m", m] : ["--no-edit"]),
  );
  if (ok) usedDraft(th, draft);
}

/** Everything git that isn't about one file: the ⋯ beside Create PR. */
const repoMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const th = current;
    if (!th) return;
    menuItem(list, "Fetch", () => void gitDo(th, "", "fetch", "--all", "--prune"));
    menuItem(list, "Pull (rebase)", () => void gitDo(th, "", "pull", "--rebase", "--autostash"));
    menuItem(list, "Push", () => void gitDo(th, "", "push", "-u", "origin", "HEAD"));
    menuItem(
      list,
      "Force push (with lease)",
      () => void gitDo(th, `Force-push ${th.branch}?\nIt overwrites the remote branch unless someone else has pushed since you last fetched.`, "push", "--force-with-lease"),
      true,
    );
    menuItem(list, "Switch branch…", () => void showBranches(th));
    menuItem(list, "Amend last commit", () => void amend(th));
    menuItem(list, "Undo last commit (keep changes)", () =>
      void gitDo(th, "Undo the last commit?\nIts changes come back as staged work.", "reset", "--soft", "HEAD~1"),
    );
    menuItem(list, "Stash all changes", () =>
      void gitDo(th, "", "stash", "push", "-u", "-m", `loom ${th.name}`),
    );
    menuItem(list, "Restore a stash…", () => void showStashes(th));
  },
};

/** Continue / skip / abort, when git has stopped half way through something.
 * `core.editor=true` because nothing here can pop an editor and wait. */
function midwayBar(th: Thread, state: string) {
  const bar = document.createElement("div");
  bar.className = "sel-bar warn";
  const label = document.createElement("span");
  label.textContent = `${state} in progress`;
  const btns =
    state === "merge"
      ? [
          mini("Commit", "Finish the merge", () => void gitDo(th, "", "-c", "core.editor=true", "commit", "--no-edit")),
          mini("Abort", "Undo the merge", () => void gitDo(th, "Abort the merge?", "merge", "--abort")),
        ]
      : state === "revert"
        ? [
            mini("Continue", "Finish the revert", () => void gitDo(th, "", "-c", "core.editor=true", "revert", "--continue")),
            mini("Abort", "Undo the revert", () => void gitDo(th, "Abort the revert?", "revert", "--abort")),
          ]
        : [
            mini("Continue", "Go on with the rebase", () => void gitDo(th, "", "-c", "core.editor=true", "rebase", "--continue")),
            mini("Skip", "Drop the commit being applied", () => void gitDo(th, "Skip this commit?", "rebase", "--skip")),
            mini("Abort", "Put the branch back", () => void gitDo(th, "Abort the rebase?", "rebase", "--abort")),
          ];
  bar.append(label, ...btns);
  return bar;
}

let changesRefresh: Promise<void> | undefined;
let changesRefreshAgain = false;
function refreshChanges(): Promise<void> {
  changesRefreshAgain = true;
  return changesRefresh ??= (async () => {
    // Keep one follow-up for changes made while Git was answering.
    while (changesRefreshAgain) {
      changesRefreshAgain = false;
      await readChanges();
    }
  })().finally(() => { changesRefresh = undefined; });
}

async function readChanges() {
  const th = current;
  if (!th || !changesOpen) return;
  const body = $("#changes-body");
  if (panel === "files") return refreshFiles(th, body);
  let status: Change[];
  let unstaged: Map<string, Stat>;
  let staged: Map<string, Stat>;
  let upstream = "";
  let log = "";
  let span = "";
  let midway = "";
  let head: Map<string, Stat>; // against HEAD: the thread bar and sidebar numbers
  try {
    let branch: string;
    [branch, unstaged, staged, log, midway, head] = await Promise.all([
      // --branch: the upstream and how far apart, in the same process. The
      // branch's name from git too: it may have switched in the terminal.
      syncBranch(th).then(() => git(th.dir, "status", "--porcelain=v1", "-z", "-uall", "--branch")),
      git(th.dir, "diff", "--numstat").then(parseNumstat),
      git(th.dir, "diff", "--numstat", "--cached").then(parseNumstat),
      git(th.dir, "log", "--oneline", "-n", String(commitLimit + 1)).catch(() => ""), // one past: is there more?
      // What git stopped in the middle of: "merge", "revert", "rebase" or "".
      invoke<string>("git_midway", { dir: th.dir }).catch(() => ""),
      git(th.dir, "diff", "--numstat", "HEAD").then(parseNumstat, () => new Map<string, Stat>()),
    ]);
    status = parseStatus(branch);
    const tracking = parseBranch(branch);
    ({ upstream, span } = tracking);
    if (tracking.ask) upstream = await git(th.dir, "rev-parse", "--abbrev-ref", "@{upstream}").then((s) => s.trim(), () => "");
  } catch (e) {
    panelSig = "";
    disposeFileRows();
    disposeFileRows = () => {};
    body.textContent = "";
    note(body, String(e));
    return;
  }
  if (th !== current) return; // switched threads while git was answering
  th.setStat({ ...sumStat(head.values()), files: status.length }); // pollStats skips this thread while the panel is up
  const total = sumStat([...unstaged.values(), ...staged.values()]);
  $("#changes-branch").textContent = th.branch || "(no branch)";
  $("#changes-stat").innerHTML = statHtml(total);
  $("#changes-base").textContent = upstreamLabel(upstream, span);

  const tracked = status.filter((c) => c.x !== "?");
  const secRows: Record<Sec, Change[]> = {
    unstaged: tracked.filter((c) => c.y !== " "),
    staged: tracked.filter((c) => c.x !== " "),
    untracked: status.filter((c) => c.x === "?"),
  };
  hasStaged = secRows.staged.length > 0;
  // A diff tab outlives its changes only as "no differences": once the section
  // it came from lists none of its paths — committed, discarded, staged across —
  // it goes. File and commit tabs are views of things that stay.
  for (const t of th.tabs.filter((t) => "sec" in t.source))
    if (!(t.source as { sec: Sec; paths: string[] }).paths.some((p) => secRows[(t.source as { sec: Sec }).sec].some((c) => c.path === p)))
      closeTab(th, t);
  // Whatever was selected and has since been staged, discarded or committed
  // is no longer in the section it was picked from.
  if (selSec) {
    const live = new Set(secRows[selSec].map((c) => c.path));
    for (const p of sel) if (!live.has(p)) sel.delete(p);
    if (!sel.size) selSec = null;
  }
  // Nothing git said or you did has changed since the last draw: keep the DOM,
  // and with it hover, focus and scroll. The poll lands here every ten seconds.
  const sig = JSON.stringify([th.dir, status, [...unstaged], [...staged], upstream, log, span, midway,
    [...foldedSections], [...foldedDirs], selSec, [...sel]]);
  if (sig === panelSig && body.childElementCount) return void (th.tab && showTab());
  panelSig = sig;
  disposeFileRows();
  disposeFileRows = () => {};
  body.textContent = "";
  if (midway) body.append(midwayBar(th, midway));
  if (selSec) {
    const sec = selSec;
    const bar = document.createElement("div");
    bar.className = "sel-bar";
    const n = document.createElement("span");
    n.textContent = `${sel.size} selected`;
    bar.append(
      n,
      ...actBtns(th, sec, () => secRows[sec].filter((c) => sel.has(c.path)), true),
      mini("✕", "Clear the selection", clearSel),
    );
    body.append(bar);
  }
  const section = (title: string, sec: Sec, stats: Map<string, Stat>, letter: (c: Change) => string) => {
    const rows = secRows[sec];
    if (!rows.length) return;
    const h = document.createElement("div");
    h.className = `changes-h${foldedSections.has(title) ? " folded" : ""}`;
    const chev = document.createElement("i");
    chev.className = "chev";
    const t = document.createElement("span");
    t.textContent = `${title} ${rows.length}`;
    const all = document.createElement("a");
    all.textContent = "View all";
    all.onclick = (e) => {
      e.stopPropagation();
      openTab(th, `${title} (all)`, { sec, paths: rows.map((c) => c.path) });
    };
    const hActs = document.createElement("span");
    hActs.className = "acts";
    hActs.append(...actBtns(th, sec, () => rows)); // on the header the verbs mean "all of it"
    h.append(chev, t, all, hActs);
    h.onclick = () => {
      foldedSections.has(title) ? foldedSections.delete(title) : foldedSections.add(title);
      save();
      void refreshChanges();
    };
    body.append(h);
    if (foldedSections.has(title)) return;
    const list = document.createElement("div");
    list.className = "changes-list";
    body.append(list);
    const paths = rows.map((c) => c.path);
    const order: string[] = []; // files in the order they end up on screen, for shift-click
    const walk = (node: Tree, depth: number, into: HTMLElement) => {
      for (const d of node.dirs) {
        const key = `${title}:${d.path}`;
        const under = () => rows.filter((c) => c.path === d.path || c.path.startsWith(`${d.path}/`));
        const row = document.createElement("div");
        row.className = `dir${foldedDirs.has(key) ? " folded" : ""}`;
        row.style.setProperty("--depth", String(depth));
        row.innerHTML = `<i class="chev"></i><span>${esc(d.name)}</span><b>${d.count}</b>`;
        const acts = document.createElement("span");
        acts.className = "acts";
        acts.append(...actBtns(th, sec, under));
        row.append(acts);
        row.onclick = (e) => {
          if (e.ctrlKey || e.metaKey) return select(sec, under().map((c) => c.path), false);
          foldedDirs.has(key) ? foldedDirs.delete(key) : foldedDirs.add(key);
          save();
          void refreshChanges();
        };
        row.oncontextmenu = (e) => (e.preventDefault(), showMenu(row, fileMenu(th, sec, under())));
        into.append(row);
        if (!foldedDirs.has(key)) walk(d, depth + 1, into);
      }
      for (const f of node.files) {
        const c = rows[f.i];
        order.push(c.path);
        const picked = selSec === sec && sel.has(c.path);
        const row = document.createElement("div");
        row.className = `file${picked ? " sel" : ""}`;
        row.title = c.orig ? `${c.orig} → ${c.path}` : c.path;
        row.style.setProperty("--depth", String(depth));
        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = f.name;
        const acts = document.createElement("span");
        acts.className = "acts";
        acts.append(...actBtns(th, sec, () => [c]));
        const st = document.createElement("span");
        st.className = "file-stat";
        const s = stats.get(c.path);
        st.innerHTML = (s ? statHtml(s) + " " : "") + `<b class="st-${letter(c)}">${letter(c)}</b>`;
        row.append(name, acts, st);
        row.onclick = (e) => {
          if (e.shiftKey) return select(sec, runTo(order, c.path), true);
          if (e.ctrlKey || e.metaKey) return select(sec, [c.path], false, c.path);
          // The label says which side, so a file open in both lists is two tabs.
          openTab(th, `${f.name} (${sec === "staged" ? "staged" : "diff"})`, { sec, paths: [c.path] });
        };
        row.oncontextmenu = (e) => (
          e.preventDefault(), showMenu(row, fileMenu(th, sec, picked ? rows.filter((x) => sel.has(x.path)) : [c]))
        );
        into.append(row);
      }
    };
    walk(tree(paths), 0, list);
  };
  section("Changes", "unstaged", unstaged, (c) => LETTER[c.y] ?? c.y);
  section("Staged changes", "staged", staged, (c) => LETTER[c.x] ?? c.x);
  section("Untracked", "untracked", new Map(), () => "U"); // short: the header carries buttons now
  if (!status.length) note(body, "working tree clean");
  if (log.trim()) {
    const h = document.createElement("div");
    h.className = `changes-h${foldedSections.has("Commits") ? " folded" : ""}`;
    h.innerHTML = `<i class="chev"></i><span>Commits</span>`;
    h.onclick = () => {
      foldedSections.has("Commits") ? foldedSections.delete("Commits") : foldedSections.add("Commits");
      save();
      void refreshChanges();
    };
    body.append(h);
    if (!foldedSections.has("Commits")) {
      const lines = log.trim().split("\n");
      for (const line of lines.slice(0, commitLimit)) {
        const d = document.createElement("div");
        d.className = "commit";
        const [sha, ...msg] = line.split(" ");
        d.innerHTML = `<b>${esc(sha)}</b> ${esc(msg.join(" "))}`;
        d.title = "Show this commit — right-click to revert or reset";
        d.onclick = () => openTab(th, `${sha} (commit)`, { commit: sha });
        d.oncontextmenu = (e) => (e.preventDefault(), showMenu(d, commitMenuFor(th, sha)));
        body.append(d);
      }
      const pager = (label: string, limit: number) => {
        const b = document.createElement("button"); // Tab reaches it, Enter and Space press it
        b.type = "button";
        b.className = "commit more";
        b.textContent = label;
        b.onclick = () => ((commitLimit = limit), void refreshChanges());
        body.append(b);
      };
      if (lines.length > commitLimit) pager("Show more", commitLimit + 50);
      if (commitLimit > 10 && lines.length > 10) pager("Show less", 10);
    }
  }
  // A diff tab on screen describes what the panel just re-read: keep them in step.
  if (th.tab) void showTab();
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const statHtml = (s: Stat) =>
  s.add || s.del ? `<span class="add">+${s.add}</span> <span class="del">−${s.del}</span>` : "";

function note(el: HTMLElement, text: string) {
  const d = document.createElement("div");
  d.className = "menu-note";
  d.textContent = text;
  el.append(d);
}

/** A commit took `draft` as its message: empty the thread's box, unless you
 * typed something else into it while git ran. */
function usedDraft(th: Thread, draft: string) {
  if (th.commitDraft !== draft) return;
  th.commitDraft = "";
  if (current === th) $<HTMLTextAreaElement>("#commit-msg").value = "";
  save();
}

/** Commit everything the thread has changed, and push when asked. Orca's box
 * does the same; the staged/unstaged split above is for reading. */
async function commitAll(push = false, all = true) {
  const th = current;
  const msg = $<HTMLTextAreaElement>("#commit-msg");
  // The message as you pressed Commit: by the time `add` answers the box may
  // show another thread's draft, or what you went on to type.
  const draft = msg.value;
  if (!th || !draft.trim()) return msg.focus();
  const btn = $<HTMLButtonElement>("#commit-btn");
  btn.disabled = true;
  let err = "";
  try {
    if (all) await git(th.dir, "add", "-A");
    await git(th.dir, "commit", "-m", draft.trim());
    usedDraft(th, draft);
    if (push) await git(th.dir, "push", "-u", "origin", "HEAD");
  } catch (e) {
    err = String(e);
  } finally {
    btn.disabled = false;
  }
  await refreshChanges();
  if (err) note($("#changes-body"), err); // under the list, where the eye already is
  void pollStats();
}

const commitMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const items: [string, boolean, boolean][] = [
      ["Commit all", false, true],
      ["Commit all & push", true, true],
    ];
    // Only worth offering once the panel has put something in the index.
    if (hasStaged) items.push(["Commit staged", false, false], ["Commit staged & push", true, false]);
    for (const [label, push, all] of items) menuItem(list, label, () => void commitAll(push, all));
  },
};

/** Push the branch and open GitHub's compare page for it against the
 * remote's default branch — the PR form, minus Orca's own editor for it. */
async function createPR() {
  const th = current;
  if (!th) return;
  try {
    await openUrl(await prUrl(th));
  } catch (e) {
    note($("#changes-body"), String(e));
  }
  void refreshChanges();
}

/** Pushes the thread's branch and gives GitHub's compare page for it. */
async function prUrl(th: Thread) {
  // A detached worktree's cached branch is not a PR source.
  const ref = (await git(th.dir, "symbolic-ref", "HEAD")).replace(/\r?\n$/, "");
  if (!ref.startsWith("refs/heads/")) throw new Error("Create PR requires an attached branch.");
  const branch = ref.slice("refs/heads/".length);
  if (branch !== th.branch) ((th.branch = branch), save());
  const url = (await git(th.dir, "remote", "get-url", "origin").catch(() => "")).trim(); // no origin at all reads as one off GitHub
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`origin is not on GitHub: ${url || "(no origin)"}`);
  const head = (await git(th.dir, "symbolic-ref", "-q", "refs/remotes/origin/HEAD").catch(() => "")).replace(/\r?\n$/, "");
  const base = head.startsWith("refs/remotes/origin/") ? head.slice("refs/remotes/origin/".length) : "main";
  await git(th.dir, "push", "-u", "origin", `${ref}:${ref}`);
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}

/** The Changes panel as data, for loomctl git: the branch and its upstream, git's
 * half-done merge, revert or rebase, the three sections with their +/- counts,
 * and the last `commits` commits, with moreCommits when git has older ones.
 * Reading it refreshes the thread's sidebar numbers. */
async function gitStatus(th: Thread, commits = 10) {
  const [z, unstaged, staged, log, midway, head] = await Promise.all([
    syncBranch(th).then(() => git(th.dir, "status", "--porcelain=v1", "-z", "-uall", "--branch")),
    git(th.dir, "diff", "--numstat").then(parseNumstat),
    git(th.dir, "diff", "--numstat", "--cached").then(parseNumstat),
    git(th.dir, "log", "--oneline", "-n", String(commits + 1)).catch(() => ""), // one past: is there more?
    invoke<string>("git_midway", { dir: th.dir }).catch(() => ""),
    git(th.dir, "diff", "--numstat", "HEAD").then(parseNumstat, () => new Map<string, Stat>()),
  ]);
  const status = parseStatus(z);
  let { upstream, span, ask } = parseBranch(z);
  if (ask) upstream = await git(th.dir, "rev-parse", "--abbrev-ref", "@{upstream}").then((s) => s.trim(), () => "");
  const [behind = 0, ahead = 0] = span ? span.split("\t").map(Number) : [];
  th.setStat({ ...sumStat(head.values()), files: status.length });
  // orig rides along: stage, unstage and discard take a rename's rows from here.
  const row = (c: Change, stats: Map<string, Stat>) => ({ ...c, ...(stats.get(c.path) ?? { add: 0, del: 0 }) });
  const tracked = status.filter((c) => c.x !== "?");
  const lines = log.split("\n").filter(Boolean);
  return {
    thread: th.id, name: th.name, dir: th.dir, branch: th.branch, upstream, ahead, behind, midway,
    unstaged: tracked.filter((c) => c.y !== " ").map((c) => row(c, unstaged)),
    staged: tracked.filter((c) => c.x !== " ").map((c) => row(c, staged)),
    untracked: status.filter((c) => c.x === "?").map((c) => row(c, new Map())),
    commits: lines.slice(0, commits).map((l) => ({ sha: l.slice(0, l.indexOf(" ")), subject: l.slice(l.indexOf(" ") + 1) })),
    moreCommits: lines.length > commits,
    changed: th.changed,
  };
}
type GitStatus = Awaited<ReturnType<typeof gitStatus>>;

/** Sidebar and header stats: lines changed against HEAD plus the untracked
 * count. Two git calls per thread; a folder that is not a repo answers nothing
 * and stays blank. The current thread every 10 s, every thread once a minute
 * (`all`): a hidden thread's `+N −M` needs no more, and each call is a git.exe
 * launch that stats the whole worktree. The open Changes panel reads the
 * current thread's numbers itself, so that one is skipped while it is up. */
const statPolls = new Map<string, Promise<{ add: number; del: number; files: number } | null>>();
async function pollStats(all = false) {
  const targets = all ? threads : current ? [current] : [];
  await Promise.all(
    targets.filter((th) => !(changesOpen && panel === "changes" && th === current)).map(async (th) => {
      let pending = statPolls.get(th.dir);
      if (!pending) {
        pending = Promise.all([
          git(th.dir, "diff", "--numstat", "HEAD").then(parseNumstat, () => null),
          git(th.dir, "status", "--porcelain=v1", "-z", "-uall").then(parseStatus, () => null),
        ]).then(([numstat, status]) => numstat && status ? { ...sumStat(numstat.values()), files: status.length } : null)
          .finally(() => statPolls.delete(th.dir));
        statPolls.set(th.dir, pending);
      }
      const stats = await pending;
      if (stats) th.setStat(stats);
    }),
  );
  if (changesOpen) void refreshChanges();
}

/** Where a new worktree goes: ~\loom\<repo>\<thread>, like Orca's own
 * ~\orca\workspaces. Never inside the repo, where git would see it as untracked. */
const worktreeDir = async (repo: string, slug: string) => join(await homeDir(), "loom", basename(repo), slug);

/** What to cut a thread from for `ref` in `repo`: `ref` itself when it names a
 * commit here, else the commit origin has for it, fetched now into `own`, a ref
 * only this thread's creation uses, and read from there. createThread deletes
 * it once git worktree add has used the commit. Not origin/<ref>: a fetch
 * updates it only when origin's refspec covers it, so it can be a fetch behind. Not FETCH_HEAD:
 * every fetch in the repository rewrites it. null when neither here nor origin
 * has it: no origin, or origin answered that it has no such ref. A fetch that
 * fails any other way (unreachable, refused, misconfigured) throws: it says
 * nothing about the base, and a guess would start an agent on other code. */
async function resolveBase(repo: string, ref: string, own: string): Promise<string | null> {
  const commit = (r: string) => git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", r + "^{commit}").then((s) => s.trim() || null, () => null);
  if (await commit(ref)) return ref;
  const invalid = () => new Error(`${ref} exists but does not resolve to a commit, so no thread was made.`);
  if (await git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{object}").then((s) => s.trim(), () => "")) throw invalid();
  if (!(await git(repo, "remote")).split(/\r?\n/).includes("origin")) return null;
  const missing = await git(repo, "fetch", "origin", `+${ref}:${own}`).then(() => false, (e) => {
    if (String(e).split(/\r?\n/).includes(`fatal: couldn't find remote ref ${ref}`)) return true;
    throw new Error(`Couldn't fetch ${ref} from origin, so no thread was made: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (missing) return null;
  const fetched = await commit(own);
  if (!fetched) throw invalid();
  return fetched;
}

/** Cut a thread from `repo`, or — no name given — open the checkout itself as
 * one. A new name becomes branch `loom/<slug>` off `base` (HEAD when blank),
 * suffixed -2, -3… when that name is already a branch or a folder. A `base`
 * that names nothing, locally or on origin, is taken as a NEW branch name: the
 * thread is created on it, off HEAD. */
/** The thread it opened, or the one already open on that folder. */
async function createThread(repo: string, name: string, panes: PaneState[], base: string): Promise<Thread> {
  if (shuttingDown) throw new Error("Loom is closing. Retry closing the window before starting new work.");
  // Before git touches anything: a bad count must not leave a worktree behind.
  if (!panes.length || panes.length > MAX_PANES) throw new Error(`A thread takes 1 to ${MAX_PANES} panes, not ${panes.length}.`);
  let dir = repo;
  let branch = "";
  let left = ""; // the fetch's own ref, when it couldn't be deleted
  // A base with no name still means "cut me a worktree" — the branch names it.
  name ||= base;
  if (name) {
    // A base fetched from origin waits under this ref, made for this one
    // creation, until git worktree add has made a branch of it: referenced by
    // nothing else, an old commit is git gc's to prune meanwhile.
    const own = base && `refs/loom-fetch/${crypto.randomUUID()}`;
    // Deleting it waits out another git's lock on it for about two seconds,
    // then says what's left: Loom never breaks a lock that isn't its own.
    const release = async () => {
      for (let n = 1; own; n++) {
        try {
          await git(repo, "update-ref", "-d", own);
          break;
        } catch (e) {
          if (n === 10) return `couldn't delete its temporary ref ${own}: ${e instanceof Error ? e.message : String(e)}\nDelete it with git update-ref -d ${own} in ${repo}.`;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      return "";
    };
    try {
      // A missing base becomes the branch itself — unless it is spelled like a
      // remote ref (origin/x) that just isn't there, which is a typo, not a wish.
      let fresh = "";
      const found = base && (await resolveBase(repo, base, own));
      if (base && !found) {
        const remotes = (await git(repo, "remote").catch(() => "")).split(/\r?\n/).filter(Boolean);
        if (remotes.includes(base.split("/")[0])) throw new Error(`${base} is not a branch on that remote`);
        fresh = base;
        base = "";
      } else if (found) base = found; // a branch only on origin: its commit, as fetched
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) throw new Error("name needs a letter or digit in it");
      // A new thread is a new branch off `base`, the way Orca cuts one: a name
      // already taken — by a branch or by a folder — gets a numeric suffix
      // rather than silently reusing whatever was there, which would ignore the
      // base you asked for. To continue an existing branch, name it as the base.
      const taken = new Set(
        (await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/loom/"))
          .split(/\r?\n/)
          .filter(Boolean),
      );
      const dirs = new Set(threads.map((t) => t.dir.toLowerCase()));
      for (let i = 1; ; i++) {
        // ponytail: 100 names; a repository with more loom/<slug>-N than that gets an error, not a hang.
        if (i > 100) throw new Error(`No free name for ${slug}: ${slug} to ${slug}-100 are all taken.`);
        const cand = i === 1 ? slug : `${slug}-${i}`;
        branch = fresh || `loom/${cand}`;
        dir = await worktreeDir(repo, cand);
        if (taken.has(branch) || dirs.has(dir.toLowerCase())) continue;
        // Finish only Loom's pending deletion at this path. Other missing
        // worktrees may be on a temporarily unavailable drive; never prune them.
        await invoke("worktree_prepare", { repo, dir });
        // git itself is the "does the folder exist" check: it refuses a
        // non-empty one, and that is the one error worth trying the next name on.
        // A branch made by someone else meanwhile is the other "already exists":
        // loom/<slug> takes the next number, the new branch you named stops here.
        try {
          await git(repo, "worktree", "add", "-b", branch, dir, ...(base ? [base] : []));
          break;
        } catch (e) {
          if (/a branch named .* already exists/i.test(String(e))) {
            if (fresh) throw new Error(`A branch named ${fresh} appeared while the thread was being made. Use it as the base to continue it, or pick another name.`);
            taken.add(branch);
          } else if (!/already exists/.test(String(e))) throw e;
        }
      }
      // Under a junction (~\loom on another drive), git records the folder's real
      // path, and deletion takes a worktree only at the path git records. Resolved
      // here, right after git made it, never later: by then a parent replaced by
      // a link could lead to another worktree.
      dir = await invoke<string>("canonical_directory", { path: dir }).catch(() => dir);
    } catch (e) {
      const stuck = await release();
      if (!stuck) throw e;
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nLoom also ${stuck}`);
    }
    left = await release();
  } else {
    const have = threads.find((t) => t.dir === dir);
    if (have) {
      show(have);
      return have;
    }
    branch = await headBranch({ repo, dir, branch });
  }
  const th = await openThread({ repo, dir, branch, name: name || basename(repo) }, panes);
  // The thread is made and open: the error says so, and what's left to delete.
  if (left) throw new Error(`Made ${th.name} in ${th.dir}, but Loom ${left}`);
  return th;
}

/** "+ Thread": a native <dialog> — mode, repo, name, base, and how many of
 * each startup to run. The repo list is what threads were cut from so far;
 * "browse…" adds one. */
const dlg = $<HTMLDialogElement>("#new");
const dlgRepo = $<HTMLSelectElement>("#new-repo");
const dlgErr = $("#new-err");
/** The project's HEAD, for the base placeholder and the summary, and its remotes: empty until git answers. */
let dlgHead = { branch: "", sha: "", remotes: [] as string[] };
const isAgent = (s: Startup) => agentOf(s.cmd) !== "shell";
/** The form's order, and the order the panes start in: agents, then terminals. */
const mixOrder = () => [...startups.filter(isAgent), ...startups.filter((s) => !isAgent(s))];
const mixTotal = () => startups.reduce((n, s) => n + (paneMix[s.label] ?? 0), 0);
/** A saved or kept mix as the form uses it: on an object with no prototype, own counts of
 * 1 to MAX_PANES for startups there are now. Anything else counts as none. */
function cleanMix(mix: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const s of startups) {
    const n: unknown = mix && typeof mix === "object" ? Object.getOwnPropertyDescriptor(mix, s.label)?.value : undefined;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_PANES) out[s.label] = n;
  }
  return out;
}

/** `repo` presets the project and switches to worktree mode (the project "+"). */
function newThread(repo?: string) {
  if ($<HTMLButtonElement>("#new-go").disabled) return dlg.showModal();
  hideMenu();
  togglePreferences(false);
  dlgRepo.textContent = "";
  for (const r of repos) dlgRepo.append(new Option(basename(r), r));
  dlgRepo.append(new Option("Choose a folder…", ""));
  if (current) dlgRepo.value = current.repo;
  if (repo) {
    dlgRepo.value = repo;
    $<HTMLInputElement>('input[name="thread-mode"][value="worktree"]').checked = true;
  }
  $<HTMLInputElement>("#new-name").value = "";
  $<HTMLInputElement>("#new-base").value = "";
  // Last time's mix, less startups removed since; nothing left is one of the first.
  paneMix = cleanMix(paneMix);
  if (!mixTotal() && startups[0]) paneMix[startups[0].label] = 1;
  renderMix();
  dlgErr.textContent = "";
  updateThreadMode();
  void readHead();
  dlg.showModal();
  (repos.length && threadMode() === "worktree" ? $("#new-name") : dlgRepo).focus();
}

/** One row per startup: its mark, its label, and − count +. */
function renderMix() {
  const agents = $("#new-agents"), terms = $("#new-terms");
  agents.textContent = terms.textContent = "";
  for (const s of mixOrder()) {
    const row = document.createElement("div");
    row.className = "mix-row";
    row.dataset.label = s.label;
    row.title = s.cmd || "PowerShell";
    const name = document.createElement("span");
    name.className = "mix-name";
    name.textContent = s.label;
    const step = document.createElement("span");
    step.className = "mix-step";
    const button = (by: number, text: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = by < 0 ? "less" : "more";
      b.textContent = text;
      b.setAttribute("aria-label", `${label} ${s.label}`);
      b.onclick = () => {
        paneMix[s.label] = (paneMix[s.label] ?? 0) + by;
        paintNew();
      };
      return b;
    };
    step.append(button(-1, "−", "One less"), document.createElement("output"), button(1, "+", "One more"));
    row.append(icon(agentOf(s.cmd)), name, step);
    (isAgent(s) ? agents : terms).append(row);
  }
  paintNew();
}

/** Everything that follows the fields: counts, the project's path, the base's HEAD, the summary. */
function paintNew() {
  const full = mixTotal() >= MAX_PANES;
  for (const row of dlg.querySelectorAll<HTMLElement>(".mix-row")) {
    const n = paneMix[row.dataset.label!] ?? 0;
    row.classList.toggle("on", n > 0);
    row.querySelector("output")!.textContent = String(n);
    row.querySelector<HTMLButtonElement>(".less")!.disabled = !n;
    row.querySelector<HTMLButtonElement>(".more")!.disabled = full;
  }
  const repo = dlgRepo.value;
  $("#new-repo-name").textContent = dlgRepo.selectedOptions[0]?.text ?? "";
  $("#new-repo-path").textContent = repo;
  const { branch, sha } = dlgHead;
  $<HTMLInputElement>("#new-base").placeholder = !sha ? "HEAD" : branch === "HEAD" ? `HEAD at ${sha}` : `HEAD: ${branch} at ${sha}`;
  const code = (t: string) => Object.assign(document.createElement("code"), { textContent: t });
  const picks = mixOrder().filter((s) => paneMix[s.label]);
  const start = picks.flatMap((s, i) => {
    const n = paneMix[s.label];
    const b = Object.assign(document.createElement("b"), { textContent: n > 1 ? `${n} ${s.label}` : s.label });
    return i ? [i === picks.length - 1 ? " and " : ", ", b] : [b];
  });
  // createThread's own slug: what the branch and folder are called (less a -2 if it's taken).
  const slug = $<HTMLInputElement>("#new-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const typed = $<HTMLInputElement>("#new-base").value.trim();
  const have = threads.find((t) => t.dir === repo); // createThread only shows this one again
  const summary = $("#new-summary");
  if (!repo) summary.replaceChildren("Choose a project folder.");
  else if (!picks.length) summary.replaceChildren("Add an agent or a terminal to start.");
  else if (threadMode() !== "worktree")
    summary.replaceChildren(...(have ? [have.name, " already has ", code(repo), " open. Loom will switch to it and start nothing new."] : ["Loom will open ", code(repo), " as it is, then start ", ...start, " there."]));
  else if (!slug) summary.replaceChildren("Name the thread: the name becomes its branch and its folder.");
  else {
    // Git settles the base and the free name only as the thread is made: the summary gives createThread's rules for them.
    const fallback = !typed ? [] : dlgHead.remotes.includes(typed.split("/")[0])
      ? [" If ", code(typed), " names no commit here or on origin, Loom stops and makes nothing."]
      : [" If ", code(typed), " names no commit here or on origin, the new branch is ", code(typed), " itself, off HEAD."];
    summary.replaceChildren("Loom will create ", code(`loom/${slug}`), " off ", code(typed || (branch && branch !== "HEAD" ? branch : sha || "HEAD")), ", check it out in ",
      code(`~\\loom\\${basename(repo)}\\${slug}`), ", then start ", ...start, " there. A name already in use gets -2, -3… added.", ...fallback);
  }
}

/** The picked project's HEAD branch and commit, for the base field's placeholder. */
async function readHead() {
  const repo = dlgRepo.value;
  dlgHead = { branch: "", sha: "", remotes: [] };
  paintNew();
  if (!repo) return;
  const [branch, sha] = await Promise.all([git(repo, "rev-parse", "--abbrev-ref", "HEAD"), git(repo, "rev-parse", "--short", "HEAD")])
    .then((r) => r.map((s) => s.trim()), () => ["", ""]); // not a repo, or no commit yet: plain HEAD
  const remotes = (await git(repo, "remote").catch(() => "")).split(/\r?\n/).filter(Boolean);
  if (repo !== dlgRepo.value) return; // another project was picked meanwhile
  dlgHead = { branch, sha, remotes };
  paintNew();
}

const threadMode = () => $<HTMLInputElement>('input[name="thread-mode"]:checked').value;
function updateThreadMode() {
  const worktree = threadMode() === "worktree";
  for (const field of ["name", "base"]) {
    $(`#new-${field}-field`).classList.toggle("hidden", !worktree);
    $<HTMLInputElement>(`#new-${field}`).disabled = !worktree;
  }
  $<HTMLInputElement>("#new-name").required = worktree;
  $("#new-go").textContent = worktree ? "Create worktree" : "Open checkout";
  dlgErr.textContent = "";
  paintNew();
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="thread-mode"]')) radio.onchange = updateThreadMode;
$("#new-form").oninput = paintNew;
$("#new-form").onkeydown = (e) => {
  if (e.key !== "Enter" || !e.ctrlKey) return;
  e.preventDefault();
  $<HTMLFormElement>("#new-form").requestSubmit();
};

async function browseRepo() {
  const previous = dlgRepo.value;
  try {
    const dir = await pickFolder({ directory: true, multiple: false });
    if (typeof dir !== "string") return void (dlgRepo.value = previous, paintNew());
    // A folder outside Git can still be opened as a checkout thread.
    const root = (await git(dir, "rev-parse", "--show-toplevel").catch(() => dir)).trim().replace(/\//g, "\\");
    if (!repos.includes(root)) repos.push(root);
    if (![...dlgRepo.options].some((o) => o.value === root))
      dlgRepo.insertBefore(new Option(basename(root), root), dlgRepo.lastElementChild);
    dlgRepo.value = root;
    void readHead();
    (threadMode() === "worktree" ? $("#new-name") : dlgRepo).focus();
  } catch (err) {
    dlgErr.textContent = String(err);
  }
}
dlgRepo.onchange = () => void (dlgRepo.value ? readHead() : browseRepo());
$("#new-browse").onclick = () => void browseRepo();

$("#new-cancel").onclick = $("#new-close").onclick = () => dlg.close();

/** Why the form stopped, scrolled clear of the buttons pinned under a long form on a small screen. */
function newErr(msg: string) {
  dlgErr.textContent = msg;
  dlgErr.scrollIntoView({ block: "nearest" });
}

$<HTMLFormElement>("#new-form").onsubmit = async (e) => {
  e.preventDefault();
  const go = $<HTMLButtonElement>("#new-go");
  if (go.disabled) return; // one creation at a time: Ctrl+Enter from a control still enabled lands here too
  const repo = dlgRepo.value;
  if (!repo) return newErr("pick a repo");
  const worktree = threadMode() === "worktree";
  const name = $<HTMLInputElement>("#new-name").value.trim();
  if (worktree && !name) return newErr("Give this worktree a thread name.");
  const total = mixTotal(); // cleanMix keeps each count to 1..MAX_PANES; the sum is checked here, before any array is made
  if (!total) return newErr("Add an agent or a terminal to start.");
  if (total > MAX_PANES) return newErr(`A thread takes 1 to ${MAX_PANES} panes, not ${total}.`);
  const panes = mixOrder().flatMap((s) => Array<PaneState>(paneMix[s.label] ?? 0).fill({ cmd: s.cmd }));
  go.disabled = true;
  const controls = [...$("#new-form").querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input:not(:disabled), select:not(:disabled), #new-browse, .mix-step button")];
  controls.forEach((el) => (el.disabled = true));
  go.textContent = worktree ? "Creating…" : "Opening…";
  dlgErr.textContent = "creating…"; // a fetch can take a moment
  try {
    await createThread(repo, worktree ? name : "", panes, worktree ? $<HTMLInputElement>("#new-base").value.trim() : "");
    dlg.close();
  } catch (err) {
    newErr(String(err));
  } finally {
    controls.forEach((el) => (el.disabled = false));
    go.disabled = false;
    go.textContent = worktree ? "Create worktree" : "Open checkout";
    paintNew(); // the steppers' own limits again
  }
};

// --- dropdown: one list + "add" input, shared by the startups and the ------
// dictation prefixes. Only the rows and what Enter in the input adds differ.
// A fixed list (themes) leaves `add` out, and the input goes with it.
type Menu = { rows: (list: HTMLElement) => void; placeholder: string; add?: (v: string) => void };

const menu = $("#pane-menu");
const addBtn = $("#add-pane");
const addInput = $<HTMLInputElement>("#menu-add");
let anchor: HTMLElement = addBtn;
let openMenu: Menu;

function renderMenu() {
  const list = $("#menu-list");
  list.textContent = "";
  cfgPaint = null; // only the config panel sets one, and only while it is up
  openMenu.rows(list);
  for (const row of list.querySelectorAll<HTMLElement>(".menu-item")) {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.onkeydown = (e) => {
      if (e.target === row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        row.click();
      }
    };
  }
  addInput.classList.toggle("hidden", !openMenu.add);
  addInput.placeholder = openMenu.placeholder;
  if (!menu.classList.contains("hidden")) place(); // A row was added or removed: a menu that opened upward has to grow upward.
}

/** "+ pane" and "+ Folder": pick a startup command, or extend the list. */
const startupMenu = (pick: (cmd: string) => void): Menu => ({
  placeholder: "add a command…",
  add: (v) => void (startups = uniqueStartups([...startups, typedStartup(v)])),
  rows: (list) => {
    for (const s of startups) {
      const row = document.createElement("div");
      row.className = "menu-item";
      const lbl = document.createElement("span");
      lbl.textContent = s.label;
      lbl.title = s.cmd;
      row.onclick = () => {
        hideMenu();
        pick(s.cmd);
      };
      row.append(
        lbl,
        mini("✕", "Remove from list", () => {
          startups.splice(startups.indexOf(s), 1);
          save();
          renderMenu();
        }),
      );
      list.append(row);
    }
  },
});

/** What dictation types before the transcript, and whether it presses Enter
 * afterwards. `⏎` toggles that per prefix, so "/prompt " can send itself while
 * a bare message waits for you to read it back. */
const prefixMenu: Menu = {
  placeholder: "add a prefix…",
  // Trailing space or the transcript runs into the command name.
  add: (v) => prefixes.push({ text: v.endsWith(" ") ? v : `${v} `, enter: false }),
  rows: (list) => {
    for (const p of prefixes) {
      const row = document.createElement("div");
      row.className = `menu-item${p === prefix ? " on" : ""}`;
      const lbl = document.createElement("span");
      lbl.textContent = p.text || "(no prefix)";
      row.onclick = () => {
        prefix = p;
        hideMenu();
        save();
        paintPrefix();
      };
      const auto = mini("⏎", p.enter ? "Sends itself — click for manual Enter" : "Waits for your Enter — click to auto-send", () => {
        p.enter = !p.enter;
        save();
        renderMenu();
        paintPrefix();
      });
      auto.className = p.enter ? "on" : "";
      row.append(lbl, auto);
      // The last prefix is the fallback — removing it would leave nothing to pick.
      if (prefixes.length > 1)
        row.append(
          mini("✕", "Remove from list", () => {
            prefixes.splice(prefixes.indexOf(p), 1);
            if (prefix === p) prefix = prefixes[0];
            save();
            renderMenu();
            paintPrefix();
          }),
        );
      list.append(row);
    }
  },
};

/** Which language whisper is told to expect. The add input takes a whisper
 * language code, so anything it supports can be added without a rebuild. */
const langMenu: Menu = {
  placeholder: "add a code… (ja, ko, hi)",
  add: (v) => langs.push({ label: v.toLowerCase(), code: v.toLowerCase() }),
  rows: (list) => {
    for (const l of langs) {
      const row = document.createElement("div");
      row.className = `menu-item${l === lang ? " on" : ""}`;
      const lbl = document.createElement("span");
      lbl.textContent = l.label;
      lbl.title = l.code || "detected per clip";
      row.onclick = () => {
        lang = l;
        hideMenu();
        save();
        paintLang();
      };
      row.append(lbl);
      // Keep one: an empty list would leave nothing to dictate in.
      if (langs.length > 1)
        row.append(
          mini("✕", "Remove from list", () => {
            langs.splice(langs.indexOf(l), 1);
            if (lang === l) lang = langs[0];
            save();
            renderMenu();
            paintLang();
          }),
        );
      list.append(row);
    }
  },
};

/** Model and effort for one pane. Both are slash commands in Claude Code, so
 * applying them is just typing into the pane — the conversation carries on and
 * nothing restarts. Staged rather than applied on click, because this changes
 * what every following turn costs. Both are session-scoped: Claude Code does not
 * write them to settings, so they last until the pane's session ends. */
let cfgPane: Pane | null = null;
/** Repaints the open config panel in place. Set while it is on screen, cleared
 * by renderMenu when anything else takes the menu over. `force` also resets a
 * focused select — only a failed apply asks for that. */
let cfgPaint: ((force?: boolean) => void) | null = null;

/** Outcome of a slash command: echoed back, or submitted but not yet echoed —
 * a running turn queues the command and holds the echo until the turn ends.
 * "lost" only ever comes from the pane itself failing (killed mid-apply). */
type Sent = "ok" | "sent" | "lost" | "draft";

/** Submit `cmd` to the pane's claude and watch for its echo.
 *
 * Submission is deliberately blind: paste the whole command as one bracketed
 * unit — the same path dictation uses, atomic where a character stream races
 * the TUI's own input handling — then Enter. Every earlier attempt to VERIFY
 * the input state on screen misfired, because the transcript re-renders past
 * commands (and mid-turn queues them) in shapes indistinguishable from the
 * live input line; meanwhile the submission itself never failed once. So
 * nothing is retyped, ever — a "retry" of a command that did land runs it
 * twice — and the echo in the bottom rows is the one signal trusted: quick
 * when claude is idle, held until the turn ends when one is running (report
 * "sent" rather than stall the queue — and give up much sooner when another
 * pick is already waiting behind this one). */
async function slash(p: Pane, cmd: string, confirmed: () => boolean): Promise<Sent> {
  // The pane's input turn: a loomctl send waiting on its echo would otherwise go with this Enter.
  const typed = await inTurn(p, async (live) => {
    // Loom never types over a draft: the command would go on its end, and Enter send both.
    if (inputState(p).kind === "draft") return false;
    p.term.paste(cmd);
    await p.settle(150, 1000); // let the input take it before the Enter
    live(true);
    p.inputSeq++;
    await invoke("pty_write", { id: p.id, data: "\r" });
    return true;
  });
  if (!typed) return "draft";
  for (const t0 = Date.now(); ; ) {
    if (confirmed()) return "ok";
    if (Date.now() - t0 >= (cfgQueued ? 1000 : 8000)) return "sent";
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** One at a time, so there is never a second command to sequence behind the
 * first. Picking from a list runs straight into this; the chain keeps two quick
 * picks from overlapping, the same way the mic's does. `cfgQueued` counts picks
 * waiting behind the running one — slash() shortens its echo watch when someone
 * is, so a burst of picks doesn't serialize behind 8-second waits. */
let cfgChain: Promise<void> = Promise.resolve();
let cfgQueued = 0;
const queueCfg = (step: () => Promise<void>) => {
  cfgQueued++;
  const run = () => (cfgQueued--, step());
  cfgChain = cfgChain.then(run, run);
};

/** Status line under the selects: what is being applied, or why it wasn't. */
let cfgNote = "";
/** Resolves a lingering "sent" note: true once the pane's transcript shows the
 * value landed. Checked on every panel repaint (the usage poll drives those). */
let cfgDone: (() => boolean) | null = null;
/** While a config command is being typed into a pane the mic stays shut — a
 * dictation prefix pasted into the middle of "/model …" mangles both. */
let cfgBusy = false;

async function applyOne(p: Pane, kind: "model" | "effort", value: string) {
  cfgDone = null; // a new verdict is coming; the old one must not clear it
  // Dictation owns the pane's input while the mic is open, and the transcript
  // lands only after stop — typing "/model …" into either would submit a
  // half-dictated prompt. A live recording: say so and put the select back; a
  // stop still transcribing: wait it out (micStop never waits on this chain,
  // so there is no cycle to deadlock).
  if (recording?.pane === p) {
    cfgNote = "finish dictating first";
    return void cfgPaint?.(true);
  }
  await micChain.catch(() => {});
  // Same test dictation uses: claude booted this pane and still owns the alt
  // screen. At a PowerShell prompt "/model x" would just run and error.
  if (!p.claudeUp) {
    cfgNote = "claude isn't running in this pane";
    return void cfgPaint?.(true);
  }
  cfgNote = `applying /${kind} ${value}…`;
  cfgPaint?.();
  cfgBusy = true;
  // Confirmed by either signal: the command's echo anywhere on the (joined)
  // screen, or — stronger — the pane's own status bar showing the new value:
  // Claude Code redraws it with the current model and effort, so it is state,
  // not a one-shot line to race. The liveness check guards the screen read on
  // a pane closed mid-apply.
  const proof = proofFor(kind, value);
  const status = statusFor(kind, value);
  const confirmed = () =>
    p.th.panes.includes(p) &&
    (proof.test(flat(p.screen())) || (status?.test(foot(p.screen())) ?? false));
  const got = await slash(p, `/${kind} ${value}`, confirmed).catch(() => "lost" as Sent);
  cfgBusy = false;
  if (got === "lost") {
    // Only a pane failure lands here — the write itself threw.
    cfgNote = `couldn't write to the pane — is it still open?`;
  } else if (got === "draft") {
    cfgNote = "its input holds a draft: send or clear it first";
  } else {
    // In claude's hands either way — "sent" means a running turn holds it in
    // the queue and it lands when the turn ends, so both count as applied.
    if (kind === "effort") {
      // Remember the level so a restored pane boots back into it — launch()
      // re-pins effort on resume. "auto" means "whatever the model defaults
      // to", so it clears the pin rather than leaving the old level to be
      // re-applied on the next launch.
      p.effort = value === "auto" ? "" : value;
      save();
    }
    // The transcript only records these when a turn runs, so until then it
    // still describes the previous setting — show what was applied meanwhile.
    // For "sent" the running turn keeps writing records under the OLD setting,
    // so the stamp also holds until the transcript moves off what it says now
    // (`was`) — a record count alone would expire it mid-queue.
    const t = p.usage;
    p.want = {
      ...p.want,
      [kind]: {
        v: value,
        at: t?.mainTurns ?? 0,
        ...(got === "sent" && { was: (kind === "model" ? t?.model : t?.effort) ?? "" }),
      },
    };
    if (got === "ok") cfgNote = "";
    else {
      cfgNote = `/${kind} ${value} sent — waiting for claude to confirm`;
      // Either on-screen signal turning up after the watch gave up, or the
      // statusline tee / transcript reporting the value (both carry the bare
      // id where the option carries "[1m]").
      cfgDone = () => {
        const u = p.usage;
        return (
          confirmed() ||
          (kind === "model"
            ? [u?.liveModel, u?.model].some((m) => !!m && value.startsWith(m))
            : [u?.liveEffort, u?.effort].includes(value))
        );
      };
    }
  }
  // The panel stays open, so redraw it — forced on a loss, or the select that
  // was just picked (still focused) would keep claiming a value the pane never
  // took.
  if (!menu.classList.contains("hidden")) cfgPaint?.(got === "lost" || got === "draft");
}

const configMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const p = cfgPane;
    if (!p) return;
    /** What the pane is on. Normally the transcript, so it follows a /model
     * typed straight into the pane too — but a setting applied since the last
     * turn isn't recorded there yet, and until a real turn overtakes it what we
     * asked for is the truth. Recomputed on every repaint, not captured. */
    const now = () => {
      const t = p.usage;
      const ran = t?.mainTurns ?? 0;
      const held = (s: Set_ | undefined, cur: string) =>
        s && (ran <= s.at || (s.was !== undefined && cur === s.was)) ? s.v : "";
      // Recent pick > statusline tee (live truth, follows hand-typed /model
      // too) > transcript (last turn) > the hook-reported boot effort.
      return {
        model: held(p.want?.model, t?.model ?? "") || t?.liveModel || t?.model || "",
        effort: held(p.want?.effort, t?.effort ?? "") || t?.liveEffort || t?.effort || p.effort || "",
      };
    };
    const note = document.createElement("div");
    note.className = "menu-note";
    list.append(note);
    const selects: { kind: "model" | "effort"; el: HTMLSelectElement }[] = [];

    /** ponytail: a native <select>. It gets keyboard, type-ahead and scrolling
     * for free, and the OS draws the popup — nothing to size or clamp. */
    const pick = (
      kind: "model" | "effort",
      opts: { value: string; label: string; detail: string }[],
      current: string,
    ) => {
      const row = document.createElement("label");
      row.className = "cfg-row";
      const name = document.createElement("span");
      name.textContent = kind;
      const sel = document.createElement("select");
      for (const o of opts) {
        const op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.detail ? `${o.label} · ${o.detail}` : o.label;
        sel.append(op);
      }
      // Open on what the pane is already using. The transcript reports a bare id
      // where the option carries the [1m] suffix, so a prefix match is what
      // recognises it.
      const at =
        opts.find((o) => o.value === current) ??
        (current ? opts.find((o) => o.value.startsWith(current)) : undefined);
      if (at) sel.value = at.value;
      else if (current) {
        // Running something the list doesn't offer — an older version, or a
        // model picked by hand. Say so rather than showing the first row and
        // claiming the pane is on that.
        const own = document.createElement("option");
        own.value = current;
        own.textContent = `${current} (current)`;
        sel.prepend(own);
        sel.value = current;
      }
      // Picking is the whole gesture — no button to press afterwards.
      sel.onchange = () => {
        const v = sel.value; // the panel redraws, so read it now
        queueCfg(() => applyOne(p, kind, v));
      };
      row.append(name, sel);
      list.append(row);
      selects.push({ kind, el: sel });
    };

    const open = now();
    pick("model", modelRows(), open.model);
    pick(
      "effort",
      EFFORTS.map((v) => ({ value: v, label: v, detail: "" })),
      open.effort,
    );

    // Keep the open panel true to the pane: the usage poll calls this, so a turn
    // finishing while you are looking at it moves the panel. In place rather
    // than a rebuild, which would shut a dropdown mid-choice — and a control the
    // pointer or keyboard is on is left alone for the same reason. `force` is
    // the exception: a failed apply must snap the picked (still-focused) select
    // back to what the pane really runs.
    cfgPaint = (force = false) => {
      if (cfgDone?.()) {
        cfgNote = ""; // the sent change landed; the transcript confirms it
        cfgDone = null;
      }
      const v = now();
      note.textContent =
        `now: ${v.model || "—"} · ${v.effort || "—"}` + (cfgNote ? ` — ${cfgNote}` : "");
      for (const s of selects) {
        const want = s.kind === "model" ? v.model : v.effort;
        if (!want || (!force && document.activeElement === s.el)) continue;
        const at = [...s.el.options].find((o) => o.value === want || o.value.startsWith(want));
        if (at) s.el.value = at.value;
      }
    };
    cfgPaint();
  },
};

/** Every claude session Loom is running and what it has spent, opened from any
 * pane's context gauge — the plan chip answers "how much is left", this answers
 * "which pane is spending it". Rows are live panes, so clicking one goes there. */
const usageMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const note = (text: string) => {
      const d = document.createElement("div");
      d.className = "menu-note";
      d.textContent = text;
      list.append(d);
    };
    if (profilePane) profileRows(list, note);
    const live = threads.flatMap((t) => t.panes).filter((p) => p.usage);
    if (!live.length) return note("no claude session running");

    note("context · tokens out");
    for (const p of live) {
      const u = p.usage!;
      const d = document.createElement("div");
      d.className = `menu-item${p === current?.active ? " on" : ""}`;
      const lbl = document.createElement("span");
      lbl.textContent = `${p.th.name} · ${String(p.th.panes.indexOf(p) + 1).padStart(2, "0")}`;
      const val = document.createElement("b");
      val.className = "usage-n";
      val.textContent = `${tok(u.ctx)} · ${tok(u.output)}`;
      d.title =
        `${p.th.dir}\n${u.turns} turns · ${tok(u.output)} out · ` +
        `${tok(u.input + u.cacheWrite)} in · ${tok(u.cacheRead)} cached`;
      d.onclick = () => {
        hideMenu();
        revealPane(p);
      };
      d.append(lbl, val);
      list.append(d);
    }
    // Totals span each session's whole history, not just this run of Loom —
    // they're read from the transcript, which resuming appends to.
    const sum = (f: (u: Usage) => number) => live.reduce((s, p) => s + f(p.usage!), 0);
    note(
      `${live.length} session${live.length > 1 ? "s" : ""} · ${tok(sum((u) => u.output))} out · ` +
        `${tok(sum((u) => u.input + u.cacheWrite))} in · ${tok(sum((u) => u.cacheRead))} cached`,
    );
  },
};

/** Read one pane's transcript and repaint the panel when it lands. Every line of
 * the file gets parsed, so this is asked for when the panel opens and never from
 * a poll — the 4s one reads only what was appended and has to stay that cheap. */
async function loadProfile(p: Pane) {
  // Reopening the same pane keeps its last answer on screen while the fresh one
  // is read — a big transcript takes long enough for the placeholder to blink.
  if (profilePane !== p) profile = null;
  profilePane = p;
  renderMenu(); // the section says it's reading while it reads
  place();
  const got = await invoke<Profile | null>("context_profile", {
    pane: claudeMarker(p),
    dir: p.th.dir,
    sid: p.sid,
  }).catch(() => null);
  // A big transcript takes a moment, and the panel may have been closed or
  // opened on another pane in the meantime.
  if (profilePane !== p || openMenu !== usageMenu || menu.classList.contains("hidden")) return;
  profile = got;
  renderMenu();
  place(); // the section just grew — keep the panel on screen
}

/** Four hues off the theme's own variables, so a palette swap carries. Past the
 * fourth they repeat at half strength, which is enough to tell neighbouring
 * slices apart without inventing colours the theme doesn't have. */
const HUES = ["var(--accent)", "var(--warn)", "var(--ok)", "var(--muted)"];

/** The profile section: what this pane's window has done over time, and what has
 * been poured into it. Sits above the session list, for the pane whose gauge
 * opened the panel. */
function profileRows(list: HTMLElement, note: (text: string) => void) {
  const p = profilePane!;
  const seat = String(p.th.panes.indexOf(p) + 1).padStart(2, "0");
  note(`${p.th.name} · ${seat}`);
  if (!profile) return note("reading the transcript…");
  const { series, drops, buckets, est } = profile;
  if (!series.length) return note("no turns yet");

  // --- the window over time. Exact: every point is what a turn really sent.
  const [W, H] = [268, 34];
  const top = Math.max(...series, 1); // never divide by a session that sent nothing
  const x = (i: number) => (series.length < 2 ? W : (i / (series.length - 1)) * W);
  const y = (v: number) => H - 1 - (v / top) * (H - 2);
  const spark = document.createElement("div");
  spark.className = "spark";
  // Numbers only, so there is nothing here to escape.
  spark.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    drops
      .map((d) => `<line x1="${x(d.turn)}" x2="${x(d.turn)}" y1="0" y2="${H}"/>`)
      .join("") +
    `<polyline points="${series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/></svg>`;
  spark.title =
    `${series.length} turns · peak ${tok(top)} · now ${tok(series[series.length - 1])}` +
    drops.map((d) => `\n${d.trigger} compaction: ${tok(d.pre)} → ${tok(d.post)}`).join("");
  list.append(spark);
  // The one thing here that is measured rather than estimated, so it gets said
  // in numbers: a compaction is the context being thrown away on your behalf.
  const lost = drops.reduce((n, d) => n + Math.max(0, d.pre - d.post), 0);
  note(
    drops.length
      ? `peak ${tok(top)} · ${drops.length} compaction${drops.length > 1 ? "s" : ""}, ${tok(lost)} evicted`
      : `peak ${tok(top)} · never compacted`,
  );

  // --- what produced it. An estimate, and of a different quantity than the
  // gauge — see the Bucket doc in usage.rs.
  if (!est) return;
  const shown = buckets.slice(0, 8);
  const rest = buckets.slice(8).reduce((n, b) => n + b.tokens, 0);
  if (rest) shown.push({ label: `${buckets.length - 8} more`, tokens: rest });
  const paint = (el: HTMLElement, i: number) => {
    el.style.background = HUES[i % HUES.length];
    el.style.opacity = i >= HUES.length ? "0.5" : "1";
  };
  const bar = document.createElement("div");
  bar.className = "stack";
  shown.forEach((b, i) => {
    const seg = document.createElement("i");
    seg.style.width = `${(b.tokens / est) * 100}%`;
    paint(seg, i);
    bar.append(seg);
  });
  list.append(bar);
  for (const [i, b] of shown.entries()) {
    const row = document.createElement("div");
    row.className = "leg";
    const dot = document.createElement("i");
    paint(dot, i);
    const lbl = document.createElement("span");
    lbl.textContent = b.label;
    const n = document.createElement("b");
    n.textContent = `${tok(b.tokens)} · ${Math.round((b.tokens / est) * 100)}%`;
    row.append(dot, lbl, n);
    list.append(row);
  }
  // The caveat matters — these are not the gauge's tokens — but six lines of it
  // buries the panel. One line, and the whole story on hover.
  note(`${tok(est)} produced · estimated · not the live window`);
  (list.lastElementChild as HTMLElement).title =
    "What each origin generated over the whole session, at 4 chars a token.\n" +
    "Not a breakdown of the context right now: Claude Code prunes the request " +
    "it sends and the transcript never records what it cut.";
}

/** The plan panel: the 5-hour session window and the weekly limits, drawn the
 * way Claude Code's /usage shows them. Read-only, so no add input. */
const makePlanMenu = (provider: PlanProvider): Menu => ({
  placeholder: "",
  rows: (list) => {
    const plan = plans[provider];
    const planErr = planErrors[provider];
    const info = PLAN_PROVIDERS[provider];
    const note = (text: string) => {
      const d = document.createElement("div");
      d.className = "menu-note";
      d.textContent = text;
      list.append(d);
    };
    const heading = document.createElement("div");
    heading.className = "plan-heading";
    // A clock time, not "3 min ago": the open panel doesn't repaint on its own.
    const when = document.createElement("small");
    when.className = "plan-updated";
    const at = planFetchedAt[provider];
    if (planPolls[provider]) when.textContent = "Refreshing…";
    else if (at) {
      const d = new Date(at);
      const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      when.textContent = `Updated ${d.toDateString() === new Date().toDateString() ? "" : d.toLocaleDateString("en-US", { weekday: "short" }) + " "}${time}`;
      when.title = d.toLocaleString();
    }
    heading.append(icon(provider), `${info.name}${plan?.tier ? ` · ${TIERS[plan.tier] ?? plan.tier}` : ""}`, when);
    list.append(heading);
    const site = document.createElement("a");
    site.className = "plan-site";
    site.textContent = `Open ${info.name} usage page ↗`;
    site.href = info.url;
    site.onclick = (e) => { e.preventDefault(); void openUrl(info.url).catch(e => toast(String(e))); };
    // After the link, so showMenu still focuses the link first.
    const busy = !!planPolls[provider];
    const refresh = mini(glyph("refresh"), busy ? `Refreshing ${info.name} usage…` : `Refresh ${info.name} usage now`, () => {
      const focused = document.activeElement === refresh; // a mouse click leaves focus where it was
      void pollPlan(provider, true).then(() => {
        if (focused && openMenu === planMenus[provider]) $("#menu-list .plan-refresh")?.focus();
      });
      renderMenu();
    });
    refresh.classList.add("plan-refresh");
    refresh.disabled = busy;
    const links = document.createElement("div");
    links.className = "plan-links";
    links.append(site, refresh);
    list.append(links);
    if (!plan?.limits.length) return note(planErr || "Fetching plan usage…");

    let group = "";
    for (const l of plan.limits) {
      // The weekly limits are a block of their own, exactly one heading deep.
      if (l.group !== group && l.group === "weekly") note("WEEKLY LIMITS");
      group = l.group;
      const d = document.createElement("div");
      d.className = `limit sev-${l.severity}`;
      const top = document.createElement("div");
      top.className = "limit-top";
      const lbl = document.createElement("span");
      lbl.textContent = KIND_LABELS[l.label] ?? l.label;
      const pct = document.createElement("b");
      pct.textContent = `${Math.round(l.percent)}% used`;
      top.append(lbl, pct);
      const bar = document.createElement("i");
      bar.className = "limit-bar";
      bar.style.setProperty("--pct", `${l.percent}%`);
      const sub = document.createElement("small");
      sub.textContent = fmtReset(l.resetsAt) || (l.percent === 0 ? "unused so far" : "");
      d.append(top, bar, sub);
      list.append(d);
    }
    // A failed refresh keeps the last good numbers on screen and says so, rather
    // than blanking the panel — this endpoint rate-limits.
    if (planErr) note(planErr);
    else if (plan.note) note(plan.note);
    else if (plan.stale) note("Live refresh unavailable; showing local usage.");
    if (plan.bankedResets !== undefined) {
      note(`Banked resets: ${plan.bankedResets}`);
      if (plan.bankedResets > 0) {
        for (const expiry of plan.bankedResetExpiries?.length ? plan.bankedResetExpiries : [null]) {
          const at = resetMs(expiry);
          note(at ? `Expires ${new Date(at).toLocaleString()}` : "Expiry unavailable");
        }
      }
    }
  },
});
const planMenus = { claude: makePlanMenu("claude"), codex: makePlanMenu("codex"), both: { placeholder: "", rows: () => {} } as Menu };
/** The rail's Usage button: both accounts, one under the other. */
planMenus.both.rows = (list) => {
  if (!planUsage) return void list.append(Object.assign(document.createElement("div"), { className: "menu-note", textContent: "Plan usage is off. Turn it on in Preferences." }));
  planMenus.claude.rows(list);
  planMenus.codex.rows(list);
};

/** The palette. Built in, so no add input — every row is one of THEMES, dark ones then light. */
const themeMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    for (const scheme of ["dark", "light"]) {
      list.append(Object.assign(document.createElement("div"), { className: "menu-note menu-head", textContent: scheme === "dark" ? "Dark" : "Light" }));
      for (const t of THEMES.filter((x) => (x.scheme ?? "dark") === scheme)) {
        const row = document.createElement("div");
        row.className = `menu-item theme-card${t === theme ? " on" : ""}`;
        row.setAttribute("aria-label", `${t.label}, ${scheme} theme`);
        row.setAttribute("aria-pressed", String(t === theme));
        const lbl = document.createElement("span");
        lbl.className = "theme-caption";
        lbl.textContent = t.label;
        const preview = document.createElement("b");
        preview.className = "theme-preview";
        preview.setAttribute("aria-hidden", "true");
        for (const [k, v] of Object.entries({ ...BASE, ...t.vars })) preview.style.setProperty(k, v);
        preview.append(document.createElement("i"), document.createElement("i"));
        row.onclick = () => {
          applyTheme(t);
          hideMenu();
          save();
          paintTheme();
          anchor.focus();
        };
        row.append(preview, lbl);
        list.append(row);
      }
    }
  },
};

/** The top-bar chip: the 5-hour session window, which is the one that moves while
 * you work. The weeklies are a click away. Hidden until the first fetch answers. */
function paintPlan(provider: PlanProvider) {
  const info = PLAN_PROVIDERS[provider];
  const plan = plans[provider];
  const b = $(`#${info.button}`);
  if (!planUsage) return void (b.className = "hidden");
  const s = provider === "codex"
    ? plan?.limits.slice().sort((a, b) => b.percent - a.percent)[0]
    : plan?.limits.find((l) => l.group === "session") ?? plan?.limits[0];
  b.className = `plan-chip sev-${s?.severity ?? "ok"}`;
  // Hovering repaints for a fresh countdown in the tooltip; rebuilding the
  // chip then would swap the icon out from under the pointer mid-click.
  const text = s ? `${Math.round(s.percent)}%` : "—";
  if (b.dataset.text !== text || !b.firstChild) {
    b.dataset.text = text;
    const bar = Object.assign(document.createElement("span"), { className: "plan-bar" });
    bar.style.setProperty("--pct", `${Math.min(100, Math.round(s?.percent ?? 0))}%`);
    b.replaceChildren(icon(provider), Object.assign(document.createElement("span"), { className: "plan-name", textContent: info.name }), bar,
      Object.assign(document.createElement("span"), { className: "plan-pct", textContent: text }));
  }
  b.setAttribute("aria-label", `${info.name} usage${s ? `, ${Math.round(s.percent)}% used` : " unavailable"}`);
  if (!s) { b.title = `${info.name}: ${planErrors[provider] || "Fetching usage…"}`; return; }
  b.title =
    `${info.name} · ${TIERS[plan!.tier] ?? plan!.tier}${plan!.tier ? " — " : ""}` +
    `${KIND_LABELS[s.label] ?? s.label} ${Math.round(s.percent)}% used\n` +
    `${fmtReset(s.resetsAt)}\nClick for the weekly limits too`;
}

/** Poll: the endpoint rate-limits hard and these numbers move slowly, so five
 * minutes is as often as it's worth asking, plus the panel's refresh button.
 * A failure keeps the last good numbers and shows why underneath them. One
 * request per provider at a time: a click during a poll waits for that one. */
function resetIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  let at: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) at = Number(text) * 1000;
  else {
    const date = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(text);
    if (!date) return null;
    const [, y, m, d] = date.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    at = Date.parse(text);
  }
  return Number.isFinite(at) && at > 0 && at <= 253402300799999 ? new Date(at).toISOString() : null;
}
function normalizePlan(plan: Plan): Plan {
  return { ...plan, limits: plan.limits.map((l) => ({ ...l, resetsAt: resetIso(l.resetsAt) })),
    ...(plan.bankedResetExpiries ? { bankedResetExpiries: plan.bankedResetExpiries.map(resetIso) } : {}) };
}

type AccountReading = (Plan | { error: string; stale: true }) & { fetchedAt: string | null; nextRefreshAt: string; cached: boolean };
const accountPolls: Partial<Record<PlanProvider, Promise<AccountReading>>> = {};
const accountCache: Partial<Record<PlanProvider, AccountReading>> = {};
/** When a rate limit's cooldown ends: a refresh button waits it out, but not the five-minute floor. */
const accountHolds: Partial<Record<PlanProvider, number>> = {};
function accountPlan(provider: PlanProvider, force = false): Promise<AccountReading> {
  if (accountPolls[provider]) return accountPolls[provider]!;
  const previous = accountCache[provider];
  const asked = Date.now();
  // A provider's cooldown holds every caller, to the ms. Only the 5-minute
  // floor, which --refresh skips, gets a few seconds' slack: the poll's next
  // tick lands that close to it, and without it every other tick got the cache.
  const held = (accountHolds[provider] ?? 0) > asked;
  const floored = !force && Date.parse(previous?.nextRefreshAt ?? "") - 10_000 > asked;
  if (previous && (held || floored)) return Promise.resolve({ ...previous, cached: true });
  return accountPolls[provider] = (async () => {
    // limit: the provider's own cooldown in seconds, 0 for none; the cache floor is 300 either way.
    let limit = 0, result: Plan | { error: string; stale: true }, fetchedAt = previous?.fetchedAt ?? null;
    try {
      result = normalizePlan(await invoke<Plan>(PLAN_PROVIDERS[provider].command));
      limit = result.retryAfterSeconds ?? 0;
      fetchedAt = new Date().toISOString();
    } catch (e) {
      const error = String(e);
      limit = Number(/retry after (\d+) seconds/.exec(error)?.[1] ?? 0);
      result = { ...(previous && "limits" in previous ? previous : {}), error, stale: true };
    }
    // The cooldown runs from the provider's answer; the floor from the ask.
    const hold = limit > 0 ? Date.now() + Math.min(limit, 86400) * 1000 : 0;
    const next = Math.max(asked + Math.min(Math.max(300, limit), 86400) * 1000, hold);
    const reading = { ...result, fetchedAt, nextRefreshAt: new Date(next).toISOString(), cached: false };
    accountCache[provider] = reading;
    accountHolds[provider] = hold;
    return reading;
  })().finally(() => { delete accountPolls[provider]; });
}

const planPolls: Partial<Record<PlanProvider, Promise<void>>> = {};
function pollPlan(provider: PlanProvider, force = false): Promise<void> {
  return planPolls[provider] ??= fetchPlan(provider, force).finally(() => {
    delete planPolls[provider];
    paintPlan(provider);
    if (!menu.classList.contains("hidden") && (openMenu === planMenus[provider] || openMenu === planMenus.both)) renderMenu();
  });
}

async function fetchPlan(provider: PlanProvider, force = false) {
  if (!planUsage) return;
  const plan = plans[provider];
  try {
    const got = await accountPlan(provider, force);
    if (!("limits" in got)) throw new Error(got.error);
    // A row whose reset time has passed describes a window that rolled over —
    // its usage is back at zero, whatever the stale payload last said. This is
    // how a pane idle since 1 AM used to read "47% used, Resetting now" all
    // evening. Zeroed rather than dropped: at launch the newest payload on disk
    // is the previous run's, and dropping its dead session row left the chip
    // showing the weekly number until the next poll, five minutes later.
    const rolled = (l: Limit): Limit => {
      const at = resetMs(l.resetsAt);
      return !at || at > Date.now()
        ? l
        : { ...l, percent: 0, severity: "ok", resetsAt: null };
    };
    // The statusline fallback knows the session window and the weekly total,
    // never the per-model limits — so its rows win by label and the rest of the
    // last good answer stands, rather than dropping "Fable" off the panel every
    // time the endpoint says 429. Session first, so the chip and the panel's
    // WEEKLY LIMITS heading keep their order whichever source a row came from.
    const kept = (provider === "claude" && got.stale && plan ? plan.limits : []).filter(
      (l) => !got.limits.some((g) => g.label === l.label),
    );
    plans[provider] = {
      ...got,
      tier: got.tier || plan?.tier || "",
      limits: [...got.limits, ...kept].map(rolled).sort(
        (a, b) => Number(b.group === "session") - Number(a.group === "session"),
      ),
    };
    planErrors[provider] = "error" in got ? String(got.error) : "";
    // When the numbers were read, not when this asked: a cached or held reading is older.
    planFetchedAt[provider] = Date.parse(got.fetchedAt ?? "") || Date.now();
  } catch (e) {
    planErrors[provider] = String(e);
  }
}

function paintTheme() {
  const b = $("#theme");
  b.textContent = theme.label;
  b.title = `Colour theme: ${theme.label} — click to change`;
}

function paintPlanUsage() {
  const b = $("#plan-usage");
  b.textContent = planUsage ? "shown" : "off";
  b.title = planUsage
    ? "Claude and Codex plan usage in the sidebar — click to hide it and stop asking the accounts"
    : "Plan usage is off: no usage rows, no calls to the usage endpoints — click to show it";
  b.setAttribute("aria-pressed", String(planUsage));
}

function paintNotifications() {
  for (const [id, enabled] of [["#notification-sound", soundEnabled], ["#notification-taskbar", taskbarEnabled], ["#notices", notifyPolicy.on],
    ["#notice-finish", notifyPolicy.kinds.finish], ["#notice-fail", notifyPolicy.kinds.fail], ["#notice-blocked", notifyPolicy.kinds.blocked]] as const) {
    const b = $(id);
    if (!b.dataset.kind) b.textContent = enabled ? "on" : "off";
    b.setAttribute("aria-pressed", String(enabled));
  }
  $("#notice-new").textContent = notifyPolicy.newPanes === "inherit" ? "like every pane" : notifyPolicy.newPanes;
  for (const p of threads.flatMap((t) => t.panes)) p.paintBell();
}

async function setKeepAwake(enabled: boolean) {
  const button = $<HTMLButtonElement>("#keep-awake");
  button.disabled = true;
  try {
    await invoke("set_keep_awake", { enabled });
    keepAwake = enabled;
    void save();
  } catch (e) {
    toast(`Could not change keep-awake: ${String(e)}`);
  } finally {
    button.textContent = keepAwake ? "on" : "off";
    button.setAttribute("aria-pressed", String(keepAwake));
    button.disabled = false;
  }
}

/** `loomctl dictation`: both of the mic menu's lists, each with its pick marked. */
function dictationData() {
  return {
    data: { langs: langs.map((l) => ({ ...l, on: l === lang })), prefixes: prefixes.map((p) => ({ ...p, on: p === prefix })) },
    text: table([
      ...langs.map((l) => [l === lang ? "*" : " ", "language", l.label, l.code || "detected per clip"]),
      ...prefixes.map((p) => [p === prefix ? "*" : " ", "prefix", p.text.trim() || "(no prefix)", p.enter ? "sent the moment it lands" : "waits for your Enter"]),
    ]),
  };
}

/** The mic's arrow names what the next dictation will use: a hover tells it. */
function paintSpeakMore() {
  const b = $("#speak-more");
  b.title = `${lang.code ? `Transcribed as ${lang.label}` : "Language detected per clip"} · ${prefix.text.trim() ? `prefix ${prefix.text.trim()}` : "no prefix"}${prefix.enter ? ", sent the moment it lands" : ", waits for your Enter"} — click to change`;
  b.setAttribute("aria-label", `Dictation settings: ${lang.label}, ${prefix.text.trim() || "no prefix"}`);
  // The status bar says the same, a click from either list.
  setText($("#sb-lang"), lang.code ? lang.label : "Auto language");
  $("#sb-lang").title = `${lang.code ? `Dictation is transcribed as ${lang.label}` : "Dictation detects the language per clip"}: click to change`;
  setText($("#sb-prefix"), prefix.text.trim() || "No prefix");
  $("#sb-prefix").title = `${prefix.text.trim() ? `Dictation starts with ${prefix.text.trim()}` : "Dictation types no prefix"}${prefix.enter ? " and is sent the moment it lands" : " and waits for your Enter"}: click to change`;
  fitStatus();
}
// Declarations, not consts: both run from menus wired before this line.
function paintLang() {
  paintSpeakMore();
}
function paintPrefix() {
  paintSpeakMore();
}

/** The floating mic: over the panes while a thread is up, unless hidden in Preferences. */
function paintSpeak() {
  $("#speak").classList.toggle("hidden", !current || dashboardOpen || !speakShown);
  const b = $("#speak-pref");
  b.textContent = speakShown ? "shown" : "hidden";
  b.setAttribute("aria-pressed", String(speakShown));
}

// --- status bar: the panes' servers, the phone remote, this PC ---------------
type StatusReading = {
  cpu: number;
  memory: { used: number; total: number };
  remote: { port: number; listening: boolean; error: string | null } | null;
  servers: { port: number; pane: string; name: string }[];
};
type Server = { port: number; pane: Pane; name: string };
// A declaration: paintSpeakMore, above, uses it. The same text again would still relayout the bar.
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
let statusReading: StatusReading | undefined;
let statusServers: Server[] = [];
let statusSig = "";
let statusBusy = false;
/** Phones show one server and a count; the menu behind the count lists them all. */
const statusNarrow = matchMedia("(max-width: 480px)");

/** status_bar's reading (lib.rs), every 3 s while Loom is in view. */
async function pollStatus() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    statusReading = await invoke<StatusReading>("status_bar");
    paintStatus();
  } catch {
    // The bar keeps its last reading.
  } finally {
    statusBusy = false;
  }
}

const serverName = (s: Server) => s.name || "port";
// The thread, not the pane's title: a shell's is its exe's whole path and the command.
const serverTitle = (s: Server) => `${serverName(s)} listens on port ${s.port}, in a pane of ${s.pane.th.name}. Click to show that pane.`;
const statusSpan = (className: string, text: string) => Object.assign(document.createElement("span"), { className, textContent: text });

/** The bar's parts a window too narrow for them all goes without, least needed
 * first: each is also elsewhere (Preferences, the task manager, the mic's menu). */
const STATUS_DROPS = ["#sb-version", "#sb-mem-of", ".sb-dictate", "#sb-prefix", "#sb-lang", "#sb-remote"];
/** Every part back, then drop them in order while the bar overflows. A declaration: paintSpeakMore, above, calls it. */
function fitStatus() {
  const bar = $("#statusbar");
  const parts = STATUS_DROPS.map((s) => bar.querySelector(s)!);
  bar.classList.remove("sb-squeeze");
  for (const p of parts) p.classList.remove("sb-dropped");
  for (const p of parts) {
    if (bar.scrollWidth <= bar.clientWidth) break;
    p.classList.add("sb-dropped");
  }
  // Every part gone and still too wide (long names on a phone): the server names give way, down to their ports.
  bar.classList.toggle("sb-squeeze", bar.scrollWidth > bar.clientWidth);
}

function paintStatus() {
  const r = statusReading;
  if (!r?.memory) return;
  const GB = 2 ** 30;
  setText($("#sb-cpu"), `CPU ${Math.round(r.cpu)}%`);
  setText($("#sb-mem"), `Memory ${Math.round((r.memory.used / r.memory.total) * 100)}%`);
  setText($("#sb-mem-of"), `(${(r.memory.used / GB).toFixed(1)} of ${(r.memory.total / GB).toFixed(1)} GB)`);
  const remote = $("#sb-remote");
  remote.classList.toggle("hidden", !r.remote);
  if (r.remote) {
    remote.classList.toggle("off", !r.remote.listening);
    setText(remote.querySelector<HTMLElement>(".num")!, `:${r.remote.port}`);
    remote.title = r.remote.listening ? `The phone remote serves on port ${r.remote.port}` : `The phone remote is on but not serving${r.remote.error ? `: ${r.remote.error}` : ""}`;
  }
  // A server whose pane the page doesn't have (closing as this was read) isn't shown.
  const panes = new Map(threads.flatMap((t) => t.panes).map((p) => [p.id, p]));
  statusServers = r.servers.flatMap((s) => {
    const pane = panes.get(s.pane);
    return pane ? [{ ...s, pane }] : [];
  });
  const shown = statusNarrow.matches ? 1 : 2;
  const sig = `${shown} ${statusServers.map((s) => `${s.pane.id} ${serverTitle(s)}`).join("|")}`;
  if (sig !== statusSig) {
    statusSig = sig;
    paintServers(shown);
  }
  fitStatus();
}

/** A server by its pane and port: what keyboard focus follows across a refresh. */
const serverKey = (s: Server) => `${s.pane.id}:${s.port}`;

function paintServers(shown: number) {
  // Focus on a server, the count or a row of the open list stays on that server or the count across the
  // rebuild, as renderPicker's does by data-key. Focus anywhere else stays put.
  const focused = document.activeElement as HTMLElement | null;
  const inList = openMenu === serversMenu && menu.contains(focused);
  const focusKey = inList || $("#sb-servers").contains(focused) ? focused?.dataset.key : undefined;
  const items: HTMLElement[] = statusServers.slice(0, shown).map((s) => {
    const b = document.createElement("button");
    b.className = "sb-item sb-server";
    b.dataset.key = serverKey(s);
    b.title = serverTitle(s);
    b.append(statusSpan("dot", ""), statusSpan("sb-name", serverName(s)), statusSpan("num", `:${s.port}`));
    b.onclick = () => void (revealPane(s.pane) || paintStatus());
    return b;
  });
  if (statusServers.length > shown) {
    const more = document.createElement("button");
    more.className = "sb-item sb-more";
    more.dataset.key = "more";
    more.textContent = `+${statusServers.length - shown}`;
    more.title = `${statusServers.length} servers in all: click for the list`;
    more.setAttribute("aria-haspopup", "menu");
    more.onclick = () => showMenu(more, serversMenu);
    items.push(more);
  }
  $("#sb-servers").replaceChildren(...items);
  const more = items.find((b) => b.dataset.key === "more");
  // The list open over the old count follows: on the new one, or closed with it.
  if (openMenu === serversMenu && !menu.classList.contains("hidden")) {
    if (more) {
      anchor = more;
      renderMenu();
      place();
    } else hideMenu();
  }
  if (focusKey === undefined) return;
  // The same server or count; gone, the list's first row, then the count, the first server, the PC's readings.
  const rows = menu.classList.contains("hidden") ? [] : [...$("#menu-list").querySelectorAll<HTMLElement>(".menu-item")];
  const pool = inList ? [...rows, ...items] : items;
  (pool.find((e) => e.dataset.key === focusKey) ?? (inList ? rows[0] : undefined) ?? more ?? items[0] ?? $("#sb-pc")).focus();
}

/** Every server the panes run, behind the bar's count. */
const serversMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    for (const s of statusServers) {
      const row = document.createElement("div");
      row.className = "menu-item";
      row.dataset.key = serverKey(s);
      row.title = serverTitle(s);
      row.append(statusSpan("", `${serverName(s)} :${s.port}`), statusSpan("muted", s.pane.th.name));
      // Its pane gone before the next poll: the bar drops that server now instead.
      row.onclick = () => void (hideMenu(), revealPane(s.pane) || paintStatus());
      list.append(row);
    }
  },
};

/** The mic's menu: the language and the prefix lists as they are, each with a
 * way to add one (that list on its own, with its field), then Hide. */
const speakMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const head = (text: string) => list.append(Object.assign(document.createElement("div"), { className: "menu-note menu-head", textContent: text }));
    const more = (text: string, m: Menu) => {
      const row = document.createElement("div");
      row.className = "menu-item menu-more";
      row.append(glyph("plus"), Object.assign(document.createElement("span"), { textContent: text }));
      row.onclick = () => {
        const at = anchor;
        hideMenu();
        showMenu(at, m);
      };
      list.append(row);
    };
    head("Language");
    langMenu.rows(list);
    more("Add a language…", langMenu);
    head("Prefix");
    prefixMenu.rows(list);
    more("Add a prefix…", prefixMenu);
    const hide = document.createElement("div");
    hide.className = "menu-item menu-hide";
    hide.title = "F4 still dictates. Show the button again from Preferences.";
    hide.append(glyph("eye-off"), Object.assign(document.createElement("span"), { textContent: "Hide this button" }));
    hide.onclick = () => {
      hideMenu();
      speakShown = false;
      paintSpeak();
      save();
    };
    list.append(hide);
  },
};

const hideMenu = () => menu.classList.add("hidden");

/** Park the panel under whatever opened it. Its own call because a panel can
 * change size while open — the profile section arrives a moment after the rest —
 * and a taller one has to be clamped again or it runs off the bottom. The menu
 * must be visible first: display:none has no size to measure. */
function place() {
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  // Right-aligned under whatever opened it, but kept on screen. The toolbar
  // buttons always had room; a pane's context gauge can sit anywhere in the
  // grid, so both edges have to be clamped.
  const right = Math.min(window.innerWidth - r.right, window.innerWidth - menu.offsetWidth - gap);
  menu.style.right = `${Math.max(gap, right)}px`;
  // Under the anchor, or above it when it sits at the bottom edge (the overview's selection bar) and the menu would cover it.
  // On screen either way: an overview card re-sorted below the fold takes its
  // button, and the menu re-anchored to it, along (dashboard refresh).
  const below = r.bottom + 4, above = r.top - 4 - menu.offsetHeight;
  const flip = below + menu.offsetHeight > window.innerHeight - gap && above >= gap;
  menu.style.top = `${Math.max(gap, Math.min(flip ? above : below, window.innerHeight - menu.offsetHeight - gap))}px`;
}

function showMenu(at: HTMLElement, m: Menu) {
  if ($("#preferences").contains(at)) {
    at = $("#preferences-btn");
    togglePreferences(false);
  }
  if (!menu.classList.contains("hidden") && at === anchor) return hideMenu();
  anchor = at;
  openMenu = m;
  renderMenu();
  menu.classList.remove("hidden");
  place();
  menu.querySelector<HTMLElement>(".menu-item, select, input, button, a[href]")?.focus();
}

function togglePreferences(on = $("#preferences").classList.contains("hidden")) {
  $("#preferences").classList.toggle("hidden", !on);
  $("#preferences-btn").setAttribute("aria-expanded", String(on));
  if (on) {
    hideMenu();
    $("#theme").focus();
    // An update installed since Loom started waits for a restart: say so on the button.
    void invoke<boolean>("exe_updated").then((updated) => {
      const b = $("#restart-loom");
      b.textContent = updated ? "Restart to update" : "Restart Loom";
      b.classList.toggle("primary", updated);
    }, () => {});
  }
}

function toggleSide(on?: boolean) {
  const narrow = matchMedia("(max-width: 760px)").matches;
  const side = $("#side");
  on ??= narrow ? !side.classList.contains("drawer-open") : side.classList.contains("hidden");
  const changed = sideOpen !== on;
  sideOpen = on;
  side.classList.toggle("hidden", !narrow && !on);
  side.classList.toggle("drawer-open", narrow && on);
  $("#side-toggle").setAttribute("aria-expanded", String(on));
  if (changed) save();
}

// --- Ctrl+F: one shared input parked over the active pane -----------------
const find = $<HTMLInputElement>("#find");

function closeFind(focus = true) {
  find.classList.add("hidden");
  $("#find-n").textContent = "";
  current?.active?.search.clearDecorations();
  if (focus) current?.active?.focus();
}

function toggleFind() {
  const p = current?.active;
  if (!p) return;
  if (!find.classList.contains("hidden")) return closeFind();
  const r = p.el.getBoundingClientRect();
  find.style.top = `${r.top + 6}px`;
  find.style.right = `${window.innerWidth - r.right + 6}px`;
  find.classList.remove("hidden");
  countFinds(p);
  const n = $("#find-n");
  n.textContent = "";
  n.style.top = `${r.top + 11}px`;
  n.style.right = `${window.innerWidth - r.right + 16}px`;
  find.select();
  find.focus();
}

find.onkeydown = (e) => {
  if (e.key === "Escape") return closeFind();
  const p = current?.active;
  if (e.key !== "Enter" || !p || !find.value) return;
  if (e.shiftKey) p.search.findPrevious(find.value, findOpts());
  else p.search.findNext(find.value, findOpts());
};
// Search as you type: the first hit lands while the word is still being typed.
find.oninput = () => {
  const p = current?.active;
  if (!p) return;
  if (find.value) p.search.findNext(find.value, { ...findOpts(), incremental: true });
  else (p.search.clearDecorations(), ($("#find-n").textContent = ""));
};
/** "3/17" beside the box, from whichever pane is being searched. Registered
 * once per pane, the first time it is searched. */
const findCounted = new WeakSet<Pane>();
function countFinds(p: Pane) {
  if (findCounted.has(p)) return;
  findCounted.add(p);
  p.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (current?.active !== p) return;
    $("#find-n").textContent = !find.value ? "" : resultCount ? `${resultIndex + 1}/${resultCount}` : "none";
  });
}

// --- boot -----------------------------------------------------------------
// --- loomctl: commands from a terminal ----------------------------------------
// control.rs hands each loomctl request here as a "cli" event and waits for
// cli_reply. Every command goes through the functions the window's own buttons
// use, so its effect shows on screen; where a button would ask first, the
// command wants --yes instead.

/** `replayed`: the answer to an earlier request with the same --key. */
type CliResult = { data?: unknown; text?: string; note?: string; replayed?: boolean };
/** How long the caller waits, the folder its terminal was in, its --key,
 * and the hash of the request the key names. */
/** `signal`: aborted when loomctl hangs up (Rust's cli-cancel), for the read-only waits to stop on. */
type CliContext = { seconds: number; cwd?: string; key?: string; what?: string; signal?: AbortSignal };
/** `options`: every --option the command takes (cli.ts parseArgs checks them). */
type CliCommand = { usage: string; help: string; options?: Options; run: (a: Args, ctx: CliContext) => CliResult | Promise<CliResult> };
/** A wait that ran out: loomctl exits 3 for it rather than 1. `details`:
 * fields for --json, such as where a task got to. */
class CliTimeout extends Error {
  details: Record<string, unknown> = {};
}
/** A failure with fields for --json beside the message: what a cleanup got
 * done before it stopped, or that a record isn't there. */
class CliError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
  }
}

const providerPolls = new WeakMap<Pane, { sid: string; gen: number; promise: Promise<void> }>();
async function pollProviderUsage(panes = threads.flatMap((t) => t.panes)) {
  const snapshots = panes.filter((p) => p.agent === "codex" && p.sessionId)
    .map((p) => ({ p, sid: p.sessionId!, gen: p.generation }));
  const waiting: Promise<void>[] = [], fresh: typeof snapshots = [];
  for (const snap of snapshots) {
    const old = providerPolls.get(snap.p);
    if (old && old.sid === snap.sid && old.gen === snap.gen) waiting.push(old.promise);
    else fresh.push(snap);
  }
  if (fresh.length) {
    const promise = (async () => {
      const got = await invoke<Record<string, Usage>>("codex_session_usage", { panes: fresh.map(({ p, sid }) => [p.id, sid]) }).catch(() => ({} as Record<string, Usage>));
      for (const { p, sid, gen } of fresh) {
        if (!gone(p) && p.generation === gen && p.sessionId === sid && got[p.id]?.sid === sid) p.providerUsage = got[p.id];
      }
    })();
    for (const { p, sid, gen } of fresh) providerPolls.set(p, { sid, gen, promise });
    waiting.push(promise.finally(() => {
      for (const { p } of fresh) if (providerPolls.get(p)?.promise === promise) providerPolls.delete(p);
    }));
  }
  // Bound each caller's wait, not the native operation or its result handler.
  await Promise.all(waiting.map(async promise => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  }));
}

/** A pane's state in one word, the Overview's words. */
const cliState = (p: Pane) => (p.dead ? "exited" : p.starting ? "starting" : p.waiting ? "waiting" : p.busy ? "working" : "idle");
const CLI_STATES = ["waiting", "working", "idle", "exited", "starting"];
const CLI_ALIASES: Record<string, string> = { busy: "working", dead: "exited", ready: "idle" };
function cliStates(value: unknown, fallback: string, option = "--state"): string[] {
  const list = String(value ?? fallback).toLowerCase().split(",").map((s) => CLI_ALIASES[s.trim()] ?? s.trim());
  for (const s of list) if (!CLI_STATES.includes(s)) throw new Error(`${option} takes ${CLI_STATES.join(", ")}, not ${s}.`);
  return list;
}

/** "<thread>:<n>", the name loomctl prints and takes back. */
const paneName = (p: Pane) => `${p.th.name}:${p.th.panes.indexOf(p) + 1}`;
function paneSettings(p: Pane) {
  const u = (p.providerUsage?.sid === p.sessionId ? p.providerUsage : null) ?? p.usage, ran = u?.mainTurns ?? 0;
  const held = (s: Set_ | undefined, cur: string) => s && (ran <= s.at || (s.was !== undefined && cur === s.was)) ? s.v : "";
  const left = u ? Math.max(0, u.window - u.ctx) : 0;
  return {
    model: settingValue(held(p.want?.model, u?.model ?? "") || u?.liveModel || u?.model || p.startupSettings?.model, "model"),
    effort: settingValue(held(p.want?.effort, u?.effort ?? "") || u?.liveEffort || (u?.effortObserved ? u.effort : u?.effort || p.effort || p.startupSettings?.effort), "effort"),
    context: u && u.window > 0 ? { usedTokens: u.ctx, windowTokens: u.window, remainingTokens: left, remainingPercent: Math.round(100 * left / u.window) } : null,
  };
}
const paneData = (p: Pane) => ({
  id: p.id, ref: paneName(p), thread: p.th.name, threadId: p.th.id, n: p.th.panes.indexOf(p) + 1, agent: p.agent,
  // stableId: the same pane's id after Loom restarts, when its id is new.
  title: p.label, state: cliState(p), sessionId: p.sessionId ?? null, stableId: p.stableId, dir: p.th.dir, front: current === p.th && p.th.active === p,
  zoomed: p.th.zoomed === p,
  // Which launch this is (send --gen takes it), and what a shell with Loom's prompt last reported.
  generation: p.generation, commands: p.commands, failed: p.lastFailed, exit: p.lastExit, atPrompt: p.atPrompt, turns: p.turns, notify: p.notify,
  lastOutput: p.lastOut ? new Date(p.lastOut).toISOString() : null,
  ...paneSettings(p),
});
/** --gen: input for that launch of the pane only. */
const cliGen = (a: Args) => (a.gen === undefined ? undefined : num(a, "gen", 0, 0, Number.MAX_SAFE_INTEGER));
function threadState(th: Thread) {
  const s = th.panes.map(cliState);
  return s.includes("waiting") ? "waiting" : s.includes("working") ? "working" : s.length && s.every((x) => x === "exited") ? "exited" : "idle";
}
const threadData = (th: Thread) => ({
  id: th.id, name: th.name, repo: th.repo, dir: th.dir, branch: th.branch, front: th === current, state: threadState(th),
  layout: th.layout, zoomed: th.zoomed?.id ?? null, changed: th.changed, panes: th.panes.map(paneData),
});
const paneRows = (panes: Pane[]) => table(panes.map((p) => [paneName(p), p.id, p.agent, cliState(p), p.label]));

/** A thread by id or name. A name's start is enough only for a command that
 * changes nothing (`loose`): `close-thread fix` must never reach fix-login
 * once fix is gone. */
function cliThread(sel: string | undefined, loose = false): Thread {
  if (!sel || sel === "current" || sel === ".") {
    if (current) return current;
    throw new Error("No thread is open. loomctl threads lists them.");
  }
  const byId = threads.find((t) => t.id === sel);
  if (byId) return byId;
  const low = sel.toLowerCase();
  const exact = threads.filter((t) => t.name.toLowerCase() === low);
  const prefix = threads.filter((t) => t.name.toLowerCase().startsWith(low));
  const found = exact.length || !loose ? exact : prefix;
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`"${sel}" matches ${found.map((t) => `${t.name} (${t.id})`).join(", ")}. Use an id.`);
  if (prefix.length) throw new Error(`No thread is named "${sel}". This command needs a thread's whole name or its id: ${prefix.map((t) => `${t.name} (${t.id})`).join(", ")}?`);
  throw new Error(`No thread "${sel}". loomctl threads lists them.`);
}

function cliPane(sel: string | undefined, loose = false): Pane {
  const ref = paneRef(sel);
  if ("current" in ref) {
    const p = current?.active ?? current?.panes[0];
    if (p) return p;
    throw new Error("No pane is in front. Name one: loomctl panes lists them.");
  }
  if ("thread" in ref) {
    const th = cliThread(ref.thread, loose);
    const p = th.panes[ref.n - 1];
    if (p) return p;
    throw new Error(`${th.name} has ${th.panes.length} pane${th.panes.length === 1 ? "" : "s"}.`);
  }
  const p = threads.flatMap((t) => t.panes).find((x) => x.id === ref.id);
  if (p) return p;
  // A thread on its own means the pane it has in front.
  const th = cliThread(ref.id, loose);
  const front = th.active ?? th.panes[0];
  if (front) return front;
  throw new Error(`${th.name} has no panes.`);
}

/** The nth word, or an error naming what was missing. */
function cliWord(a: Args, i: number, what: string) {
  const w = a._[i];
  if (!w) throw new Error(`Name ${what}.`);
  return w;
}

/** --mix's {"label": count} as the panes a thread starts, in the New thread form's order: agents, then terminals. */
function cliMix(text: string): PaneState[] {
  let mix: unknown;
  try {
    mix = JSON.parse(text);
  } catch {}
  if (!mix || typeof mix !== "object" || Array.isArray(mix)) throw new Error('--mix takes {"label": count}, as in {"claude":2}.');
  const counts = new Map<Startup, number>();
  for (const [label, n] of Object.entries(mix)) {
    const s = startups.find((x) => x.label.toLowerCase() === label.toLowerCase()); // as --agent finds it
    if (!s) throw new Error(`--mix takes ${startups.map((x) => x.label).join(", ")}, not ${label}.`);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PANES) throw new Error(`--mix counts are 1 to ${MAX_PANES}, not ${JSON.stringify(n)} for ${label}.`);
    counts.set(s, (counts.get(s) ?? 0) + n);
  }
  return mixOrder().flatMap((s) => Array<PaneState>(counts.get(s) ?? 0).fill({ cmd: s.cmd }));
}

/** The startup command for --agent, or --cmd as given. */
function cliCommand(a: Args) {
  const cmd = str(a, "cmd");
  const agent = str(a, "agent");
  const model = str(a, "model"), effort = str(a, "effort");
  if (cmd !== undefined && agent !== undefined) throw new Error("Give --agent or --cmd, not both.");
  if (cmd !== undefined && (model !== undefined || effort !== undefined)) throw new Error("--model and --effort require an agent startup, not --cmd.");
  if (cmd !== undefined) return cmd;
  const s = agent === undefined ? startups[0] : startups.find((x) => x.label.toLowerCase() === agent.toLowerCase());
  if (!s) throw new Error(`--agent takes ${startups.map((x) => x.label).join(", ")}, not ${agent}.`);
  const family = agentOf(s.cmd);
  if ((model !== undefined || effort !== undefined) && family === "shell") throw new Error("--model and --effort require an agent.");
  // These values cross cmd.exe for npm shims. Accept identifiers, never shell syntax.
  if (model !== undefined && !/^[a-z0-9][a-z0-9._:/\[\]-]{0,127}$/i.test(model)) throw new Error("--model needs a model identifier without spaces or shell characters.");
  if (effort !== undefined && (family === "opencode" || family === "omp" || family === "cursor" || family === "grok" || !/^(none|minimal|low|medium|high|xhigh|max|auto)$/.test(effort))) throw new Error("--effort takes none, minimal, low, medium, high, xhigh, max or auto for Claude or Codex; the agent validates model support.");
  return s.cmd + (model === undefined ? "" : ` --model ${model}`) + (effort === undefined ? "" : family === "codex" ? ` -c model_reasoning_effort=${effort}` : ` --effort ${effort}`);
}

/** Resolves once `ok()` holds. Polled: states change in a dozen places. */
async function until(ok: () => boolean, seconds: number, what: string, signal?: AbortSignal) {
  const end = Date.now() + seconds * 1000;
  while (!ok()) {
    signal?.throwIfAborted();
    if (Date.now() > end) throw new CliTimeout(`Waited ${seconds} s for ${what}.`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const gone = (p: Pane) => !p.th.panes.includes(p) || !threads.includes(p.th);

/** A pane's last n lines, scrollback included, up to the last line with
 * anything on it: below a short prompt the screen is blank rows. */
function tailLines(p: Pane, n: number) {
  const buf = p.term.buffer.active;
  let to = buf.length;
  while (to > 0 && !buf.getLine(to - 1)?.translateToString(true, 0, p.term.cols).trim()) to--;
  const from = Math.max(0, to - n), lines: string[] = [];
  for (let y = from; y < to; y++) lines.push(buf.getLine(y)?.translateToString(true, 0, p.term.cols) ?? "");
  return { lines, from, to };
}

/** Pane state events (pane_events.ts): each state a pane settled into, as
 * watch --panes, wait --until and the webhooks hear it. In memory only. */
const paneEvents = new PaneEventLog();
const paneEventGate = new TaskEventGate();
let webhooks: Webhook[] = [];
let couriers: Courier[] = [];
// The phone's Web Push already posts through Windows' curl on a blocking thread: webhooks share it.
// Its failure speaks of push services, so a webhook's says what curl met instead.
const CURL_EXITS: Record<string, string> = { "6": "couldn't resolve the host", "7": "couldn't connect", "28": "no answer in 20 s", "35": "TLS handshake failed", "60": "certificate not trusted" };
const postHook = (url: string, headers: [string, string][], body: string) =>
  invoke<number>("push_post", { endpoint: url, headers, body: Array.from(new TextEncoder().encode(body)) }).catch((e) => {
    const code = /curl exit (-?\d+)/.exec(String(e))?.[1];
    throw new Error(code === undefined ? String(e) : `${CURL_EXITS[code] ?? "curl failed"} (curl exit ${code})`);
  });

function paneEvent(p: Pane, old: string, state: string, since: number) {
  if (gone(p)) return;
  const e = paneEvents.add({
    at: new Date(since).toISOString(), pane: p.id, stableId: p.stableId, ref: paneName(p), thread: p.th.name, threadId: p.th.id,
    agent: p.agent, title: p.label, old, state,
    asking: state === "waiting" && p.agent !== "shell" && !!readMenu(liveScreen(p, false), p.agent),
    exit: state === "exited" ? p.exitCode ?? null : null, generation: p.generation, turns: p.turns,
    tail: tailLines(p, TAIL_LINES).lines.map((l) => l.trimEnd().slice(0, TAIL_WIDTH)),
  });
  paneEventGate.notify();
  for (const c of couriers) c.push(e);
}

/** One courier per webhook: an unchanged hook keeps its queue, a removed one stops. */
function syncCouriers() {
  const kept = couriers.filter((c) => webhooks.includes(c.hook));
  for (const c of couriers) if (!kept.includes(c)) c.stop();
  couriers = webhooks.map((h) => kept.find((c) => c.hook === h) ?? new Courier(h, postHook));
}

/** watch --panes: the events after --after that the filters keep, waiting up to the timeout for one. */
async function watchPanes(a: Args, seconds: number, signal?: AbortSignal) {
  if (a._.length || ["metadata", "policy", "policy-v4", "notification-context"].some((k) => a[k] !== undefined))
    throw new Error("watch --panes takes --thread, --pane, --state and --after, not a task or --metadata.");
  const after = num(a, "after", 0, 0, Number.MAX_SAFE_INTEGER), th = str(a, "thread"), sel = str(a, "pane");
  // An exact id (a pane's, its stable id, a thread's) is kept as given, so the events of a pane or
  // thread since closed stay readable and a stable id finds the pane after a restart. A name, thread:n
  // or current is resolved among what is open, on each ask.
  const known = (id: string, ids: (e: PaneEvent) => string[]) => paneEvents.events.some((e) => ids(e).includes(id));
  const filter = {
    threads: th === undefined ? [] : [known(th, (e) => [e.threadId]) ? th : cliThread(th, true).id],
    panes: sel === undefined ? [] : [known(sel, (e) => [e.pane, e.stableId]) || threads.some((t) => t.panes.some((p) => p.stableId === sel)) ? sel : cliPane(sel, true).id],
    states: a.state === undefined ? [] : cliStates(str(a, "state"), ""),
  };
  const want = (e: PaneEvent) => matches(filter, e);
  await paneEventGate.waitUntil(() => paneEvents.after(after, want).events.length > 0, Math.max(0, seconds - 1) * 1000, signal);
  const { events, next, gap } = paneEvents.after(after, want);
  return { data: { events, next, done: false, gap }, text: events.map(paneEventLine).join("\n") };
}

/** A webhook as `webhook list` shows it: the secret and the header's value never. */
function hookRow(h: Webhook, i: number) {
  const c = couriers[i], pane = (id: string) => threads.flatMap((t) => t.panes).find((p) => p.stableId === id);
  return {
    n: i + 1, url: h.url, header: h.header ? `${h.header.slice(0, h.header.indexOf(":"))}: ...` : null, secret: !!h.secret,
    threads: h.threads ?? [], panes: (h.panes ?? []).map((id) => { const p = pane(id); return p ? paneName(p) : id; }), states: h.states ?? [],
    sent: c?.sent ?? 0, queued: c?.queue.length ?? 0, lastOk: c?.lastOk ?? null, failures: c?.failures ?? [],
  };
}

const paneEventLine = (e: PaneEvent) => `${e.seq}  ${e.at}  ${e.ref}  ${e.old} -> ${e.state}${e.asking ? " (asking)" : ""}  ${e.title}`;

/** --delete: what close-plan and close-thread delete besides closing. */
function cliDelete(a: Args, th: Thread): "" | "worktree" | "branch" {
  const del = str(a, "delete") ?? "";
  if (del && del !== "worktree" && del !== "branch") throw new Error(`--delete takes worktree or branch, not ${del}.`);
  if (del && !th.isWorktree) throw new Error(`${th.name} isn't a worktree Loom made, so there is nothing to delete.`);
  return del as "" | "worktree" | "branch";
}

/** close-plan: the thread, the panes closing it stops, and with `del` what
 * deleting loses. `rev` covers all of it in full (the lists shown stop at 50),
 * so close-thread --plan refuses if any of it changed. */
async function closePlan(th: Thread, del: "" | "worktree" | "branch", discard: Loss[] = []) {
  const inv = del ? await inventory(th, del === "branch", discard) : null;
  const panes = th.panes.map((p) => ({ id: p.id, ref: paneName(p), agent: p.agent, generation: p.generation }));
  // The inventory's branch: th.branch can move during its awaits.
  const target = { thread: th.id, name: th.name, dir: th.dir, repo: th.repo, branch: (inv ? inv.branch : th.branch) || null, delete: del || null };
  const rev = (await sha256(JSON.stringify([target, panes.map((p) => [p.id, p.generation]), inv]))).slice(0, 16);
  const lost = inv && lossCounts(inv);
  const data = {
    rev, ...target, panes,
    ...(inv && lost
      ? { head: inv.head || null, branchTip: inv.branchTip || null, lost, discard: LOSSES.filter((l) => lost[l]), tracked: inv.tracked.slice(0, 50), untracked: inv.untracked.slice(0, 50), ignored: inv.ignored.slice(0, 50) }
      : {}),
  };
  return { data, inv };
}

/** A receipt Loom still has, or a failure saying it isn't available. */
function cliReceipt(token: string) {
  const r = receipts.get(token);
  if (r) return r;
  throw new CliError(`Receipt ${token} isn't available. Loom keeps receipts in memory until it exits, and only the last 500 with an outcome, so it was dropped, Loom restarted since, or this Loom never issued it.`, { unavailable: true });
}

/** loomctl receipt: what Loom wrote for a send --receipt and what came back,
 * as two parts, so a turn's end is never mistaken for the job being done. */
function receiptRecord(token: string, r: Receipt) {
  const at = (t?: number) => (t ? new Date(t).toISOString() : null);
  const res = r.result;
  return {
    receipt: token, pane: r.pane, ref: r.ref, generation: r.gen, key: r.key,
    wrote: {
      sha256: r.sha256, bytes: r.bytes, stage: r.steps.submitted ? "submitted" : r.steps.typed ? "typed" : "accepted", uncertain: r.uncertain ?? null,
      acceptedAt: at(r.acceptedAt), typedAt: at(r.steps.typed), submittedAt: at(r.steps.submitted),
    },
    acknowledged: !res ? null : "turn" in res ? { turn: res.turn, at: at(r.resultAt) } : { failed: res.failed, exit: res.exit, at: at(r.resultAt) },
    outcome: res ? "acknowledged" : receiptSettled(r) ? "none" : "pending",
    // Its task's Enter is held back: `keys <pane> enter` may still press it.
    held: heldEnter.has(token),
  };
}

/** wait --receipt: the outcome of what send --receipt sent, once it's in. */
async function waitReceipt(token: string, seconds: number, signal?: AbortSignal) {
  const r = cliReceipt(token);
  if (r.unsent && !r.result) throw new Error(`Loom ${r.uncertain === "type" ? "may have typed part of" : "typed"} ${token}'s text into ${r.ref} but didn't press Enter, so no outcome will come. loomctl read ${r.ref} shows the input.`);
  // The result is recorded by the launch the receipt went to (finishReceipt),
  // so it stands after a restart, and a later launch can't supply one.
  const lost = () => receiptLost(r);
  await until(() => !!r.result || !!r.unsent || lost(), seconds, `receipt ${token} on ${r.ref}`, signal);
  const p = paneById(r.pane);
  if (r.unsent && !r.result) throw new Error(`Loom ${r.uncertain === "type" ? "may have typed part of" : "typed"} ${token}'s text into ${r.ref} but didn't press Enter, so no outcome will come. loomctl read ${r.ref} shows the input.`);
  const result = r.result;
  if (!result) throw new Error(`${r.ref} ${!p ? "was closed" : p.dead ? "exited" : "restarted"} before it finished, so there's no outcome; it may have run partway.`);
  if ("turn" in result) {
    // Whether it stopped on a question can only be read off this launch's screen.
    const asking = !p || lost() ? null : !!readMenu(liveScreen(p, false), p.agent);
    return { data: { receipt: token, pane: r.pane, done: true, turn: result.turn, asking }, text: `${r.ref} finished its turn${asking ? " with a question: loomctl menu reads it" : ""}` };
  }
  const { failed, exit } = result;
  return { data: { receipt: token, pane: r.pane, done: true, failed, exit }, text: failed === false ? "succeeded" : failed ? `failed${exit === null ? "" : ` with exit ${exit}`}` : "finished" };
}

/** send's whole path, and submit's. With `submit`, it always takes a receipt
 * whose token is a new task's id, refuses an agent's question on screen and a
 * draft (an input Loom can't read is typed after, as send does), and the task
 * begins the moment typing does (taskTyping): a send stopped before that
 * leaves no task behind. */
async function sendText(a: Args, ctx: CliContext, submit?: { task?: Task }) {
  const p = cliPane(cliWord(a, 0, "a pane (. for the one in front)"));
  const asked = a._.slice(1).join(" ");
  let text = asked;
  if (!text) throw new Error("Give the text to send.");
  if (p.dead) throw new Error(`${paneName(p)} has exited. loomctl restart ${paneName(p)} starts it again.`);
  const ref = paneName(p), gen = cliGen(a) ?? p.generation;
  const expect = str(a, "input"), replace = flag(a, "replace") || !!submit;
  // The caller's text as Loom got it, before a shell receipt's comment.
  const digest = await sha256(asked), bytes = new TextEncoder().encode(asked).length;
  const steps: SendSteps = {};
  let token: string | undefined;
  if (flag(a, "receipt") || submit) {
    if (flag(a, "no-enter")) throw new Error("A receipt is for a command that runs: leave out --no-enter.");
    if ([...receipts.values()].filter((r) => !receiptSettled(r)).length >= 2000) throw new Error("2000 receipts are still waiting for their outcome, so this wasn't sent. Wait for some first.");
    token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    receipts.set(token, { pane: p.id, ref, gen, key: ctx.key ?? null, sha256: digest, bytes, acceptedAt: Date.now(), steps });
    keepReceipts();
    if (p.agent === "shell") text = `${text}  # loom-receipt:${token}`;
    if (submit) {
      submit.task = {
        id: token, key: ctx.key ?? null, what: ctx.what ?? null, pane: p.id, ref, agent: p.agent, gen, sha256: digest, bytes, match: promptMatch(asked),
        input: "unknown", state: "accepted", correlation: null, uncertain: null, reason: null, detail: null, exit: null,
        acceptedAt: Date.now(), submittedAt: null, startedAt: null, endedAt: null, events: [], context: paneContext(p),
      };
      tasks.set(token, submit.task);
    }
  }
  const receipt = token ? receipts.get(token) : undefined;
  let task = submit?.task;
  let release = () => {};
  // An ordinary send to an agent is a turn Loom can follow too: a task of its
  // own, made right before its Enter, so a send that stops sooner leaves none.
  const tracked = !submit && !flag(a, "no-enter") && p.agent !== "shell";
  // A shell receipt needs PowerShell's prompt, checked in the pane's turn,
  // right before the paste: an Enter queued ahead of it spends the prompt it
  // saw (usePrompt), so it waits for the next one, or gives up unwritten.
  const atPrompt = async (live: (typed: boolean) => void) => {
    for (let i = 0; i < 25 && !p.atPrompt; i++) await new Promise((r) => setTimeout(r, 200));
    live(false);
    if (!p.atPrompt) throw new NotSubmitted(`${ref} isn't at Loom's PowerShell prompt (a command is still running, or another program has the pane), so nothing was typed. loomctl wait --receipt for the command before, then send again.`, false);
  };
  // --input and --replace look at the input in the pane's turn, right before
  // typing, so no other loomctl call can type in between.
  let shown: ReturnType<typeof inputState> | undefined;
  let correlationWarning: string | undefined;
  const guard = () => {
    // A question takes keys as answers, and Enter picks its highlighted option.
    if (submit && p.agent !== "shell" && readMenu(liveScreen(p, false), p.agent)) {
      throw new NotSubmitted(`${ref} is asking a question, so submit typed nothing: Enter there would answer it. loomctl menu ${ref} reads it and loomctl choose answers it.`, false);
    }
    if (expect === undefined && !replace && !tracked) return;
    shown = inputState(p);
    if (expect !== undefined && shown.rev !== expect) throw new NotSubmitted(`${ref}'s input changed since revision ${expect} (it's ${shown.rev} now, ${shown.kind}), so nothing was typed. loomctl --json read ${ref} shows it.`, false);
    if (replace && shown.kind !== "empty" && shown.kind !== "suggestion" && !(submit && shown.kind === "unknown")) {
      throw new NotSubmitted(submit
        ? `${ref}'s input holds a draft someone typed, so submit typed nothing: Loom never clears a draft, and the task would join it. Clear it in the window, then submit again.`
        : `${ref}'s input ${shown.kind === "draft" ? "holds a draft someone typed." : `can't be read: ${shown.why}`} So --replace typed nothing: Loom never clears a draft. Clear it in the window, or send without --replace to type after it.`, false);
    }
    if (task) task.input = shown.kind;
  };
  // --replace over a suggestion: Enter only once the input reads as a draft
  // without it. Typing must have replaced it, not landed after it.
  const leftover = () => {
    if (!replace || shown?.kind !== "suggestion" || !shown.text) return;
    const flat = (s: string) => s.replace(/\s+/g, ""), old = flat(shown.text), now = inputState(p);
    if (now.kind !== "draft" || (!flat(asked).includes(old) && flat(now.text ?? "").includes(old))) {
      throw new NotSubmitted(`Loom couldn't see the suggestion gone from ${ref}'s input after typing (it reads as ${now.kind}), so it didn't press Enter. The text is in the input, so don't send it again: loomctl read ${ref} shows it.`, true);
    }
  };
  try {
    if (flag(a, "no-enter")) {
      await inTurn(p, async () => {
        guard();
        steps.typing = Date.now();
        await keys(p, paste(p, text));
        steps.typed = Date.now();
      }, gen);
    } else
      await sendReply(p, text, {
        gen,
        steps,
        // The task's reservation is written first, then the prompt waited for;
        // sendReply's last checks run after both, with nothing awaited before the paste.
        beforePaste: task || (receipt && p.agent === "shell") ? async (live) => {
          if (task) await reserveTask(task);
          if (receipt && p.agent === "shell") await atPrompt(live);
        } : undefined,
        check: guard,
        beforeEnter: () => {
          leftover();
          if (receipt && p.agent !== "shell") receipt.turnsAt = p.turns;
          if (tracked) {
            let match = promptMatch(asked);
            if (p.agent === "claude" || p.agent === "codex") {
              const complete = inputState(p);
              // An empty composer plus our sole paste establishes the full prompt,
              // even if the agent collapses it. Otherwise read what Enter submits:
              // the caller's text may have joined a draft already in the composer.
              if (shown?.kind === "empty" || shown?.kind === "suggestion") match = promptMatch(asked);
              else if (complete.kind === "draft" && complete.text !== null && !PLACEHOLDER.test(complete.text)) match = promptMatch(complete.text);
              else {
                match = "";
                correlationWarning = "Loom couldn't read the complete submitted prompt, so this send cannot be matched to the agent's prompt reports.";
              }
            }
            task = turnTask(p, "send", match, Date.now(),
              { ...(token ? { id: token } : {}), key: ctx.key ?? null, what: ctx.what ?? null, sha256: digest, bytes, input: shown?.kind ?? "unknown", detail: correlationWarning ?? null });
          }
          if (task) release = holdSignals(p);
        },
      });
  } catch (e) {
    // Judged by how far the writes got, not by the error: a write that failed
    // may have gone in part-way, so only nothing written is safe to send again.
    if (!steps.typing) {
      if (token) receipts.delete(token);
      // A reserved task stays, as not sent: its key is spent, and a retry gets it back.
      if (task?.events.length) {
        moveTask(task, { state: "cancelled", signal: "loomctl", reason: "not-sent" });
        if (e instanceof NotSubmitted) e.details = { ...e.details, task: task.id };
      } else if (task) tasks.delete(task.id);
      throw e;
    }
    const uncertain = steps.entering && !steps.submitted ? "submit" : !steps.typed ? "type" : undefined;
    // Its text, alone, may be waiting for Enter: the task stays open (heldTask),
    // its receipt pending with it. Held before the receipts are pruned below.
    if (task && receipt && e instanceof NotShown) heldEnter.set(task.id, { seq: p.inputSeq, receipt });
    if (receipt) Object.assign(receipt, { unsent: !steps.entering && !heldEnter.has(token!), uncertain }), keepReceipts();
    const details = { ...(token && { receipt: token }), ...(task && { task: task.id }), ...(uncertain && { uncertain }) };
    const why = e instanceof Error ? e.message : String(e);
    if (task) {
      // The pane restarted or closed while Loom typed: it took the text with it.
      const lost = changed(p, gen);
      if (e instanceof NotSubmitted && !e.typed) moveTask(task, { state: "cancelled", signal: "pane", reason: lost === "stopped" ? "pane-stopped" : lost === "was closed" ? "pane-closed" : "pane-restarted" });
      // Enter may have gone in: it stays open, but only its own token (a shell)
      // can prove it did, so an agent's turn of its text ends it unknown (unproven).
      else if (uncertain === "submit") {
        task.submittedAt = steps.entering ?? Date.now();
        moveTask(task, { state: "submitted", signal: "enter", uncertain }, task.submittedAt);
      }
      else if (heldEnter.has(task.id)) moveTask(task, { state: "accepted", signal: "loomctl", uncertain: "enter", detail: why.slice(0, 200) });
      else moveTask(task, { state: "failed", signal: "loomctl", reason: "not-submitted", uncertain: uncertain ?? null, detail: why.slice(0, 200) });
      release();
    }
    // A pane that restarted or closed took the text with it, so a retry is safe.
    if (e instanceof NotSubmitted && !e.typed) throw Object.assign(e, { details: { ...e.details, ...details } });
    const err =
      e instanceof NotShown ? new NotSubmitted(`${p.agent} didn't show the text on its screen, so Loom didn't press Enter. The text went to ${ref} and may be waiting there, so don't send it again: loomctl read ${ref} shows it, and loomctl keys ${ref} enter${task ? ` --task ${task.id}` : ""} submits it${task ? ", and the task goes on from there. Anything else written there first ends the task unknown" : ""}.`, true)
      : e instanceof NotSubmitted ? e
      : uncertain === "submit" ? new NotSubmitted(`Loom typed the text into ${ref}, then writing Enter failed (${why}), so it may or may not have gone in. Don't send it again: loomctl read ${ref} shows whether it's still waiting in the input.`, true)
      : new NotSubmitted(`Writing the text into ${ref} failed (${why}), maybe part-way, so some of it may be in the input. Don't send it again before loomctl read ${ref} shows what's there.`, true);
    err.details = details;
    throw err;
  }
  if (task) {
    // From when Loom pressed Enter, a report of its text may be this task's (task.ts route).
    task.submittedAt = steps.entering ?? Date.now();
    // Nothing moved it while its Enter was written: what came then was held, and goes in after.
    // Answered once the journal has it, or `saved: false` says it doesn't.
    const saved = task.state === "accepted" ? moveTask(task, { state: "submitted", signal: "enter", input: task.input }, task.submittedAt) : undefined;
    release();
    await saved;
  }
  return { data: { pane: p.id, generation: gen, sha256: digest, bytes, ...(token ? { receipt: token } : {}), ...(correlationWarning ? { correlationWarning } : {}), ...(task && !submit ? { task: task.id, ...(journalUnreadable ? { saved: false, warning: journalUnavailable() } : {}) } : {}) }, text: token ?? "" };
}

/** A task Loom still has, or a failure saying it isn't available. */
function cliTask(id: string) {
  const t = tasks.get(id);
  if (t) return t;
  throw new CliError(`Task ${id} isn't available. Loom keeps every open task and the last 500 to finish, in its journal across restarts, so it was dropped or this Loom's workspace never issued it.`, { unavailable: true });
}

const taskText = (t: Task) =>
  `${t.id} ${t.state}${t.reason ? ` (${t.reason})` : t.detail ? ` (${t.detail})` : ""} on ${taskLocation(t).ref ?? `closed pane ${t.pane} (was ${t.ref})`}` +
  `${t.correlation ? `, tied by ${t.correlation}` : ""}${t.uncertain ? `, uncertain: ${t.uncertain}` : ""}`;

/** A --state or --until list of task states; `open` is every state not final. */
function taskStates(value: string, what: string): TaskState[] {
  const out: TaskState[] = [];
  for (const w of value.toLowerCase().split(",").map((s) => s.trim())) {
    if (w === "open") out.push(...TASK_STATES.filter((s) => !isFinal(s)));
    else if ((TASK_STATES as readonly string[]).includes(w)) out.push(w as TaskState);
    else throw new Error(`${what} takes ${TASK_STATES.join(", ")} or open, not ${w || "nothing"}.`);
  }
  return out;
}

/** wait --task: until the task is in one of `until`'s states or finished;
 * by default until it finishes or asks for approval. */
async function waitTask(t: Task, upTo: string | undefined, seconds: number, orIdle = false, signal?: AbortSignal) {
  const want = upTo === undefined ? (["approval"] as TaskState[]) : taskStates(upTo, "--until");
  const ended = () => isFinal(t.state) || want.includes(t.state);
  const idle = () => {
    const p = paneById(t.pane);
    return !!p && p.generation === t.gen && ["idle", "waiting"].includes(cliState(p));
  };
  try {
    await until(() => ended() || (orIdle && idle()), seconds, `task ${t.id}`, signal);
  } catch (e) {
    if (e instanceof CliTimeout) e.details = { task: t.id, state: t.state };
    throw e;
  }
  const waitReason = ended() ? "task" : "pane-idle";
  return { data: { ...record(t), ...(orIdle ? { waitReason } : {}) }, text: taskText(t) + (waitReason === "pane-idle" ? " (pane idle; task outcome unchanged)" : "") };
}

function openClose(word: string | undefined, now: boolean, what: string) {
  if (word === undefined) return !now;
  if (word === "open") return true;
  if (word === "close") return false;
  throw new Error(`${what} takes open or close, not ${word}.`);
}

async function windowStep(name: string, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CliTimeout(`Window ${name} timed out after 2 s. Windows may still finish it.`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

const CLI: Record<string, CliCommand> = {
  help: {
    usage: "help [command]",
    help: "List the commands, or show one.",
    run: (a) => {
      const name = a._[0];
      if (name) {
        const c = CLI[name];
        if (!c) throw new Error(`Unknown command "${name}". loomctl help lists them.`);
        return { data: { command: name, usage: c.usage, help: c.help }, text: `loomctl ${c.usage}\n  ${c.help}` };
      }
      return {
        data: Object.entries(CLI).map(([command, c]) => ({ command, usage: c.usage, help: c.help })),
        text: `${table(Object.values(CLI).map((c) => [c.usage, c.help]))}\n\nA pane is <thread>:<n>, its id, or . for the pane in front. A thread is its name or id.\nAdd --json for machine-readable output.`,
      };
    },
  },
  status: {
    usage: "status",
    help: "Counts by state, the thread in front, and every pane waiting for you.",
    run: async () => {
      const panes = threads.flatMap((t) => t.panes);
      await pollProviderUsage(panes);
      const count = Object.fromEntries(CLI_STATES.map((s) => [s, panes.filter((p) => cliState(p) === s).length]));
      const waiting = panes.filter((p) => cliState(p) === "waiting");
      const front = current?.active ?? current?.panes[0];
      return {
        data: { threads: threads.length, panes: panes.length, ...count, front: front ? paneData(front) : null, overview: dashboardOpen, phone: desktopWindow !== undefined, agents: startups.map((s) => s.label), waitingPanes: waiting.map(paneData),
          booted: bootedAt, updated: await invoke<boolean>("exe_updated").catch(() => false) },
        text: [
          `${threads.length} thread${threads.length === 1 ? "" : "s"}, ${panes.length} pane${panes.length === 1 ? "" : "s"}: ` +
            CLI_STATES.filter((s) => count[s]).map((s) => `${count[s]} ${s}`).join(", "),
          front ? `In front: ${paneName(front)} (${front.agent}, ${cliState(front)})` : "Nothing in front.",
          ...(waiting.length ? ["", "Waiting for you:", paneRows(waiting)] : []),
        ].join("\n"),
      };
    },
  },
  relaunch: {
    usage: "relaunch [--yes] [--booted <ms>]",
    help: "Restart Loom: it closes as closing its window does, then starts again, after an update the new version. Every pane comes back, agents in their sessions. A pane working on something stops, so with one working it wants --yes. status says updated: true while an update waits for this. --booted restarts only the Loom that started then (status's booted): a retry that reaches the Loom that replaced it restarts nothing.",
    options: { yes: "bool", booted: "string" },
    run: (a) => {
      // A retried request whose key died with the Loom it restarted: this one is its replacement.
      if (a.booted !== undefined && a.booted !== String(bootedAt)) return { data: { stopping: [], booted: bootedAt }, text: `The Loom that started at ${a.booted} has already restarted; this one keeps running.` };
      if (windowClosing) throw new Error("Loom is closing, so it won't restart. Start it again once it has closed.");
      const busy = working().map(paneName);
      if (busy.length && !flag(a, "yes")) throw new Error(`${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working: a restart stops ${busy.length === 1 ? "it" : "them"}. Add --yes.`);
      // After this answer has gone out.
      setTimeout(relaunch, 300);
      return { data: { stopping: busy, booted: bootedAt }, text: "Loom is restarting." };
    },
  },
  usage: {
    usage: "usage [claude|codex] [--refresh]",
    help: "Read account plan usage, even with plan-usage off. All callers share a fetch and a five-minute cache; --refresh skips the five minutes, as the PC's refresh button does, but not a rate limit's cooldown. Rate limits can extend the cooldown, including Codex reset-credit detail failures after primary usage succeeds. A note identifies unavailable expiry details. JSON includes fetchedAt, nextRefreshAt and cached. Reset times and banked expiries are UTC ISO timestamps or null. Omit the provider for both. --json includes limits, stale status, banked resets and expiry dates when available; errors are per provider and omit provider bodies and curl diagnostics. Does not enable background polling.",
    options: { refresh: "bool" },
    run: async (a) => {
      const name = a._[0];
      if (a._.length > 1 || (name !== undefined && name !== "claude" && name !== "codex")) throw new Error("usage takes claude or codex, or neither for both.");
      const data: Partial<Record<PlanProvider, Plan | { error: string }>> = {};
      for (const provider of (name ? [name] : ["claude", "codex"]) as PlanProvider[]) {
        try { data[provider] = await accountPlan(provider, flag(a, "refresh")); }
        catch (e) { data[provider] = { error: String(e) }; }
      }
      return { data, text: Object.entries(data).map(([provider, p]) => `${provider}: ${JSON.stringify(p)}`).join("\n") };
    },
  },
  threads: {
    usage: "threads",
    help: "Every thread: name, id, state, pane count, branch and folder. --json includes zoomed, the zoomed pane ID or null, independently of front; nested panes have a zoomed boolean.",
    run: async () => {
      await pollProviderUsage();
      return {
      data: threads.map(threadData),
      text: threads.length
        ? table(threads.map((t) => [t === current ? "*" : " ", t.name, t.id, threadState(t), `${t.panes.length} pane${t.panes.length === 1 ? "" : "s"}`, t.branch || "-", t.dir]))
        : "No threads. loomctl new <folder> opens one.",
      };
    },
  },
  panes: {
    usage: "panes [--thread T] [--state S]",
    help: "Every pane: its <thread>:<n>, id, agent, state and title. --json also includes a zoomed boolean and model, effort and context (usedTokens, windowTokens, remainingTokens, remainingPercent), or null when unavailable. Uses Claude and Codex session records, with explicit startup model and effort as fallbacks. Invalid identifiers, efforts and recognizable secrets are omitted, including restored settings. Codex settings persist across large tool results. Pane, thread and status reads refresh selected Codex sessions even while minimized, sharing concurrent fetches with a two-second wait limit. OpenCode has startup selections only; unavailable context stays null.",
    options: { thread: "string", state: "string" },
    run: async (a) => {
      const want = a.state === undefined ? null : cliStates(str(a, "state"), "");
      const thread = str(a, "thread");
      const panes = (thread === undefined ? threads : [cliThread(thread, true)])
        .flatMap((t) => t.panes)
        .filter((p) => !want || want.includes(cliState(p)));
      await pollProviderUsage(panes);
      return { data: panes.map(paneData), text: panes.length ? paneRows(panes) : "No panes." };
    },
  },
  read: {
    usage: "read [pane] [--lines N] [--styles] [--menu]",
    help: "The pane's screen as text, or its last N lines including history. --json adds the cursor and what the input holds: a draft, a suggestion, empty or unknown, with a revision for send --input. --styles adds the rows with their styles: the screen's, or with --lines those N lines'. --menu adds menu, what menu answers for the pane, in the same read. JSON alt is true while a full-screen app such as OpenCode holds the screen.",
    options: { lines: "int", styles: "bool", menu: "bool" },
    run: (a) => {
      const p = cliPane(a._[0], true);
      let raw: string, from: number | undefined, to: number | undefined;
      if (a.lines === undefined) raw = liveScreen(p);
      else {
        const tail = tailLines(p, num(a, "lines", 50, 1, 100_000));
        raw = tail.lines.join("\n");
        [from, to] = [tail.from, tail.to];
      }
      const text = raw.split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
      const buf = p.term.buffer.active;
      const cursor = { x: buf.cursorX, y: buf.cursorY, hidden: p.cursorHidden };
      return { data: { pane: p.id, ref: paneName(p), text, cursor, cols: p.term.cols, alt: buf.type === "alternate", input: inputState(p),
        ...(flag(a, "styles") ? { rows: styledRows(p, from, to) } : {}), ...(flag(a, "menu") ? { menu: paneMenu(p) } : {}) }, text };
    },
  },
  menu: {
    usage: "menu [pane]",
    help: "The numbered question on a pane's screen, including Claude's active session survey below the composer. Wrapped questions are supported. Quoted or dismissed surveys are not actionable. Survey keys are 1, 2, 3 and 0; selected is -1 because none is highlighted.",
    run: (a) => {
      const p = cliPane(a._[0], true);
      const m = paneMenu(p);
      if (!m) return { data: null, text: `${paneName(p)} isn't showing a numbered question.` };
      // The whole prompt, which the id covers, not just the summary above the options.
      const note = `(${m.selected < 0 ? "Press a listed digit" : `${m.selected + 1} is highlighted`}. Menu ${m.rev}: choose --menu ${m.rev} answers only this question.)`;
      return { data: m, text: [...m.prompt, note].join("\n") };
    },
  },
  show: {
    usage: "show <thread|pane>",
    help: "Bring a thread or a pane to the front.",
    run: (a) => {
      const sel = cliWord(a, 0, "a thread or pane");
      const ref = paneRef(sel);
      const isPane = "thread" in ref || threads.some((t) => t.panes.some((p) => p.id === sel));
      if (isPane) {
        const p = cliPane(sel, true);
        revealPane(p);
        return { data: paneData(p), text: `In front: ${paneName(p)}` };
      }
      const th = cliThread(sel, true);
      show(th);
      return { data: threadData(th), text: `In front: ${th.name}` };
    },
  },
  seen: {
    usage: "seen <pane>",
    help: "Clear a pane's waiting state, as clicking it on the PC does, without bringing it to the front.",
    run: (a) => {
      const p = cliPane(cliWord(a, 0, "a pane"));
      p.seen();
      return { data: paneData(p), text: `${paneName(p)} is ${cliState(p)}` };
    },
  },
  next: {
    usage: "next",
    help: "Go to the next agent waiting for you, as F3 does.",
    run: () => {
      if (!threads.some((t) => t.panes.some((p) => p.waiting))) return { data: null, text: "Nobody is waiting." };
      jumpWaiting();
      const p = current?.active;
      return { data: p ? paneData(p) : null, text: p ? `In front: ${paneName(p)}` : "" };
    },
  },
  overview: {
    usage: "overview [open|close]",
    help: "Open, close or toggle the Overview.",
    run: (a) => {
      toggleDashboard(openClose(a._[0], dashboardOpen, "overview"));
      return { data: { open: dashboardOpen }, text: `Overview ${dashboardOpen ? "open" : "closed"}` };
    },
  },
  changes: {
    usage: "changes [open|close]",
    help: "Open, close or toggle the Changes panel.",
    run: (a) => {
      toggleChanges(openClose(a._[0], changesOpen, "changes"));
      return { data: { open: changesOpen }, text: `Changes ${changesOpen ? "open" : "closed"}` };
    },
  },
  git: {
    usage: "git <thread> [status [--commits N] | diff [path...] [--staged|--untracked] [--full] | show <sha> [--full] | files | file <path> | stage|unstage|discard [path...] [--unstaged|--staged|--untracked] | apply - [--cached] [--reverse] | commit <message...> [--staged] [--push] | amend [message...] | undo | push | pull | fetch | force-push | pr | branches | switch <name> [--create] | stashes | stash | stash-apply <stash> | stash-drop <stash> | revert <sha> | reset <sha> --soft|--hard | continue | skip | abort | resolve ours|theirs <path...>] [--yes]",
    help: "The Changes panel from the command line, with git's own commands as the panel runs them. Bare or status: the branch, its upstream and how far apart, a half-done merge, revert or rebase, the unstaged, staged and untracked files with their +/- counts, and the last 10 commits, or --commits N of them, with moreCommits true when git has older ones. diff and show print a diff (--full: whole files); files lists the thread's files and file prints one. stage, unstage and discard take paths, or a whole section. apply - takes a hunk's patch on standard input. commit commits everything, or with --staged only the index, and --push pushes after. pr pushes and gives GitHub's compare page. What can lose work wants --yes: discard, apply --reverse without --cached, amend, undo, force-push, stash-drop, reset, abort and skip. A change answers with the status after it, --commits counting there too.",
    options: { staged: "bool", unstaged: "bool", untracked: "bool", full: "bool", cached: "bool", reverse: "bool", push: "bool", create: "bool", soft: "bool", hard: "bool", yes: "bool", commits: "int" },
    run: async (a) => {
      const th = cliThread(cliWord(a, 0, "a thread"));
      const [what = "status", ...rest] = a._.slice(1);
      const commits = num(a, "commits", 10, 1, 100_000);
      const run = (...args: string[]) => git(th.dir, ...args);
      const sure = (why: string) => {
        if (!flag(a, "yes")) throw new Error(`${why} Add --yes to go ahead.`);
      };
      const word = (i: number, name: string) => {
        if (!rest[i]) throw new Error(`git ${what} needs ${name}.`);
        return rest[i];
      };
      const summary = (g: GitStatus) => [
        `${g.branch || "(no branch)"} ${upstreamLabel(g.upstream, `${g.behind}\t${g.ahead}`)}${g.midway ? `  (${g.midway} in progress)` : ""}`,
        ...(["staged", "unstaged", "untracked"] as const).flatMap((sec) => g[sec].map((c) => `${sec === "staged" ? c.x : sec === "untracked" ? "?" : c.y} ${c.path}  +${c.add} -${c.del}${sec === "staged" ? "  (staged)" : ""}`)),
      ].join("\n");
      // After a change: the branch may have moved, and the panel and sidebar show it.
      const changed = async (text: string) => {
        th.branch = await headBranch(th);
        th.setStat(th.changed);
        save();
        if (th === current && changesOpen) void refreshChanges();
        return { data: await gitStatus(th, commits), text };
      };
      switch (what) {
        case "status": {
          const g = await gitStatus(th, commits);
          return { data: g, text: summary(g) };
        }
        case "diff": {
          const sec: Sec = flag(a, "staged") ? "staged" : flag(a, "untracked") ? "untracked" : "unstaged";
          const paths = rest.length ? rest : (await gitStatus(th))[sec].map((c) => c.path);
          const diff = paths.length ? await diffOf(th, sec, paths, flag(a, "full"))() : "";
          return { data: { diff }, text: diff };
        }
        case "show": {
          const diff = await gitPreview(th.dir, [], "show", "--stat", "--patch", ...(flag(a, "full") ? ["-U999999"] : []), word(0, "a commit"));
          return { data: { diff }, text: diff };
        }
        case "files": {
          const out = await run("ls-files", "-z", "--cached", "--others", "--exclude-standard").catch(() => null);
          const files = out === null ? await invoke<string[]>("list_files", { dir: th.dir }) : out.split("\0").filter(Boolean);
          return { data: { files }, text: files.join("\n") };
        }
        case "file": {
          const text = await invoke<string>("read_file", { dir: th.dir, path: rest.join(" ") || word(0, "a path") });
          return { data: { text }, text };
        }
        case "stage":
        case "unstage":
        case "discard": {
          const act = what as Act;
          if (act === "discard") sure("Discarding throws the changes away.");
          const g = await gitStatus(th);
          const picked: Sec[] = (["unstaged", "staged", "untracked"] as const).filter((sec) => flag(a, sec));
          const secs: Sec[] = picked.length ? picked : act === "unstage" ? ["staged"] : ["unstaged", "untracked"];
          let n = 0;
          for (const sec of secs) {
            const files = g[sec].filter((c) => !rest.length || rest.includes(c.path));
            n += files.length;
            for (const args of gitAct(sec, act, files)) await run(...args);
          }
          if (!n) throw new Error(`Nothing to ${act}${rest.length ? ` in ${rest.join(", ")}` : ""}.`);
          return changed(`${act === "stage" ? "Staged" : act === "unstage" ? "Unstaged" : "Discarded"} ${n} file${n === 1 ? "" : "s"}`);
        }
        case "apply": {
          const patch = rest.join(" ");
          if (!patch.trim()) throw new Error("git apply reads the hunk's patch: loomctl git <thread> apply - < hunk.patch");
          if (flag(a, "reverse") && !flag(a, "cached")) sure("Applying in reverse throws that hunk away.");
          const args = ["apply", ...(flag(a, "cached") ? ["--cached"] : []), ...(flag(a, "reverse") ? ["--reverse"] : [])];
          await invoke("git_stdin", { dir: th.dir, args, patch: patch.endsWith("\n") ? patch : patch + "\n" });
          return changed("Applied");
        }
        case "commit": {
          const message = rest.join(" ").trim();
          if (!message) throw new Error("Give the commit message.");
          if (!flag(a, "staged")) await run("add", "-A");
          await run("commit", "-m", message);
          // The PC's box empties only if this was its message: one typed there for later stays.
          if (th.commitDraft.trim() === message) usedDraft(th, th.commitDraft);
          if (flag(a, "push")) await run("push", "-u", "origin", "HEAD");
          return changed(flag(a, "push") ? "Committed and pushed" : "Committed");
        }
        case "amend": {
          sure("Amending rewrites the last commit.");
          const message = rest.join(" ").trim();
          await run("commit", "--amend", ...(message ? ["-m", message] : ["--no-edit"]));
          return changed("Amended");
        }
        case "undo":
          sure("Undoing the last commit brings its changes back as staged work.");
          await run("reset", "--soft", "HEAD~1");
          return changed("Undid the last commit");
        case "push":
          await run("push", "-u", "origin", "HEAD");
          return changed("Pushed");
        case "pull":
          await run("pull", "--rebase", "--autostash");
          return changed("Pulled");
        case "fetch":
          await run("fetch", "--all", "--prune");
          return changed("Fetched");
        case "force-push":
          sure(`Force-pushing overwrites the remote ${th.branch} unless someone pushed since you last fetched.`);
          await run("push", "--force-with-lease");
          return changed("Force-pushed");
        case "pr": {
          const url = await prUrl(th);
          return { data: { url, ...(await gitStatus(th)) }, text: url };
        }
        case "branches": {
          await syncBranch(th);
          const out = await run("branch", "--format=%(refname)", "--sort=-committerdate").catch(() => "");
          const branches = out.split(/\r?\n/).filter((b) => b.startsWith("refs/heads/")).map((b) => b.slice("refs/heads/".length)).slice(0, 40);
          return { data: { current: th.branch, branches }, text: branches.map((b) => (b === th.branch ? `* ${b}` : `  ${b}`)).join("\n") };
        }
        case "switch":
          await run("switch", ...(flag(a, "create") ? ["-c"] : []), word(0, "a branch"));
          return changed(`On ${rest[0]}`);
        // A stash by its commit, as stashes lists it: another worktree's stash
        // takes stash@{0} from it (stash.ts). A place is read once, now.
        case "stashes": {
          const stashes = await listStashes(run).catch(() => []);
          return { data: { stashes }, text: stashes.map((x) => `${x.ref}  ${x.sha.slice(0, 10)}  ${x.message}`).join("\n") };
        }
        case "stash":
          await run("stash", "push", "-u", "-m", `loom ${th.name}`);
          return changed("Stashed");
        case "stash-apply":
          await applyStash(run, await stashCommit(run, word(0, "a stash")));
          return changed("Stash applied");
        case "stash-drop":
          sure(`Dropping ${rest[0] ?? "a stash"} deletes it.`);
          await invoke("stash_drop", { dir: th.dir, sha: await stashCommit(run, word(0, "a stash")) });
          return changed("Stash dropped");
        case "revert":
          await run("-c", "core.editor=true", "revert", "--no-edit", word(0, "a commit"));
          return changed("Reverted");
        case "reset": {
          const how = flag(a, "hard") ? "--hard" : flag(a, "soft") ? "--soft" : "";
          if (!how) throw new Error("git reset takes --soft (keep the changes, staged) or --hard (lose them).");
          sure(how === "--hard" ? "A hard reset loses every change after that commit." : "A soft reset moves the branch back.");
          await run("reset", how, word(0, "a commit"));
          return changed("Reset");
        }
        case "continue":
        case "skip":
        case "abort": {
          const midway = await invoke<string>("git_midway", { dir: th.dir }).catch(() => "");
          if (!midway) throw new Error("git isn't in the middle of a merge, revert or rebase.");
          if (what === "abort") sure(`Aborting the ${midway} throws away the conflicts resolved so far.`);
          if (what === "skip") sure("Skipping drops this commit from the rebase.");
          if (what === "abort") await run(midway, "--abort");
          else if (what === "skip") {
            if (midway !== "rebase") throw new Error("Only a rebase can skip a commit.");
            await run("rebase", "--skip");
          } else await run("-c", "core.editor=true", ...(midway === "merge" ? ["commit", "--no-edit"] : [midway, "--continue"]));
          return changed(`${midway} ${what === "abort" ? "aborted" : what === "skip" ? "skipped a commit" : "continued"}`);
        }
        case "resolve": {
          const side = word(0, "ours or theirs");
          if (side !== "ours" && side !== "theirs") throw new Error(`Resolve with ours or theirs, not ${side}.`);
          const paths = rest.slice(1);
          if (!paths.length) throw new Error("Name the files to resolve.");
          for (const args of resolveArgs(side, paths)) await run(...args);
          return changed(`Resolved ${paths.length} with ${side}`);
        }
        default:
          throw new Error(`git doesn't know "${what}". loomctl help git lists what it does.`);
      }
    },
  },
  messages: {
    usage: "messages [pane...]",
    help: "What each agent last heard and said, as the Overview shows it: the last prompt and the last answer from its session's transcript, each cut at 500 characters. Shells have none.",
    run: async (a) => {
      const panes = (a._.length ? a._.map((sel) => cliPane(sel, true)) : threads.flatMap((t) => t.panes)).filter((p) => p.agent !== "shell" && dashboardSession(p));
      const got: Record<string, DashboardMessages> = {};
      // An opencode export takes seconds: each runs alone, the rest together.
      const batches = [panes.filter((p) => p.agent !== "opencode"), ...panes.filter((p) => p.agent === "opencode").map((p) => [p])];
      await Promise.all(batches.filter((b) => b.length).map(async (batch) => Object.assign(got, await invoke<Record<string, DashboardMessages>>("last_messages", {
        panes: batch.map((p) => [claudeMarker(p), opencodeCommand(p.startup) || p.agent, p.th.dir, dashboardSession(p)]),
      }).catch(() => ({})))));
      const data = panes.map((p) => ({ pane: p.id, ref: paneName(p), user: got[claudeMarker(p)]?.user ?? "", agent: got[claudeMarker(p)]?.agent ?? "" }));
      return { data, text: data.map((m) => `${m.ref}\n  you: ${m.user}\n  agent: ${m.agent}`).join("\n") };
    },
  },
  context: {
    usage: "context [pane]",
    help: "A Claude pane's context, as its gauge's panel shows it: tokens by kind, the size after each turn, and where it was compacted.",
    run: async (a) => {
      const p = cliPane(a._[0], true);
      if (p.agent !== "claude") throw new Error(`${paneName(p)} isn't a Claude pane: only Claude's transcript says this.`);
      const profile = await invoke<Profile | null>("context_profile", { pane: claudeMarker(p), dir: p.th.dir, sid: p.sid });
      if (!profile) throw new Error(`${paneName(p)} has no transcript to read yet.`);
      return { data: { pane: p.id, ref: paneName(p), ...profile }, text: profile.buckets.map((b) => `${b.label}  ${b.tokens}`).join("\n") };
    },
  },
  startups: {
    usage: "startups [add <label> <command...> | remove <label>]",
    help: "The agents and terminals the + menu offers, which new and add --agent pick from: list them, add one, or remove one. One of Loom's own added by its label alone, as powershell, comes back as it was.",
    run: (a) => {
      const [how, label, ...cmd] = a._;
      if (how === "add") {
        if (!label) throw new Error("Name the new entry.");
        if (startups.some((x) => x.label === label)) throw new Error(`There is already a "${label}".`);
        startups.push(cmd.length ? { label, cmd: cmd.join(" ") } : typedStartup(label));
        save();
      } else if (how === "remove") {
        const i = startups.findIndex((x) => x.label === label);
        if (i < 0) throw new Error(`No "${label ?? ""}" in the list.`);
        startups.splice(i, 1);
        save();
      } else if (how !== undefined) throw new Error(`startups takes add or remove, not ${how}.`);
      return { data: startups.map((x) => ({ label: x.label, cmd: x.cmd })), text: table(startups.map((x) => [x.label, x.cmd])) };
    },
  },
  dictation: {
    usage: "dictation [lang <code|auto> | prefix [text...] [--enter on|off] | remove lang <code> | remove prefix [text...]]",
    help: "The mic's languages and prefixes, as its menu lists them, and which of each dictation uses: the PC's F4 and the phone's mic alike. lang and prefix pick one, adding it if new (a prefix with no text is none), and --enter says whether that prefix sends what was said. remove drops one; the last of each stays.",
    options: { enter: "string" },
    run: (a) => {
      const [how, ...rest] = a._;
      const words = rest.join(" ").trim();
      const enter = str(a, "enter");
      if (enter !== undefined && (how !== "prefix" || !/^(on|off)$/.test(enter))) throw new Error("--enter is on or off, for dictation prefix.");
      // A language by its code or its label; auto is the one whisper detects per clip.
      const findLang = (w: string) => langs.find((l) => l.code === (w.toLowerCase() === "auto" ? "" : w.toLowerCase()) || l.label.toLowerCase() === w.toLowerCase());
      const findPrefix = (w: string) => prefixes.find((p) => p.text.trim() === w);
      if (how === "lang") {
        if (!words) throw new Error("Name the language: a whisper code such as fr, or auto.");
        let l = findLang(words);
        if (!l) {
          if (!/^[a-z]{2,8}$/i.test(words)) throw new Error(`${words} isn't a whisper language code, such as fr, ar or ja.`);
          langs.push((l = { label: words.toLowerCase(), code: words.toLowerCase() }));
        }
        lang = l;
      } else if (how === "prefix") {
        // It is typed into the pane on the PC: one line, nothing that presses a key.
        if (/[\x00-\x1f\x7f]/.test(rest.join(" ")) || words.length > 200) throw new Error("A prefix is one line of text.");
        let p = findPrefix(words);
        // Trailing space or the transcript runs into the command name, as the menu adds it.
        if (!p) prefixes.push((p = { text: words ? `${words} ` : "", enter: false }));
        if (enter) p.enter = enter === "on";
        prefix = p;
      } else if (how === "remove") {
        const [what, ...name] = rest;
        const w = name.join(" ").trim();
        if (what === "lang" || what === "prefix") {
          const list: (Lang | Prefix)[] = what === "lang" ? langs : prefixes;
          const gone = what === "lang" ? (w ? findLang(w) : undefined) : findPrefix(w);
          if (!gone) throw new Error(`No ${what === "lang" ? "language" : "prefix"} "${w}" in the list. loomctl dictation lists them.`);
          if (list.length === 1) throw new Error(`The last ${what === "lang" ? "language" : "prefix"} stays: dictation needs one.`);
          list.splice(list.indexOf(gone), 1);
          if (lang === gone) lang = langs[0];
          if (prefix === gone) prefix = prefixes[0];
        } else throw new Error("dictation remove takes lang or prefix.");
      } else if (how !== undefined) throw new Error(`dictation takes lang, prefix or remove, not ${how}.`);
      if (how !== undefined) {
        save();
        paintLang();
        paintPrefix();
      }
      return dictationData();
    },
  },
  vscode: {
    usage: "vscode [thread]",
    help: "Open a thread's folder in VS Code on this PC.",
    run: async (a) => {
      const th = cliThread(a._[0], true);
      await invoke("open_vscode", { dir: th.dir });
      return { data: { thread: th.id }, text: `VS Code: ${th.dir}` };
    },
  },
  layout: {
    usage: "layout <cols|rows|grid> [--thread T]",
    help: "How a thread arranges its panes.",
    options: { thread: "string" },
    run: (a) => {
      const mode = cliWord(a, 0, "a layout: cols, rows or grid") as LayoutMode;
      if (!LAYOUTS.includes(mode)) throw new Error(`layout takes cols, rows or grid, not ${mode}.`);
      const th = cliThread(str(a, "thread"), true);
      th.layout = mode;
      th.relayout();
      if (th === current) paintLayout(mode);
      save();
      return { data: threadData(th), text: `${th.name}: ${mode}` };
    },
  },
  zoom: {
    usage: "zoom [pane]",
    help: "Let a pane fill its thread, or put it back.",
    run: (a) => {
      const p = cliPane(a._[0], true);
      p.th.toggleZoom(p);
      const zoomed = p.th.zoomed === p;
      return { data: { pane: p.id, zoomed }, text: `${paneName(p)} ${zoomed ? "zoomed" : "back in the grid"}` };
    },
  },
  new: {
    usage: "new <folder> [--agent A | --cmd C | --mix JSON] [--model M] [--effort E] [--name N] [--base B] [--panes N]",
    help: "Open an existing folder as a thread, using its canonical path. Invalid folders are refused before startup. --name or --base requires Git and cuts a new worktree; --base alone also supplies its name. A relative folder is relative to your terminal. --model selects an agent model; --effort selects Claude/Codex effort. Both refuse --cmd, and the agent validates support. --mix starts several startups at once, agents first, as the New thread form does: {\"claude\":2,\"PowerShell\":1}. It takes the place of --agent, --cmd, --model, --effort and --panes.",
    options: { agent: "string", cmd: "string", mix: "string", model: "string", effort: "string", name: "string", base: "string", panes: "int" },
    run: async (a, ctx) => {
      // Everything checked before git runs: nothing may be left behind by a bad argument.
      const folder = await invoke<string>("canonical_directory", { path: callerPath(cliWord(a, 0, "a folder"), ctx.cwd) });
      const mix = str(a, "mix");
      if (mix !== undefined && ["agent", "cmd", "model", "effort", "panes"].some((k) => a[k] !== undefined)) throw new Error("--mix takes the place of --agent, --cmd, --model, --effort and --panes.");
      // createThread refuses an empty or oversize list before it makes anything.
      const panes = mix !== undefined ? cliMix(mix) : Array<PaneState>(num(a, "panes", 1, 1, MAX_PANES)).fill({ cmd: cliCommand(a), startupSettings: { model: str(a, "model"), effort: str(a, "effort") } });
      const name = str(a, "name") ?? "", base = str(a, "base") ?? "";
      const top = name || base ? await git(folder, "rev-parse", "--show-toplevel").catch(() => {
        throw new Error(`${folder} isn't in a Git repository.`);
      }) : folder;
      const repo = top.trim().replace(/\//g, "\\");
      const th = await createThread(repo, name, panes, base);
      const failed = th.panes.filter((p) => p.dead);
      if (failed.length) throw new Error(`Opened ${th.name}, but ${failed.map(paneName).join(", ")} didn't start. The pane shows why.`);
      return { data: threadData(th), text: `${th.name} (${th.id}) in ${th.dir}`, note: `loomctl opened ${th.name}` };
    },
  },
  add: {
    usage: "add [thread] [--agent A | --cmd C] [--model M] [--effort E]",
    help: "Start another agent or terminal in a thread and bring it to the front. --model selects an agent model; --effort selects Claude/Codex effort. Both refuse --cmd, and the agent validates support.",
    options: { agent: "string", cmd: "string", model: "string", effort: "string" },
    run: async (a) => {
      const th = cliThread(a._[0]);
      if (th.panes.length >= MAX_PANES) throw new Error(`${th.name} already has ${MAX_PANES} panes.`);
      const cmd = cliCommand(a);
      if (th.open === false) th.open = undefined; // the pane you add is one you want to see
      th.tab = null;
      show(th);
      const p = await th.addPane({ cmd, startupSettings: { model: str(a, "model"), effort: str(a, "effort") } });
      if (!p) throw new Error(`Loom didn't start the pane in ${th.name}.`);
      revealPane(p);
      save();
      if (p.dead) throw new Error(`${paneName(p)} (${p.id}) didn't start. The pane shows why.`);
      return { data: paneData(p), text: `${paneName(p)} (${p.id}): ${p.agent}`, note: `loomctl started ${p.agent} in ${th.name}` };
    },
  },
  rename: {
    usage: "rename <thread> <name>",
    help: "Rename a thread. Its branch and folder keep their names.",
    run: (a) => {
      const th = cliThread(cliWord(a, 0, "a thread"));
      const name = a._.slice(1).join(" ").trim();
      if (!name) throw new Error("Give the new name.");
      th.rename(name);
      return { data: threadData(th), text: `Renamed to ${name}` };
    },
  },
  send: {
    usage: "send <pane> <text...> [--no-enter] [--gen N] [--receipt] [--input REV] [--replace]",
    help: "Type text into a pane and press Enter once it shows there. - reads the text from standard input. --gen N (a pane's generation from loomctl panes) refuses a pane that restarted since. --receipt prints a token for loomctl wait --receipt and loomctl receipt: a shell's command (at Loom's PowerShell prompt; a comment carries the token) or an agent's next turn. --input REV (from read --json) types nothing if anyone wrote to the pane or its input changed since that read. --replace types only over an empty input or a suggestion, never a draft, and presses Enter only if none of the suggestion is left.",
    options: { "no-enter": "bool", gen: "int", receipt: "bool", input: "string", replace: "bool" },
    run: (a, ctx) => sendText(a, ctx),
  },
  submit: {
    usage: "submit <pane> <text...> [--gen N] [--input REV]",
    help: "Hand a pane a task and get its id back once Enter went in: loomctl task, wait --task and watch follow it from accepted to completed, failed, cancelled or unknown. - reads the text from standard input. send's checks, and it refuses a question on screen or a draft in the input; --gen and --input as send's. With --key, a retry gets the same task back, even after Loom restarts.",
    options: { gen: "int", input: "string" },
    run: async (a, ctx) => {
      if (journalUnreadable) throw new Error(`Loom couldn't read its task journal when it started (${journalUnreadable}), so it can't tell a retried --key from a new task, and typed nothing. Fix or move the file and restart Loom.`);
      // The journal keeps keys across restarts; the --key cache only until Loom exits.
      const earlier = ctx.key ? [...tasks.values()].find((t) => t.key === ctx.key) : undefined;
      if (earlier) {
        if (earlier.what !== (ctx.what ?? null)) throw new Error(`--key ${ctx.key} was used for task ${earlier.id}, a different request, so this one didn't run.`);
        return { data: record(earlier), text: earlier.id, replayed: true };
      }
      const submit: { task?: Task } = {};
      await sendText(a, ctx, submit);
      return { data: record(submit.task!), text: submit.task!.id };
    },
  },
  keys: {
    usage: "keys <pane> <key...> [--text] [--gen N] [--task ID]",
    help: "Press keys in a pane: enter, esc, tab, shift-tab, up, down, left, right, home, end, pageup, pagedown, insert, delete, backspace, space, f1 to f12, or a single character, each with any of ctrl-, alt- and shift- before it (ctrl-c, alt-enter, ctrl-shift-left). ctrl-u clears input before the cursor in agents that support it; use read to check the draft afterward. --text types the words as they are, joined by spaces, in one write: loomctl keys <pane> --text - reads them from standard input. It sends no Enter. --gen N refuses a pane that restarted since. A lone enter on a pane where submit typed a task's text but held back its Enter, with nothing written there since, is that task's Enter: the task goes on from there. --task ID insists on it, and presses nothing if it can't be.",
    options: { gen: "int", task: "string", text: "bool" },
    run: async (a) => {
      const p = cliPane(cliWord(a, 0, "a pane (. for the one in front)"));
      const text = flag(a, "text");
      const names = text ? [a._.slice(1).join(" ")] : a._.slice(1);
      if (!names.join("")) throw new Error(text ? "Give the text to type." : "Name the keys to press.");
      const enter = !text && names.length === 1 && names[0] === "enter", id = str(a, "task");
      if (id !== undefined && !enter) throw new Error("--task goes with a lone enter: loomctl keys <pane> enter --task ID.");
      const bytes = text ? names : names.map((n) => {
        const b = keyBytes(n, p.term.modes.applicationCursorKeysMode);
        if (b === null) throw new Error(`Unknown key "${n}". To type text, use loomctl send --no-enter.`);
        return b;
      });
      if (p.dead) throw new Error(`${paneName(p)} has exited.`);
      const gen = cliGen(a) ?? p.generation;
      let pressed = 0, task: Task | undefined;
      try {
        await inTurn(p, async (live) => {
          // Checked in the pane's turn, with nothing awaited before the Enter's write.
          if (enter && (task = heldTask(p, id))) return enterTask(p, task);
          for (const b of bytes) {
            live(pressed > 0);
            await keys(p, b);
            pressed++;
            await p.settle(60, 500);
          }
        }, gen);
      } catch (e) {
        // Keys already pressed did what they do (an Enter may have run a command), so say which.
        if (!(e instanceof NotSubmitted) || !pressed) throw e;
        throw new NotSubmitted(`${p.agent} ${changed(p, gen)} after ${pressed} of ${names.length} keys (${names.slice(0, pressed).join(" ")}); the rest weren't pressed.`, false, pressed);
      }
      return { data: { pane: p.id, keys: names, ...(task ? { task: task.id } : {}) }, text: task ? task.id : "" };
    },
  },
  choose: {
    usage: "choose <pane> <n> [--menu REV] [--gen N]",
    help: "Pick option n of the numbered question on a pane's screen. For Claude's survey, use its digit, including 0 to dismiss, without Enter. --menu REV (from loomctl menu) refuses any other question; --gen N a pane that restarted since.",
    options: { menu: "string", gen: "int" },
    run: async (a) => {
      const p = cliPane(cliWord(a, 0, "a pane (. for the one in front)"));
      const n = Number(cliWord(a, 1, "an option number"));
      const screen = liveScreen(p, false);
      const m = readMenu(screen, p.agent) ?? (p.agent === "claude" ? readSurvey(liveScreen(p, true, true)) : null);
      if (!m) throw new Error(`${paneName(p)} isn't showing a numbered question.`);
      const rev = menuRev(m), expect = str(a, "menu");
      if (expect !== undefined && expect !== rev) throw new Error(`${paneName(p)} shows another question now (menu ${rev}, not ${expect}), so nothing was chosen. loomctl menu ${paneName(p)} reads it.`);
      const i = m.keys ? m.keys.indexOf(String(n)) : n - 1;
      if (!Number.isInteger(n) || i < 0 || i >= m.options.length) throw new Error(`Pick ${m.keys?.join(", ") ?? `1 to ${m.options.length}`}.`);
      await choose(p, m, i, cliGen(a));
      return { data: { pane: p.id, option: n, text: m.options[i], rev }, text: `Chose ${n}. ${m.options[i]}` };
    },
  },
  wait: {
    usage: "wait [pane] [--state waiting] [--until S] [--turn-after N [--gen N]] [--receipt R] [--task ID [--until S] [--or-idle]] [--timeout S]",
    help: "Block until a pane is in a state: waiting (the default), working, idle or exited. Several: --state idle,waiting. --until S, on a pane: until it has settled there, as watch --panes reports it: in that state for 2 s, so a pause between tool calls doesn't count as idle. It returns at once if the pane already settled there; after a send, wait --task with the id send printed waits for that turn. --turn-after N: until an agent finishes turn N+1 (turns in loomctl panes). --receipt R: until the command or turn behind send --receipt's token finishes. If task-end abandons held Enter, the wait stops with an explicit no-outcome error. --task ID: until a task finishes or asks for approval, or reaches --until S. --or-idle also returns when that task's same pane generation is idle or waiting, even if already idle; waitReason is task or pane-idle. It does not settle the task or prove completion.",
    options: { state: "string", "turn-after": "int", gen: "int", receipt: "string", task: "string", until: "string", "or-idle": "bool" },
    run: async (a, ctx) => {
      const id = str(a, "task");
      if (id !== undefined) return waitTask(cliTask(id), str(a, "until"), ctx.seconds, flag(a, "or-idle"), ctx.signal);
      if (a["or-idle"] !== undefined) throw new Error("--or-idle is for --task.");
      const settle = str(a, "until");
      if (settle !== undefined) {
        if (a.state !== undefined || a["turn-after"] !== undefined || a.receipt !== undefined) throw new Error("--until goes with a pane or --task alone: loomctl wait <pane> --until idle.");
        const p = cliPane(a._[0], true), want = cliStates(settle, "", "--until");
        // Settled there, with no other state counting down.
        const there = () => want.includes(p.settler.settled ?? "") && cliState(p) === p.settler.settled;
        await until(() => gone(p) || there(), ctx.seconds, `${paneName(p)} to settle ${want.join(" or ")}`, ctx.signal);
        if (gone(p)) throw new Error("The pane was closed.");
        const event = [...paneEvents.events].reverse().find((e) => e.pane === p.id) ?? null;
        return { data: { ...paneData(p), event }, text: `${paneName(p)} is ${cliState(p)}` };
      }
      const token = str(a, "receipt");
      if (token !== undefined) return waitReceipt(token, ctx.seconds, ctx.signal);
      const p = cliPane(a._[0], true);
      if (a["turn-after"] !== undefined) {
        const after = num(a, "turn-after", 0, 0, Number.MAX_SAFE_INTEGER), gen = cliGen(a) ?? p.generation;
        if (p.agent === "shell") throw new Error("--turn-after is for agent panes. A shell counts commands (loomctl panes --json), and send --receipt waits for one.");
        await until(() => gone(p) || p.dead || p.generation !== gen || p.turns > after, ctx.seconds, `${paneName(p)} to finish turn ${after + 1}`, ctx.signal);
        if (p.turns <= after || p.generation !== gen) throw new Error(`${paneName(p)} ${gone(p) ? "was closed" : p.dead ? "exited" : "restarted"} before turn ${after + 1}.`);
        return { data: paneData(p), text: `${paneName(p)} finished turn ${p.turns}` };
      }
      const want = cliStates(str(a, "state"), "waiting");
      await until(() => gone(p) || want.includes(cliState(p)), ctx.seconds, `${paneName(p)} to be ${want.join(" or ")}`, ctx.signal);
      if (gone(p)) throw new Error("The pane was closed.");
      return { data: paneData(p), text: `${paneName(p)} is ${cliState(p)}` };
    },
  },
  notify: {
    usage: "notify [pane [inherit|on|off]] [--all on|off] [--finish on|off] [--fail on|off] [--blocked on|off] [--new-panes inherit|on|off] [--check SEQ,... [--policy-v4]] | notify --resolve-owner ID release|mute",
    help: "Task notices: what Loom lets a relay send on (watch --metadata --policy). --all turns every pane on or off; a pane's own on or off wins over it, and inherit follows it again. --finish, --fail and --blocked choose the kinds, for every pane. --new-panes is what a pane made from now on starts with. Turning a pane or kind off also stops its notices not sent yet, and turning it back on sends none of them. --check asks for events by number whether they may go out now (null: Loom doesn't have it). --check with --policy-v4 returns send, held, muted or none instead of a boolean; null still means unavailable. Retain and recheck held notices after owner review, even without new watch events.",
    options: { all: "string", finish: "string", fail: "string", blocked: "string", "new-panes": "string", check: "string", "resolve-owner": "string", "policy-v4": "bool" },
    run: async (a) => {
      const owner = str(a, "resolve-owner");
      if (owner !== undefined) {
        if (a._.length !== 1 || (a._[0] !== "release" && a._[0] !== "mute") || [...NOTIFY_KINDS, "all", "new-panes", "check", "policy-v4"].some((k) => a[k] !== undefined))
          throw new Error("--resolve-owner takes one owner id and release or mute, with no other policy options.");
        requireJournal();
        const decision = a._[0] === "release" ? "released" : "muted";
        if (!typedTasks().some((t) => t.pane === owner) || (notifyOwners[owner] !== "held" && notifyOwners[owner] !== decision))
          throw new Error(`Notice owner ${owner} is not awaiting that decision. Run notify to list unresolved owners.`);
        notifyOwners[owner] = decision; // an identical retry can recover a failed write
        await recordNotify();
        return { data: { owner, decision: notifyOwners[owner], unresolved: unresolvedNotices() }, text: `owner ${owner}: ${notifyOwners[owner]}` };
      }
      const check = str(a, "check");
      const v4 = flag(a, "policy-v4");
      if (v4 && check === undefined) throw new Error("--policy-v4 requires --check.");
      if (check !== undefined && (a._.length || [...NOTIFY_KINDS, "all", "new-panes"].some((k) => a[k] !== undefined)))
        throw new Error("--check only asks: give it alone.");
      if (check !== undefined) {
        const seqs = check.split(",").map((n) => {
          const seq = Number(n.trim());
          if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`--check takes event numbers, not ${n.trim() || "nothing"}.`);
          return seq;
        });
        const all = [...tasks.values()];
        const got = Object.fromEntries(seqs.map((seq) => {
          const t = all.find((t) => t.events.some((e) => e.seq === seq));
          const e = t?.events.find((e) => e.seq === seq);
          return [seq, t && e && e.seq <= writtenSeq ? (v4 ? notifyDisposition(e, t.pane, notifyHistory) : notifies(e, t.pane, notifyHistory)) : null];
        }));
        return { data: got, text: table(Object.entries(got).map(([k, v]) => [k, v === null ? "unknown" : typeof v === "string" ? v : v ? "send" : "muted"])) };
      }
      // Everything asked is checked first, the pane included, so a refused
      // command changes nothing at all (review 2026-10-03 15:52, P2).
      if (a._.length > 2) throw new Error(`notify takes a pane and inherit, on or off, not ${a._.slice(2).join(" ")} too.`);
      const change: Partial<typeof notifyPolicy> = {};
      if (a.all !== undefined) change.on = onOff(str(a, "all"), "--all");
      const kinds = { ...notifyPolicy.kinds };
      for (const k of NOTIFY_KINDS) if (a[k] !== undefined) kinds[k] = onOff(str(a, k), `--${k}`);
      if (NOTIFY_KINDS.some((k) => kinds[k] !== notifyPolicy.kinds[k])) change.kinds = kinds;
      const fresh = str(a, "new-panes");
      if (fresh !== undefined) {
        if (fresh !== "inherit" && fresh !== "on" && fresh !== "off") throw new Error(`--new-panes takes inherit, on or off, not ${fresh}.`);
        change.newPanes = fresh;
      }
      const pane = a._[0] !== undefined ? cliPane(a._[0]) : undefined;
      const own = a._[1];
      if (own !== undefined && own !== "inherit" && own !== "on" && own !== "off") throw new Error(`A pane's notices are inherit, on or off, not ${own}.`);
      if (Object.keys(change).length || (pane && own !== undefined))
        await setNotify(change, pane && own !== undefined ? { pane, value: own } : undefined);
      if (pane) {
        const p = pane;
        const row = notifyRow(p);
        return { data: { ...row, unresolved: unresolvedNotices() }, text: [table(Object.entries(row).map(([k, v]) => [k, String(v)])), unresolvedText()].filter(Boolean).join("\n") };
      }
      const panes = threads.flatMap((t) => t.panes).map(notifyRow);
      return {
        data: { all: notifyPolicy.on ? "on" : "off", kinds: notifyPolicy.kinds, newPanes: notifyPolicy.newPanes, panes, unresolved: unresolvedNotices() },
        text: `every pane ${notifyPolicy.on ? "on" : "off"}; ${NOTIFY_KINDS.map((k) => `${k} ${notifyPolicy.kinds[k] ? "on" : "off"}`).join(", ")}; new panes ${notifyPolicy.newPanes}\n` +
          [table(panes.map((r) => [r.ref, r.notify, ...NOTIFY_KINDS.map((k) => (r[k as keyof typeof r] ? k : "-"))])), unresolvedText()].filter(Boolean).join("\n"),
      };
    },
  },
  receipt: {
    usage: "receipt <token>",
    help: "What send --receipt sent, without waiting: the SHA-256 and size of the text Loom typed, its --key, when it was accepted, typed and submitted, and what the pane signaled back (a turn's end or a command's exit), if anything yet.",
    run: (a) => {
      const token = cliWord(a, 0, "a receipt");
      const record = receiptRecord(token, cliReceipt(token));
      const { wrote, acknowledged } = record;
      const back = !acknowledged ? `nothing back yet (${record.outcome})` : "turn" in acknowledged ? `turn ${acknowledged.turn} ended ${acknowledged.at}` : `exited ${acknowledged.exit ?? "with an unknown code"} ${acknowledged.at}`;
      return { data: record, text: `${record.ref}: ${wrote.stage} ${wrote.submittedAt ?? wrote.typedAt ?? wrote.acceptedAt}, sha256 ${wrote.sha256} (${wrote.bytes} bytes); ${back}` };
    },
  },
  task: {
    usage: "task <id> [--end cancelled|unknown]",
    help: "A task as it stands, without waiting: its state, correlation, uncertainty and history. saved is false while its latest journal write is pending or failed, including field updates and recovery. ref is its pane's current position, or null with paneClosed true after close. --end explicitly settles an open task in the journal, without sending keys or stopping its process. Identical retries wait for persistence and retry a failed write without another event. It cannot rewrite a final task or claim completion.",
    options: { end: "string" },
    run: async (a) => {
      const t = cliTask(cliWord(a, 0, "a task"));
      const end = str(a, "end");
      if (end !== undefined) {
        if (end !== "cancelled" && end !== "unknown") throw new Error("--end takes cancelled or unknown.");
        if (isFinal(t.state) && t.state !== end) throw new Error(`Task ${t.id} already ended ${t.state}; its outcome cannot be rewritten.`);
        requireJournal();
        if (!await moveTask(t, { state: end, signal: "loomctl", reason: `operator-${end}` }))
          throw new CliError("The task ended in memory but was not saved. Read task again before retrying.", { task: t.id, state: t.state, saved: false });
        if (unsaved.has(t.id)) throw new CliError("The task outcome is not saved yet.", { task: t.id, state: t.state, saved: false });
      }
      return { data: record(t), text: taskText(t) };
    },
  },
  tasks: {
    usage: "tasks [--pane P] [--state S]",
    help: "The tasks Loom keeps, oldest first: every open one and the last 500 to finish. saved is false for a pending or failed latest write. --pane takes a current reference or a stable pane ID, including a closed pane's ID. --state takes accepted, submitted, working, approval, completed, failed, cancelled and unknown, several with commas, or open for any not finished.",
    options: { pane: "string", state: "string" },
    run: (a) => {
      const want = a.state === undefined ? null : taskStates(str(a, "state")!, "--state");
      const sel = str(a, "pane");
      let id = sel;
      if (sel !== undefined) try { id = cliPane(sel, true).id; } catch { /* a pane closed since: match its stable id */ }
      const list = [...tasks.values()].filter((t) => t.events.length && (!want || want.includes(t.state)) && (sel === undefined || t.pane === id));
      return { data: list.map(record), text: list.length ? list.map(taskText).join("\n") : "No tasks." };
    },
  },
  watch: {
    usage: "watch [task] [--after N] [--follow] [--metadata [--policy | --policy-v4] [--notification-context]] | watch --panes [--thread T] [--pane P] [--state S] [--after N] [--follow]",
    help: "--panes (or --thread, --pane or --state alone): pane state events instead of tasks. Each time a pane settles into a new state (working, idle, waiting, exited, starting) and stays there 2 s, one event: seq, at (when the state began), pane, stableId, ref, thread, threadId, agent, title, old, state, asking (waiting on a numbered question), exit (exited only), generation, turns and tail (its last 10 lines). Loom keeps the last 500 in memory. Numbers are milliseconds since 1970 or just past, so they grow across restarts and --after also takes a time; gap is true when some after N are gone (pruned, or Loom restarted since N). Filters: --thread T, --pane P, --state idle,waiting. Without --panes: task events after number N (0 by default), oldest first: each state a task moved to, numbered across all tasks and across restarts. Waits for one up to --timeout, woken by the journal's writes, then prints them and next, the number to pass back. With a task, only its events, and done once it finished. loomctl watch --follow keeps going, one JSON line per event with --json, reconnecting when Loom goes away. --metadata gives each event's number, task, pane id, pane generation, state and time only, and for a completed one the name of the agent's final message (response, a hash, never the text; null when the agent reported none), with source loom-durable-events-v2. --metadata --policy adds what started the task (source: submit, send, manual or agent) and whether the notification policy lets it go out (notify), with source loom-durable-events-v3. A v2 read that would include a notice the policy holds back is refused, so a reader that can't see the policy never sends one. --metadata --policy-v4 opts into loom-durable-events-v4: disposition replaces notify with send, held, muted or none. Persist held notices before advancing next, then recheck with notify --check SEQ --policy-v4. Owner release creates no new event. The v3 contract is unchanged. --notification-context, with --metadata and --policy or --policy-v4, adds where each event happened as Loom recorded it (context: threadId, threadName, paneId, paneNumber, paneTitle, agent, provider, capturedAt, origin, issues), with source loom-durable-events-v3-context-v1 or loom-durable-events-v4-context-v1. A title the running program set is never in it. Such an answer holds at most 1000 events and 512 KiB: read on from next.",
    options: { after: "int", metadata: "bool", policy: "bool", "policy-v4": "bool", "notification-context": "bool", panes: "bool", thread: "string", pane: "string", state: "string" },
    run: async (a, ctx) => {
      if (flag(a, "panes") || a.thread !== undefined || a.pane !== undefined || a.state !== undefined) return watchPanes(a, ctx.seconds, ctx.signal);
      const one = a._[0] ? cliTask(a._[0]) : undefined;
      const meta = flag(a, "metadata"), v4 = flag(a, "policy-v4"), v3 = meta && (flag(a, "policy") || v4);
      const withContext = flag(a, "notification-context");
      if (v4 && !meta) throw new Error("--policy-v4 requires --metadata.");
      if (withContext && !v3) throw new Error("--notification-context requires --metadata with --policy or --policy-v4.");
      let after = num(a, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      // A number from beyond this journal (it was lost or reset): start over.
      // Only events the journal holds (writtenSeq), so a number never comes twice across restarts.
      const gap = after < taskPruned || after > writtenSeq;
      if (after > writtenSeq) after = 0;
      const pick = () => eventsAfter(one ? [one] : tasks.values(), after).filter((e) => e.seq <= writtenSeq);
      const finished = () => !!one && isFinal(one.state) && (one.events[one.events.length - 1]?.seq ?? 0) <= writtenSeq;
      const end = Date.now() + Math.max(0, ctx.seconds - 1) * 1000;
      // A gap alone doesn't end the wait: one that stays (a task's events all
      // before a pruned one) would have `watch <task> --follow` ask again at once, forever.
      await taskEventGate.waitUntil(() => pick().length > 0 || finished(), Math.max(0, end - Date.now()), ctx.signal);
      const events = pick();
      // `one`, not tasks.get: it may have been pruned while this waited.
      const owner = (id: string) => one ?? tasks.get(id)!;
      // A v2 reader can't see the policy and sends every outcome, so it gets
      // none that the policy holds back (review 2026-10-03 15:52, P1): the
      // whole answer is refused until it reads v3.
      const held = meta && !v3 ? events.find((e) => notifyKind(e.state) && !notifies(e, owner(e.task).pane, notifyHistory)) : undefined;
      if (held) throw new Error(`Event ${held.seq} is a task notice the notification policy holds back, and a loom-durable-events-v2 reader would send it, so Loom answers none. Read with --metadata --policy (loom-durable-events-v3), which says which may go out.`);
      const at = (n: number) => new Date(n).toISOString();
      const rows = events.map(({ context, ...e }) => (meta ? {
        seq: e.seq, task: e.task, pane: owner(e.task).pane, generation: owner(e.task).gen, state: e.state, at: at(e.at), response: e.response ?? null,
        ...(v3 ? { source: owner(e.task).source ?? "submit", ...(v4 ? { disposition: notifyDisposition(e, owner(e.task).pane, notifyHistory) } : { notify: notifies(e, owner(e.task).pane, notifyHistory) }) } : {}),
        ...(withContext ? { context: contextRecord(owner(e.task), context) } : {}),
      } : { ...e, at: at(e.at) }));
      // Contexts make each event bigger: that reader gets a bounded first part and reads on from next.
      const n = withContext ? fitBatch(rows) : rows.length, shown = events.slice(0, n);
      const done = finished() && n === events.length;
      return {
        data: {
          events: rows.slice(0, n),
          next: shown[shown.length - 1]?.seq ?? after, done, gap: gap || after < taskPruned, last: writtenSeq,
          ...(meta ? { source: (v4 ? "loom-durable-events-v4" : v3 ? "loom-durable-events-v3" : "loom-durable-events-v2") + (withContext ? "-context-v1" : "") } : {}),
        },
        text: shown.map((e) => `${e.seq}  ${at(e.at)}  ${e.task}  ${e.state}` + (meta ? "" : `  ${e.signal}${e.detail ? `  ${e.detail}` : ""}`)).join("\n"),
      };
    },
  },
  webhook: {
    usage: "webhook [list] | webhook add <url> [--header \"Name: value\"] [--secret S] [--thread T] [--pane P] [--state S] | webhook remove <n> | webhook test [n]",
    help: "Webhooks for pane state events, for every thread and pane, kept with Loom's settings. Loom POSTs each event that watch --panes would print to every webhook whose filters keep it, as JSON, with X-Loom-Event: pane-state and X-Loom-Delivery: <seq>. --header adds one header (an API key). --secret signs each body: X-Loom-Signature: sha256=<hex HMAC-SHA256 of the body>. --thread (by name), --pane (follows that pane across restarts) and --state idle,waiting,exited keep only those events. A failed delivery is tried again after 2, 4, 8, 16, 32 and 64 s, in order, and a 4xx other than 408 or 429 isn't retried; list shows what each sent, what waits, and its last 20 failures. test posts {\"seq\": 0, \"test\": true, \"at\": ...} once and says what came back. remove takes its number from list.",
    options: { header: "string", secret: "string", thread: "string", pane: "string", state: "string" },
    run: async (a) => {
      const [how = "list", ...rest] = a._;
      const pick = (w: string | undefined) => {
        const n = Number(w);
        if (!webhooks.length) throw new Error("There are no webhooks. loomctl webhook add <url> adds one.");
        if (!Number.isInteger(n) || n < 1 || n > webhooks.length) throw new Error(`Name a webhook by its number in loomctl webhook list, 1 to ${webhooks.length}.`);
        return n - 1;
      };
      if (how !== "add" && ["header", "secret", "thread", "pane", "state"].some((k) => a[k] !== undefined))
        throw new Error("--header, --secret, --thread, --pane and --state go with webhook add.");
      if (how === "add") {
        if (rest.length !== 1) throw new Error("webhook add takes one URL.");
        const h: Webhook = { url: hookUrl(rest[0]) };
        const header = str(a, "header"), secret = str(a, "secret"), th = str(a, "thread"), sel = str(a, "pane");
        if (header !== undefined) hookHeader((h.header = header));
        if (secret !== undefined) {
          if (!secret) throw new Error("--secret needs a value.");
          h.secret = secret;
        }
        if (th !== undefined) h.threads = [cliThread(th).name];
        if (sel !== undefined) h.panes = [cliPane(sel).stableId];
        if (a.state !== undefined) h.states = cliStates(str(a, "state"), "");
        webhooks = [...webhooks, h];
      } else if (how === "remove") {
        const i = pick(rest[0]);
        webhooks = webhooks.filter((_, j) => j !== i);
      } else if (how === "test") {
        const i = pick(rest[0] ?? "1"), url = webhooks[i].url;
        const got = await couriers[i].attempt(0, JSON.stringify({ seq: 0, test: true, at: new Date().toISOString() }));
        if (typeof got !== "number" || got < 200 || got >= 300) throw new Error(`${url} didn't take the test: ${typeof got === "number" ? `HTTP ${got}` : got}.`);
        return { data: { n: i + 1, url, status: got }, text: `${url}: HTTP ${got}` };
      } else if (how !== "list") throw new Error(`webhook takes list, add, remove or test, not ${how}.`);
      if (how !== "list") {
        syncCouriers();
        save();
      }
      const rows = webhooks.map(hookRow);
      return {
        data: rows,
        text: rows.length ? table(rows.map((r) => [String(r.n), r.url, [r.threads.join(","), r.panes.join(","), r.states.join(",")].filter(Boolean).join(" ") || "every event",
          `sent ${r.sent}${r.queued ? `, ${r.queued} waiting` : ""}${r.failures.length ? `, last failure ${r.failures[r.failures.length - 1].at}: ${r.failures[r.failures.length - 1].error}` : ""}`])) : "No webhooks.",
      };
    },
  },
  "wait-any": {
    usage: "wait-any [--state waiting] [--thread T] [--new] [--timeout S]",
    help: "Block until any pane is in a state; --new skips the ones already in it.",
    options: { state: "string", thread: "string", new: "bool" },
    run: async (a, ctx) => {
      const want = cliStates(str(a, "state"), "waiting");
      const thread = str(a, "thread");
      const scope = thread === undefined ? null : cliThread(thread, true);
      const pool = () => (scope ? scope.panes : threads.flatMap((t) => t.panes));
      // --new: a pane counts once it has left the state and come back.
      const skip = new Set(flag(a, "new") ? pool().filter((p) => want.includes(cliState(p))) : []);
      let hit: Pane | undefined;
      await until(() => {
        for (const p of skip) if (!want.includes(cliState(p))) skip.delete(p);
        return !!(hit = pool().find((p) => !skip.has(p) && want.includes(cliState(p))));
      }, ctx.seconds, `a pane to be ${want.join(" or ")}`, ctx.signal);
      return { data: paneData(hit!), text: `${paneName(hit!)} (${hit!.agent}) is ${cliState(hit!)}` };
    },
  },
  restart: {
    usage: "restart [pane] [--yes]",
    help: "Start a pane's process again, resuming its session. A running one needs --yes and is stopped first.",
    options: { yes: "bool" },
    run: async (a) => {
      const p = cliPane(a._[0]);
      if (!p.dead) {
        if (!flag(a, "yes")) throw new Error(`${paneName(p)} is running. Pass --yes to stop it and start it again.`);
        await p.stop();
      }
      if (needsSession(p)) throw new Error(`${paneName(p)} has no session to resume. Pick one in Loom.`);
      const started = await p.spawn(true);
      if (started !== true) throw new Error(`${paneName(p)} didn't start: ${started}`);
      return { data: paneData(p), text: `${paneName(p)} restarted`, note: `loomctl restarted ${paneName(p)}` };
    },
  },
  stop: {
    usage: "stop [pane] --yes",
    help: "Stop a pane's process and keep the pane, as the Overview's Stop does. A process still starting is stopped too.",
    options: { yes: "bool" },
    run: async (a) => {
      const p = cliPane(a._[0]);
      // A dead pane may be starting again, still checking its session: that start is stopped too.
      if (p.dead && !p.launchPending) return { data: paneData(p), text: `${paneName(p)} has already exited.` };
      if (!flag(a, "yes")) throw new Error(`Stopping ${paneName(p)} ends ${p.agent}. Pass --yes.`);
      await p.stop();
      return { data: paneData(p), text: `${paneName(p)} stopped`, note: `loomctl stopped ${paneName(p)}` };
    },
  },
  close: {
    usage: "close [pane] [--yes]",
    help: "Close a pane. One with a running agent needs --yes.",
    options: { yes: "bool" },
    run: async (a) => {
      const p = cliPane(a._[0]);
      const name = paneName(p);
      if (p.agentUp && !flag(a, "yes")) throw new Error(`${name} is running ${p.agent}. Pass --yes to stop it and close the pane.`);
      if (!(await p.th.closePane(p, true))) throw new Error(`${name} was already closed.`);
      return { data: { closed: p.id }, text: `Closed ${name}`, note: `loomctl closed ${name}` };
    },
  },
  trash: {
    usage: "trash [list]",
    help: "List deleted worktrees waiting in Loom's trash: where each folder and Git's record of it went. Move both back by hand to undo one (docs/loomctl.md).",
    run: async (a) => {
      if (a._.length > 1 || (a._.length && a._[0] !== "list")) throw new Error("Use loomctl trash list.");
      // `error`: a record cut short as it was written, or held by an operation right now.
      // `restoring`: an older Loom's restore stopped on its way there; finished by hand.
      const data = await invoke<{ id: string; folder: string; at: string; entry: string; entry_at: string; pending: boolean; restoring?: string; error?: string }[]>("trash_list");
      return { data, text: data.length ? table(data.flatMap(r => r.error ? [[r.id, "unreadable", r.error]]
        : [[r.id, r.restoring ? "restoring" : r.pending ? "pending" : "retained", "folder", `${r.folder} -> ${r.at}`], ["", "", "git", `${r.entry} -> ${r.entry_at}`],
          ...(r.restoring ? [["", "", "restore", `stopped on its way to ${r.restoring}`]] : [])])) : "Loom's trash is empty." };
    },
  },
  "close-plan": {
    usage: "close-plan <thread> [--delete worktree|branch]",
    help: "What close-thread would do, changing nothing: the thread and the panes it stops, and with --delete what deleting loses that exists nowhere else (changed, untracked and ignored files, the branch's own commits). Its rev is what close-thread --plan takes.",
    options: { delete: "string" },
    run: async (a) => {
      const th = cliThread(cliWord(a, 0, "a thread"), true);
      const { data } = await closePlan(th, cliDelete(a, th));
      const lost = data.lost ? LOSSES.filter((l) => data.lost![l]).map((l) => `${data.lost![l]} ${l}`).join(", ") : "";
      const go = `loomctl close-thread ${th.id} --yes${data.delete ? ` --delete ${data.delete}` : ""} --plan ${data.rev}${data.discard?.length ? ` --discard ${data.discard.join(",")}` : ""}`;
      return {
        data,
        text: [
          `Closes ${th.name} (${th.id}) and stops ${data.panes.length ? data.panes.map((p) => `${p.ref} ${p.agent}`).join(", ") : "no panes"}.`,
          data.delete ? `Deletes ${th.dir}${data.delete === "branch" ? ` and the branch ${data.branch}` : ""}. ${lost ? `Loses ${lost}.` : "Loses nothing that exists only there."}` : "Deletes nothing.",
          ...(data.ignored?.length ? [`Ignored: ${data.ignored.join(", ")}${data.lost!.ignored > data.ignored.length ? ", …" : ""}`] : []),
          `To go ahead: ${go}`,
        ].join("\n"),
      };
    },
  },
  "close-thread": {
    usage: "close-thread <thread> --yes [--delete worktree|branch] [--plan REV] [--discard LIST] [--force]",
    help: "Close a thread and its panes. --delete worktree moves its folder to Loom's trash, erased after a day; --delete branch deletes the branch too. Deleting refuses while it would lose anything --discard doesn't name: tracked, untracked, ignored (files git ignores, like .env or node_modules) and commits, comma-separated, or all. --plan REV (from close-plan) refuses before closing anything if the thread, its panes or its file or index contents changed since. The check reads changed and untracked files whole, except what --discard gives up, and everything else by size and time, never through a link; it refuses a tree it can't finish. --force is --discard all.",
    options: { yes: "bool", delete: "string", force: "bool", plan: "string", discard: "string" },
    run: async (a) => {
      const th = cliThread(cliWord(a, 0, "a thread"));
      const del = cliDelete(a, th), force = flag(a, "force"), expect = str(a, "plan");
      if (!del && a.discard !== undefined) throw new Error("--discard is for --delete: closing a thread deletes nothing.");
      const allowed = force ? new Set(LOSSES) : discards(str(a, "discard"));
      const what = `${th.panes.length} pane${th.panes.length === 1 ? "" : "s"}${del ? ` and deletes ${del === "branch" ? `the worktree and branch ${th.branch}` : "the worktree folder"}` : ""}`;
      if (!flag(a, "yes")) throw new Error(`Closing ${th.name} stops its ${what}. Pass --yes.`);
      // Read now, in this one call, right before anything closes.
      let plan: Awaited<ReturnType<typeof closePlan>> | undefined;
      if (expect !== undefined || (del && !force)) {
        // A plan's rev reads everything; without one, what --discard gives up isn't read.
        plan = await closePlan(th, del, expect === undefined ? [...allowed] : []).catch((e) => {
          throw new Error(`Couldn't read what deleting ${th.name} would lose, so nothing was closed: ${e instanceof Error ? e.message : String(e)}`);
        });
        if (expect !== undefined && plan.data.rev !== expect) {
          throw new CliError(`${th.name} changed since plan ${expect} (it's ${plan.data.rev} now), so nothing was closed. loomctl close-plan ${th.id}${del ? ` --delete ${del}` : ""} shows it.`, { plan: plan.data.rev });
        }
        const missing = plan.data.lost ? LOSSES.filter((l) => plan!.data.lost![l] && !allowed.has(l)) : [];
        if (missing.length) {
          throw new CliError(`${riskText(plan.inv).trim()}\nSo nothing was closed. loomctl close-plan ${th.id} --delete ${del} lists what; pass --discard ${missing.join(",")} to delete it anyway.`, { lost: plan.data.lost, discard: missing });
        }
      }
      // The branch --delete branch takes: the plan's, which its rev covers, or
      // with no plan the one Git has checked out now, not Loom's cached name.
      const branch = plan ? plan.data.branch ?? "" : del === "branch" ? await syncBranch(th) : th.branch;
      const name = th.name;
      const result = await removeThread(th, del === "branch" ? "all" : del ? "worktree" : "close", false, branch, plan?.inv?.branchTip);
      if (!result.removed) throw new Error(result.error ?? `${name} wasn't closed.`);
      const steps = { panes: "closed", worktree: result.worktree ?? null, branch: result.branch ?? null };
      const trash = result.trash || null;
      if (result.error) throw new CliError(`Closed ${name} and stopped its panes, but ${result.error}`, { closed: th.id, steps, trash });
      return { data: { closed: th.id, steps, trash }, text: `Closed ${name}${trash ? `. Its folder waits in Loom's trash for a day: ${trash}` : ""}`, note: `loomctl closed ${name}` };
    },
  },
  theme: {
    usage: "theme [name]",
    help: "List the themes, or switch to one.",
    run: (a) => {
      const name = a._.join(" ").trim();
      if (!name) {
        return {
          data: THEMES.map((t) => ({ name: t.label, scheme: t.scheme ?? "dark", current: t === theme, vars: t.vars })),
          text: table(THEMES.map((t) => [t === theme ? "*" : " ", t.label, t.scheme ?? "dark"])),
        };
      }
      const t = THEMES.find((x) => x.label.toLowerCase() === name.toLowerCase());
      if (!t) throw new Error(`No theme "${name}". loomctl theme lists them.`);
      applyTheme(t);
      save();
      paintTheme();
      return { data: { theme: t.label }, text: `Theme: ${t.label}` };
    },
  },
  set: {
    usage: "set [sound|taskbar|overlay|awake|plan-usage|font] [value]",
    help: "Show the settings, or change one: on/off, overlay off/background/always, and font the terminals' size in points (8 to 24).",
    run: async (a) => {
      const settings = () => ({
        sound: soundEnabled ? "on" : "off", taskbar: taskbarEnabled ? "on" : "off", overlay: overlayMode,
        awake: keepAwake ? "on" : "off", "plan-usage": planUsage ? "on" : "off", font: String(fontSize),
      });
      const key = a._[0];
      const value = a._[1];
      // The Preferences buttons themselves, so saving and repainting are theirs.
      if (key === "sound") {
        if (onOff(value, key) !== soundEnabled) $("#notification-sound").click();
      } else if (key === "taskbar") {
        if (onOff(value, key) !== taskbarEnabled) $("#notification-taskbar").click();
      } else if (key === "plan-usage") {
        if (onOff(value, key) !== planUsage) $("#plan-usage").click();
      } else if (key === "awake") {
        await setKeepAwake(onOff(value, key));
      } else if (key === "overlay") {
        if (!OVERLAY_MODES.some((m) => m === value)) throw new Error(`overlay takes ${OVERLAY_MODES.join(", ")}, not ${value ?? "nothing"}.`);
        for (let i = 0; i < OVERLAY_MODES.length && overlayMode !== value; i++) $("#overlay-pref").click();
      } else if (key === "font") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 8 || n > 24) throw new Error(`font takes a size from 8 to 24, not ${value ?? "nothing"}.`);
        setFont(n);
      } else if (key !== undefined) {
        throw new Error(`No setting "${key}". loomctl set lists them.`);
      }
      const now = settings();
      return { data: now, text: table(Object.entries(now)) };
    },
  },
  window: {
    usage: "window <show|minimize|maximize|restore|phone>",
    help: "Bring Loom's window up, minimize, maximize or restore it, or toggle the phone size. Each show step has a 2 s limit; a timeout leaves other requests runnable, though Windows may still finish the step.",
    run: async (a) => {
      const w = getCurrentWindow();
      const how = cliWord(a, 0, "show, minimize, maximize, restore or phone");
      if (how === "show") {
        await windowStep("unminimize", () => w.unminimize());
        await windowStep("show", () => w.show());
        await windowStep("focus", () => w.setFocus());
      }
      else if (how === "minimize") await w.minimize();
      else if (how === "maximize") await w.maximize();
      else if (how === "restore") await w.unminimize().then(() => w.unmaximize());
      else if (how === "phone") await phoneWindow();
      else throw new Error(`window takes show, minimize, maximize, restore or phone, not ${how}.`);
      return { data: { window: how, phone: desktopWindow !== undefined }, text: "" };
    },
  },
  remote: {
    usage: "remote [on [--port N] | off | pair | revoke [phone] | push test]",
    help: "The phone remote: a page for your phone that does what loomctl does. on starts it on 127.0.0.1 (port 7420 unless --port), and `tailscale serve --bg <port>` then puts it on your own devices. pair shows a code a phone enters once, for 10 minutes. The status lists the paired phones by id, and revoke <id> unpairs one, revoke alone every phone. A phone unseen for 90 days unpairs itself. A phone that turns on notifications in its Settings gets the task notices; push test sends each such phone one that opens an agent. docs/loomctl.md has the setup.",
    options: { port: "int" },
    run: async (a) => {
      const action = a._[0] ?? "status";
      if (action === "push") {
        if (a._[1] !== "test" || a._.length > 2) throw new Error("remote push takes test.");
        const p = threads.flatMap((t) => t.panes).find((x) => x.agent !== "shell") ?? threads[0]?.panes[0];
        const r = await push({ title: "Loom", body: p ? `Notifications work. Tap to open ${paneName(p)}.` : "Notifications work.", tag: "loom-test",
          url: p ? `/#/pane/${encodeURIComponent(p.id)}/${encodeURIComponent(paneName(p))}/${encodeURIComponent(p.stableId)}` : "/" });
        if (!r.sent && r.failed.length) throw new Error(`The test didn't reach a phone: ${r.failed.join("; ")}`);
        return { data: r, text: r.sent ? `Sent to ${r.sent} phone${r.sent === 1 ? "" : "s"}.${r.failed.length ? ` Failed: ${r.failed.join("; ")}` : ""}` : "No phone has notifications on. Turn them on in the phone's Settings." };
      }
      const port = a.port === undefined ? null : num(a, "port", 0, 1, 65535);
      const phone = action === "revoke" ? a._[1] ?? null : null;
      if (a._.length > (action === "revoke" ? 2 : 1)) throw new Error(`remote ${action} takes ${action === "revoke" ? "one phone id at most" : "no more words"}.`);
      type Device = { id: string; name: string; paired: number | null; seen: number | null; push: boolean };
      const s = await invoke<{ on: boolean; listening: boolean; port: number; phones: number; pushes: number; pairing: string | null; error: string | null; address: string | null; devices?: Device[] }>("remote", { action, port, phone });
      const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "unknown");
      const text = [
        s.listening ? `On, at 127.0.0.1:${s.port}. ${s.phones} phone${s.phones === 1 ? "" : "s"} paired, ${s.pushes ?? 0} with notifications on.${lastPush ? ` Last push ${lastPush}.` : ""}` : s.on ? `On, but not listening: ${s.error}` : "Off. loomctl remote on starts it.",
        s.devices?.length && table(s.devices.map((d) => [d.id, d.name, `paired ${when(d.paired)}`, `seen ${when(d.seen)}`, d.push ? "notifications on" : ""])),
        s.listening && (s.address ? `Phone address: ${s.address} (once: tailscale serve --bg ${s.port})` : `Tailscale isn't installed or signed in. Install it, then run: tailscale serve --bg ${s.port}`),
        s.pairing && `Pairing code: ${s.pairing}. Open the address on the phone and enter it within 10 minutes.`,
      ].filter(Boolean).join("\n");
      return { data: s, text };
    },
  },
};

/** `what` isn't loomctl's: installCli adds it to a keyed request. */
type CliRequest = { id: number; cmd: string; argv: string[] | null; stdin: string | null; cwd: string | null; timeout: number; key: string | null; what?: string };

/** One loomctl request, run: its answer, failures included. */
async function runCli(payload: CliRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { cmd, timeout, stdin } = payload;
  try {
    if (shuttingDown) throw new Error("Loom has stopped its panes for shutdown. Retry closing the window; pending reports are retained.");
    const command = Object.prototype.hasOwnProperty.call(CLI, cmd) ? CLI[cmd] : undefined;
    if (!command) throw new Error(`Unknown command "${cmd}". loomctl help lists them.`);
    // Missing words are a loomctl that doesn't match, never "no arguments": that would aim at the pane in front.
    if (!Array.isArray(payload.argv)) throw new Error("loomctl sent no words with the command. Use the loomctl.exe beside loom.exe.");
    const args = parseArgs(payload.argv, command.options ?? {}, cmd);
    // Standard input comes apart from the words and goes in only now, so text starting with -- stays text.
    if (typeof stdin === "string") args._ = args._.map((w) => (w === "-" ? stdin.replace(/\r?\n$/, "") : w));
    const result = await command.run(args, { seconds: timeout, cwd: payload.cwd ?? undefined, key: payload.key ?? undefined, what: payload.what, signal });
    if (result.note) toast(result.note);
    return { ok: true, data: result.data ?? null, text: result.text, ...(result.replayed ? { replayed: true } : {}) };
  } catch (e) {
    const reply: Record<string, unknown> = { ok: false, error: e instanceof Error ? e.message : String(e), timeout: e instanceof CliTimeout };
    if (e instanceof NotSubmitted) Object.assign(reply, { typed: e.typed }, e.pressed === undefined ? {} : { pressed: e.pressed }, e.details);
    if (e instanceof CliError || e instanceof CliTimeout) Object.assign(reply, e.details);
    return reply;
  }
}

/** --key: each key's command, as its SHA-256 (the words can be a prompt, and
 * prompts hold secrets), and its answer, which a retry gets instead of a
 * second run, even while the first is still going. Every key still running
 * stays (a retry of one must never run it again), up to 1024; past that, new
 * keyed requests are refused unrun. Of the finished ones, the last 256 to
 * finish stay, however many are running (pruneSettled, on each finish).
 * ponytail: in memory, per Loom; a store on disk if retries must survive a
 * restart. */
const keyed = new Map<string, { what: string; reply: Promise<Record<string, unknown>>; doneAt?: number }>();
/** Requests running, by id, that a hang-up stops: only the waits read their
 * signal, so a mutation runs on, and a keyed one, a retry's answer too, isn't here. */
const hangups = new Map<number, AbortController>();

/** Answers loomctl for as long as the window is up. */
function installCli() {
  void listen<number>("cli-cancel", ({ payload }) => hangups.get(payload)?.abort(new Error("loomctl hung up, so Loom stopped waiting.")));
  void listen<CliRequest>("cli", async ({ payload }) => {
    const { id, key } = payload;
    // Hashed first: from here to keyed.set nothing awaits, so a retry arriving
    // meanwhile still finds the first one's entry.
    const what = key ? await sha256(JSON.stringify([payload.cmd, payload.argv, payload.stdin, payload.cwd])) : "";
    const earlier = key ? keyed.get(key) : undefined;
    let reply: Record<string, unknown>;
    if (earlier) {
      reply = earlier.what === what ? { ...(await earlier.reply), replayed: true } : { ok: false, error: `--key ${key} was used for a different command, so this one didn't run.` };
    } else if (key && [...keyed.values()].filter((k) => k.doneAt === undefined).length >= 1024) {
      reply = { ok: false, error: "1024 requests with --key are still running, so this one didn't run. Try again once some finish." };
    } else {
      const stop = key ? undefined : new AbortController();
      if (stop) hangups.set(id, stop);
      const run = runCli({ ...payload, what: what || undefined }, stop?.signal).finally(() => hangups.delete(id));
      if (key) {
        const entry: { what: string; reply: typeof run; doneAt?: number } = { what, reply: run };
        keyed.set(key, entry);
        void run.then(() => {
          entry.doneAt = ++settlings;
          pruneSettled(keyed, (e) => e.doneAt, 256);
        });
      }
      reply = await run;
    }
    await invoke("cli_reply", { id, reply }).catch(() => {});
  }).then(() => invoke("cli_ready"));
}

async function loadWorkspace() {
  // Native distinguishes a missing file from an unreadable or empty one.
  const raw = (await invoke<string>("load_state")).replace(/^﻿/, "").trim();
  const saved = JSON.parse(raw || "{}");
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Workspace must be a JSON object");
  return saved;
}

async function main() {
  // panes: PaneState[]; a bare string is the pre-session format, a number the
  // pre-list one before that. `spaces` is the pre-thread format: a folder and
  // its panes, which is what a thread on the checkout itself still is.
  type Saved = { panes: number | (string | PaneState)[]; layout?: LayoutMode; startup?: string };
  let saved: {
    threads?: (Saved & ThreadState)[];
    spaces?: (Saved & { dir: string })[];
    repos?: string[];
    agentGroups?: AgentGroup[];
    reposFolded?: string[];
    startups?: Startup[];
    startup?: string;
    prefixes?: Prefix[];
    prefix?: number;
    langs?: Lang[];
    lang?: number;
    theme?: string;
    fontSize?: number;
    paneMix?: Record<string, number>;
    silent?: boolean;
    soundEnabled?: boolean;
    taskbarEnabled?: boolean;
    notify?: { on?: boolean; kinds?: Partial<Record<NotifyKind, boolean>>; newPanes?: PaneNotify };
    keepAwake?: boolean;
    planUsage?: boolean;
    speakButton?: boolean;
    overlay?: boolean | OverlayMode;
    webhooks?: Webhook[];
    ui?: { thread?: number; dashboard?: boolean; dashboardCompact?: boolean; sideOpen?: boolean; changesOpen?: boolean; sideQuery?: string;
      sideW?: { side?: number; changes?: number }; sideScroll?: number; foldedSections?: string[]; foldedDirs?: string[];
      panel?: "changes" | "files"; openDirs?: string[]; diffFull?: boolean };
  } = {};
  try { saved = await loadWorkspace(); }
  catch (e) {
    await message(`Could not open the workspace. Its file has not been changed. Close Loom, repair the file or restore a backup, then reopen it.

${String(e)}`, { title: "Workspace could not be loaded", kind: "error" });
    return; // Keep restoring true: no workspace save or CLI mutation is allowed.
  }
  if (saved.startups?.length) startups = uniqueStartups(saved.startups);
  if (saved.prefixes?.length) prefixes = saved.prefixes;
  prefix = prefixes[saved.prefix ?? 0] ?? prefixes[0];
  if (saved.langs?.length) langs = saved.langs;
  lang = langs[saved.lang ?? 0] ?? langs[0];
  // Before the first Pane too: its Terminal is built from the live palette.
  applyTheme(THEMES.find((t) => t.label === saved.theme) ?? THEMES[0]);
  // Before any Pane exists — the Terminal is built with it. Hand-editable file.
  fontSize = Math.min(Math.max(saved.fontSize ?? fontSize, 8), 24);
  paneMix = cleanMix(saved.paneMix);
  // Preserve the old combined preference until each new setting is saved.
  soundEnabled = saved.soundEnabled ?? (saved.silent !== true);
  taskbarEnabled = saved.taskbarEnabled ?? (saved.silent !== true);
  // Every pane on when nothing was saved: Loom's behavior before there was a policy.
  notifyPolicy = {
    on: saved.notify?.on !== false,
    kinds: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, saved.notify?.kinds?.[k] !== false])) as Record<NotifyKind, boolean>,
    newPanes: (["inherit", "on", "off"] as const).find((v) => v === saved.notify?.newPanes) ?? "inherit",
  };
  await setKeepAwake(saved.keepAwake === true);
  planUsage = saved.planUsage !== false;
  // Hand-editable file: a hook loomctl wouldn't accept is left out.
  webhooks = (Array.isArray(saved.webhooks) ? saved.webhooks : []).filter((h) => {
    try { return !!hookUrl(h.url) && (!h.header || !!hookHeader(h.header)); } catch { return false; }
  });
  syncCouriers();
  speakShown = saved.speakButton !== false;
  // true was "in background" before there was an "always".
  overlayMode = saved.overlay === true ? "background" : OVERLAY_MODES.find(m => m === saved.overlay) ?? "off";
  repos = saved.repos ?? [];
  agentGroups = Array.isArray(saved.agentGroups) ? saved.agentGroups.filter(g => g && typeof g.id === "string" && g.id && typeof g.name === "string" && g.name.trim()) : [];
  reposFolded = new Set(saved.reposFolded ?? []);
  sideQuery = saved.ui?.sideQuery ?? "";
  dashboardCompact = saved.ui?.dashboardCompact === true;
  $<HTMLInputElement>("#side-filter").value = sideQuery;
  if (saved.ui?.sideW?.side) sideW.side = saved.ui.sideW.side;
  if (saved.ui?.sideW?.changes) sideW.changes = saved.ui.sideW.changes;
  applySideW();
  dragSideW($("#side-resize"), "side", 1);
  dragSideW($("#changes-resize"), "changes", -1);
  if (saved.ui?.foldedSections) {
    foldedSections.clear();
    saved.ui.foldedSections.forEach(s => foldedSections.add(s));
  }
  saved.ui?.foldedDirs?.forEach(s => foldedDirs.add(s));
  saved.ui?.openDirs?.forEach(s => openDirs.add(s));
  diffFull = saved.ui?.diffFull ?? false;
  $("#diff-full").classList.toggle("on", diffFull);
  if (saved.ui?.panel === "files") setPanel("files");
  let closing = false, expired = false, failed = false;
  let shut: { events: [string, unknown][]; emitted: number } | undefined;
  await getCurrentWindow().onCloseRequested(async e => {
    e.preventDefault();
    if (closing) return;
    closing = windowClosing = true;
    let armed = false;
    try {
      if (!shut) {
        await pollSessions();
        await flushSave();
        await saveQueue; // flushSave swallows the error into a toast; this rethrows it, so a failed save cancels the close
        await drainJournal(); // as with the save: a journal that can't be written cancels the close, panes still up
        // What the panes reported as they stopped comes back with the call, and
        // a batch already sent before it is waited for, so all of it is handled,
        // and its journal writes queued, before the drain below. A Claude Stop
        // still waiting for its idle screen is judged on the last one.
        shuttingDown = true;
        document.body.inert = true;
        shut = await invoke<{ events: [string, unknown][]; emitted: number }>("pty_shutdown", { ids: threads.flatMap((t) => t.panes.map((p) => p.id)) });
        // The processes are gone, including on barrier expiry. Keep their last
        // screens intact until their ordered reports have been judged.
        for (const p of threads.flatMap(t => t.panes)) { p.dead = true; p.busy = false; p.waiting = false; p.paint(); }
      }
      for (const end = Date.now() + 3000; agentBatch < shut.emitted && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
      if (agentBatch < shut.emitted) {
        // A batch that never lands must not keep the window open for good:
        // the next close journals what arrived and goes on without it.
        if (!expired) { expired = true; throw new Error(`Timed out waiting for agent report batch ${agentBatch + 1} of ${shut.emitted}; closing again goes on without it`); }
        routeAgentBatches(shut.emitted);
      }
      // A write still out won't be acknowledged now: the reports it held go in
      // as they are (holdReports), and its late release replays nothing.
      const stalled = [...reportsHeld.values()].flatMap((h) => h.events.splice(0));
      reportsHeld.clear();
      agentEvents([...stalled, ...shut.events.splice(0)]);
      await closeTasks();
      await drainJournal();

      // Armed, not started: the new Loom starts once this one has exited (lib.rs relaunch).
      if (relaunching) (await invoke("relaunch"), (armed = true));
      await getCurrentWindow().destroy();
    } catch (e) {
      // A window that stays open must not restart when it does close later.
      if (armed) await invoke("relaunch_cancel").catch(() => {});
      relaunching = false;
      // A failure that comes back on every try (a locked backup, a full disk)
      // must not leave killing Loom as the only way out: the second time, it asks.
      if (failed) {
        document.body.inert = false; // the dialog lives in the page
        const lost = shut ? "the workspace's latest changes and the reports the stopped panes left" : "the workspace's latest changes and task history";
        if (await confirm("Close without saving?", { title: "Loom", kind: "warning", action: "Close anyway", detail: `Closing failed again: ${String(e)}\nClosing anyway loses ${lost}.` })) {
          await getCurrentWindow().destroy();
          return;
        }
        if (shut) document.body.inert = true;
      }
      failed = true;
      toast(`Could not close safely: ${String(e)}${shut ? ". Panes are stopped; retry closing the window to save the retained reports." : ""}`);
    } finally {
      closing = windowClosing = false;
      if (!shut) { shuttingDown = false; document.body.inert = false; }
    }
  });

  for (const id of ["#new-thread", "#open-first"]) $(id).onclick = () => newThread();
  $("#preferences-btn").onclick = () => togglePreferences();
  $("#restart-loom").onclick = async () => {
    const busy = working().map(paneName);
    const detail = busy.length ? `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working: restarting stops ${busy.length === 1 ? "it" : "them"}. Every pane comes back, agents in their sessions.`
      : "It closes safely and starts again, the new version if you just updated. Every pane comes back, agents in their sessions.";
    if (await confirm("Restart Loom?", { title: "Loom", kind: busy.length ? "warning" : "info", action: "Restart", detail })) relaunch();
  };
  $("#phone-window").onclick = () => void phoneWindow();
  $("#preferences-close").onclick = () => (togglePreferences(false), $("#preferences-btn").focus());
  $("#shortcuts").onclick = () => {
    togglePreferences(false);
    $<HTMLDialogElement>("#keys").showModal();
  };
  // This PC's CPU, memory and processes, read every 2 s while the dialog is open (src/procs.ts, procs.rs).
  $("#task-manager").onclick = () => {
    togglePreferences(false);
    const dialog = $<HTMLDialogElement>("#task-manager-dialog");
    const view = procsView(() => invoke<Reading>("procs"));
    $("#task-manager-body").replaceChildren(view.box);
    dialog.showModal();
    void view.poll(new Promise((closed) => dialog.addEventListener("close", closed, { once: true })));
  };
  $("#task-manager-close").onclick = () => $<HTMLDialogElement>("#task-manager-dialog").close();
  $("#side-toggle").onclick = () => toggleSide();
  const narrowWindow = matchMedia("(max-width: 760px)");
  toggleSide(saved.ui?.sideOpen ?? !narrowWindow.matches);
  narrowWindow.addEventListener("change", () => toggleSide(sideOpen));
  window.addEventListener("resize", () => {
    if (!menu.classList.contains("hidden")) place();
  });
  addBtn.onclick = () => current?.addMenu(addBtn);
  window.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !anchor.contains(t)) hideMenu();
    if (!$("#preferences").contains(t) && !$("#preferences-btn").contains(t)) togglePreferences(false);
    if (narrowWindow.matches && !$("#side").contains(t) && !$("#side-toggle").contains(t)) toggleSide(false);
  });
  // No webview context menu anywhere else either; real inputs keep theirs.
  window.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
  });
  // Shift+right-click anywhere toggles the overview. Capture on window runs
  // before a pane's right-click paste and a sidebar row's menu.
  window.addEventListener("contextmenu", (e) => {
    if (!e.shiftKey || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    e.stopPropagation();
    $("#dashboard-btn").click();
  }, true);
  addInput.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = addInput.value.trim();
    if (!v) return;
    openMenu.add?.(v);
    addInput.value = "";
    save();
    renderMenu();
  };
  changesBtn.onmousedown = (e) => e.preventDefault();
  changesBtn.onclick = () => toggleChanges();
  $("#changes-close").onclick = () => toggleChanges(false);
  $("#diff-close").onclick = () => current?.tab && closeTab(current, current.tab);
  $("#diff-full").onclick = () => {
    diffFull = !diffFull;
    $("#diff-full").classList.toggle("on", diffFull);
    save();
    void showTab();
  };
  $("#panel-changes").onclick = () => setPanel("changes");
  $("#panel-files").onclick = () => setPanel("files");
  $("#commit-btn").onclick = () => void commitAll();
  $("#commit-msg").oninput = () => {
    if (current) current.commitDraft = $<HTMLTextAreaElement>("#commit-msg").value;
    save();
  };
  $("#commit-more").onclick = () => showMenu($("#commit-more"), commitMenu);
  $("#pr-btn").onclick = () => void createPR();
  $("#changes-refresh").onclick = () => void pollStats();
  $("#changes-more").onclick = () => showMenu($("#changes-more"), repoMenu);
  $("#wsmore").onclick = () => current && showMenu($("#wsmore"), threadMenu(current));
  $("#waiting").onclick = () => openPicker();
  $("#search").onclick = () => openPicker(true);
  $("#rename-cancel").onclick = () => renameDlg.close();
  $("#keys-close").onclick = () => $<HTMLDialogElement>("#keys").close();
  $<HTMLInputElement>("#side-filter").oninput = (e) => {
    sideQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
    filterSide();
    save();
  };
  let scrollSave = 0;
  $("#threads").onscroll = () => {
    clearTimeout(scrollSave);
    scrollSave = window.setTimeout(() => save(), 150);
  };
  $("#vscode").onclick = () =>
    current && invoke("open_vscode", { dir: current.dir }).catch((e) => toast(String(e)));
  const dictate = $("#dictate");
  const speakMore = $("#speak-more");
  const themeBtn = $("#theme");
  // keep pane focus
  for (const b of [dictate, speakMore, themeBtn, $("#notification-sound"), $("#notification-taskbar"), $("#plan-usage")]) b.onmousedown = (e) => e.preventDefault();
  // Which step, decided when it runs: a second click while the mic opens is its stop.
  dictate.onclick = () => mic(() => (recording ? micStop() : micStart()));
  speakMore.onclick = () => showMenu(speakMore, speakMenu);
  // The status bar's buttons keep the pane's focus too.
  $("#statusbar").onmousedown = (e) => e.preventDefault();
  $("#sb-lang").onclick = () => showMenu($("#sb-lang"), langMenu);
  $("#sb-prefix").onclick = () => showMenu($("#sb-prefix"), prefixMenu);
  $("#sb-pc").onclick = () => $("#task-manager").click();
  void getVersion().then((v) => v && (setText($("#sb-version"), `Loom ${v}`), fitStatus()), () => {});
  // A wider or narrower window has room for more of the bar, or less.
  new ResizeObserver(fitStatus).observe($("#statusbar"));
  $("#speak-pref").onclick = () => ((speakShown = !speakShown), paintSpeak(), save());
  themeBtn.onclick = () => showMenu(themeBtn, themeMenu);
  $("#notification-sound").onclick = () => ((soundEnabled = !soundEnabled), paintNotifications(), save());
  $("#notification-taskbar").onclick = () => {
    taskbarEnabled = !taskbarEnabled;
    if (!taskbarEnabled) getCurrentWindow().requestUserAttention(null).catch(() => {});
    paintNotifications();
    save();
  };
  $("#notices").onclick = () => void setNotify({ on: !notifyPolicy.on }).catch(notifyError);
  for (const k of NOTIFY_KINDS) $(`#notice-${k}`).onclick = () => void setNotify({ kinds: { ...notifyPolicy.kinds, [k]: !notifyPolicy.kinds[k] } }).catch(notifyError);
  $("#notice-new").onclick = () => void setNotify({ newPanes: ({ inherit: "on", on: "off", off: "inherit" } as const)[notifyPolicy.newPanes] }).catch(notifyError);
  $("#keep-awake").onclick = () => void setKeepAwake(!keepAwake);
  $("#plan-usage").onclick = () => {
    planUsage = !planUsage;
    if (openMenu === planMenus.claude || openMenu === planMenus.codex || openMenu === planMenus.both) hideMenu();
    for (const provider of ["claude", "codex"] as const) {
      paintPlan(provider);
      void pollPlan(provider); // back on: fresh numbers now, not in five minutes
    }
    paintPlanUsage();
    save();
  };
  $("#overlay-pref").onclick = () => {
    overlayMode = OVERLAY_MODES[(OVERLAY_MODES.indexOf(overlayMode) + 1) % OVERLAY_MODES.length];
    overlayShown = false;
    overlaySent = "";
    overlayClosedAt = null;
    // Off closes the window; on builds it hidden now, so it's loaded before it's needed.
    void overlayWindow(overlayMode === "off" ? null : false);
    syncOverlay();
    paintOverlayPref();
    save();
  };
  if (overlayMode !== "off") void overlayWindow(false);
  // Also on a timer: a focus change can pass without an event, and the times tick.
  setInterval(() => void readFocus(), 1000);
  micState("");
  paintPrefix();
  paintLang();
  paintNotifications();
  paintPlanUsage();
  paintOverlayPref();
  paintTheme();
  $("#layout").onclick = () => {
    if (!current) return;
    current.layout = LAYOUTS[(LAYOUTS.indexOf(current.layout) + 1) % LAYOUTS.length];
    current.relayout();
    paintLayout(current.layout);
    save();
  };

  // A file dropped from another app lands at the prompt of the pane it was
  // dropped on, unsubmitted, so you can type around it. The OS owns this drag
  // (see dragDropEnabled), so it arrives as an event with real paths and a
  // position in physical pixels rather than as a drop on any element.
  void getCurrentWebview().onDragDropEvent(({ payload }) => {
    const at =
      payload.type === "leave"
        ? null
        : paneAt(payload.position.x / devicePixelRatio, payload.position.y / devicePixelRatio);
    const over = payload.type === "enter" || payload.type === "over" ? at : null;
    for (const p of current?.panes ?? []) p.el.classList.toggle("drop", p === over);
    dashboardPreviewPane?.el.classList.toggle("drop", dashboardPreviewPane === over);
    if (payload.type !== "drop" || !at) return;
    const text = dropText(payload.paths);
    if (!text) return;
    at.th.focusPane(at);
    at.term.paste(text); // not pty_write: paste honors bracketed-paste mode
  });

  // Ctrl+wheel over the panes: the terminal font-size gesture. Capture, so
  // xterm never turns it into a scroll.
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !(e.target as Element).closest(".pane")) return;
      e.preventDefault();
      setFont(fontSize + (e.deltaY < 0 ? 1 : -1));
    },
    { capture: true, passive: false },
  );

  // Taskbar flash from Pane.wake() stays lit until you come back.
  window.addEventListener("focus", () =>
    getCurrentWindow().requestUserAttention(null).catch(() => {}),
  );

  // Push to talk: F4 down starts (below), F4 up stops. Leaving the window counts
  // as letting go — a keyup that never arrives would leave the mic open. Both
  // queue behind a start still opening the microphone; with nothing recording
  // micStop does nothing.
  window.addEventListener("keyup", (e) => e.key === "F4" && mic(micStop), true);
  window.addEventListener("blur", () => mic(micStop));

  // Same keys as aa (F2 zoom, F3 next waiting pane, F5 VS Code), Ctrl+Tab
  // between threads, plus Ctrl+F
  // find and Ctrl+= / - / 0 font size. Capture phase so xterm never sees them.
  window.addEventListener(
    "keydown",
    (e) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") {
        if (!menu.classList.contains("hidden")) {
          hideMenu();
          anchor.focus();
        }
        if (!$("#preferences").classList.contains("hidden")) {
          togglePreferences(false);
          $("#preferences-btn").focus();
        }
        if (narrowWindow.matches) toggleSide(false);
        return; // native dialogs close themselves
      }
      if (e.key === "F1") $<HTMLDialogElement>("#keys").showModal();
      // Ctrl+K is kill-line in a shell, but Loom already owns Ctrl+B and Ctrl+F there too.
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") openPicker(true);
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
        if (dashboardOpen) show(current); else toggleDashboard(true);
      }
      else if (dashboardOpen && e.key !== "F3" && !(e.ctrlKey && (e.key === "b" || e.key === "Tab" || /^[1-9]$/.test(e.key)))) {
        // Keep terminal commands from falling through to WebView shortcuts, especially F5 reload.
        if ((!e.altKey && ["F2", "F4", "F5"].includes(e.key)) || (e.ctrlKey && ["f", "g"].includes(e.key.toLowerCase()))) e.preventDefault();
        return;
      }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") toggleChanges();
      else if (e.ctrlKey && e.key === "b") toggleSide();
      else if (e.key === "F2" && current?.active) current.toggleZoom(current.active);
      else if (e.key === "F3") jumpWaiting();
      else if (e.ctrlKey && e.key === "Tab") cycleThread(e.shiftKey);
      else if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && threads[+e.key - 1]) show(threads[+e.key - 1]);
      else if (e.ctrlKey && e.altKey && e.key.startsWith("Arrow") && current)
        current.focusToward(e.key as "ArrowLeft");
      // Alt+F4 is the window's, and autorepeat would restart the recording.
      else if (e.key === "F4" && !e.altKey && !e.repeat) mic(micStart);
      else if (e.key === "F5" && current)
        invoke("open_vscode", { dir: current.dir }).catch((e) => toast(String(e)));
      else if (e.ctrlKey && e.key === "f" && current?.active) toggleFind();
      // "=" or "+" depending on layout.
      else if (e.ctrlKey && (e.key === "=" || e.key === "+")) setFont(fontSize + 1);
      else if (e.ctrlKey && e.key === "-") setFont(fontSize - 1);
      else if (e.ctrlKey && e.key === "0") setFont(13);
      // Leave plain Alt+arrows to the terminal app (Codex's queued questions).
      else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && current?.active)
        current.active.scroll(e.key === "ArrowUp");
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // Claude's Stop/Notification hooks drop $TEMP\loom-wait\$env:LOOM_PANE; Rust
  // drains this Loom's markers and sends them as they land (lib.rs send_wakes).
  void listen<[string, string][]>("wakes", (e) => {
    const effortById = new Map(e.payload);
    for (const p of threads.flatMap((t) => t.panes)) {
      const marker = effortById.get(p.id);
      if (marker === undefined) continue;
      // "effort", or "effort\nlaunch" from a writer that knows its launch: a replaced one's wakes nothing.
      const [effort, launch] = marker.split("\n");
      if (launch === undefined || Number(launch) === p.launched) p.wake(effort, "hook");
    }
  });

  // What the agents report for loomctl's tasks: Claude's hooks and Codex's
  // notify through loom.exe, and OpenCode's plugin (lib.rs send_task_events).
  // Then which batch Rust sent last: a reloaded page starts at 0 while Rust's
  // count goes on, and must not wait for batches the page before it had.
  void listen<{ seq: number; events: [string, unknown][] }>("agent-events", (e) => {
    receiveAgentBatch(e.payload);
  }).then(() => invoke<number>("agent_batch_base")).then(routeAgentBatches);

  // Codex's notify script, the opencode plugin and Cursor's prompt hook drop the session id a pane is
  // really on (agent.ts). Only the next launch needs it, so it rides the 4 s
  // tick — on the 250 ms one it cost a file open per pane, under the pty lock.
  let sessionPoll: Promise<void> | undefined;
  const pollSessions = () => sessionPoll ??= (async () => {
    const panes = threads.flatMap((t) => t.panes).filter((p) => p.agent === "codex" || p.agent === "opencode" || reportsTurns(p.agent));
    if (!panes.length) return;
    const got = await invoke<[string, string, number | null][]>("take_sessions", { ids: panes.map((p) => p.id) }).catch(() => []);
    let changed = false;
    for (const [id, sid, launch] of got) {
      const p = panes.find((x) => x.id === id);
      // A replaced process's late marker is not the resume target of the one that replaced it.
      if (p && (launch == null || launch === p.launched) && validSessionId(sid) && sid !== p.sessionId) (p.sessionId = sid), (changed = true);
    }
    if (changed) save();
  })().finally(() => { sessionPoll = undefined; });

  // Context and token totals, read from Claude Code's own transcripts.
  // ponytail: a 4s poll beside the wake one — the Rust side reads only what was
  // appended since last time, so an idle pane costs a metadata() call.
  let usagePoll: Promise<void> | undefined;
  const pollUsage = () => usagePoll ??= (async () => {
    await pollProviderUsage();
    const panes = threads.flatMap((t) => t.panes).filter((p) => p.isClaude);
    if (!panes.length) return;
    const asked = panes.map((p) => [p, p.launched] as const);
    const got = await invoke<Record<string, Usage>>("session_usage", {
      panes: asked.map(([p, launch]) => [claudeMarker(p, launch), p.th.dir, p.sid]),
    }).catch(() => ({}) as Record<string, Usage>);
    let moved = false;
    for (const [p, launch] of asked) {
      // Relaunched while this was read: the answer, its session too, is the old process's.
      if (p.launched !== launch) continue;
      const u = got[claudeMarker(p, launch)] ?? null;
      // The pane's claude reported a different session than the one it booted
      // with — /clear, or a claude started by hand. Follow it, so the gauge stays
      // on the live conversation and the next launch resumes that one.
      if (u?.sid && u.sid !== p.sid) {
        p.sid = u.sid;
        moved = true;
      }
      p.setUsage(u);
    }
    if (moved) save();
    // A turn that finished during this poll changes what the config panel should
    // say, and it may well be open in front of you.
    if (!menu.classList.contains("hidden")) cfgPaint?.();
  })().finally(() => { usagePoll = undefined; });
  // WebView2 stays "visible" when minimized. Follow the native window too.
  // Session marks and output acknowledgements keep running in the background.
  const tick = (fn: () => unknown) => () => void (backgroundHidden() || fn());
  let statTick = 0;
  setInterval(tick(pollUsage), 4000);
  setInterval(pollSessions, 4000);
  setInterval(tick(() => pollStats(++statTick % 6 === 0)), 10_000);
  setInterval(tick(() => threads.forEach((t) => t.paintAge())), 30_000);
  setInterval(tick(pollStatus), 3000);
  void pollStatus();
  statusNarrow.onchange = paintStatus;
  resumePolls = () => {
    if (backgroundHidden()) return;
    void pollUsage();
    void pollStats(true);
    void pollStatus();
  };
  document.addEventListener("visibilitychange", resumePolls);

  for (const provider of ["claude", "codex"] as const) {
    const planBtn = $(`#${PLAN_PROVIDERS[provider].button}`);
    planBtn.onmousedown = (e) => e.preventDefault();
    // Refresh the tooltip's countdown when hovered; the open menu supplies its own.
    planBtn.onmouseenter = () => paintPlan(provider);
    planBtn.onclick = () => {
      showMenu(planBtn, planMenus[provider]);
      if (menu.classList.contains("hidden")) paintPlan(provider);
      else planBtn.title = "";
    };
    paintPlan(provider);
    void pollPlan(provider);
    setInterval(() => void pollPlan(provider), 5 * 60_000);
  }
  // A phone turning notifications on subscribes with this key: it is there before one asks.
  void pushKey().catch(() => {});
  // Once a launch is plenty: the roster changes on Anthropic's schedule, not
  // yours, and the panel falls back to the CLI's aliases if this never answers.
  invoke<ModelOpt[]>("model_options")
    .then((m) => (models = m))
    .catch(() => {});

  // Parallel too: openThread pushes its thread and addPane its panes before
  // either awaits, so sidebar order stays saved order, and the sidebar and the
  // saved thread show now. Claude panes start two at a time (bootSlot), which
  // took 26 s to get through 9 of them; each pane says Starting until then.
  const restore =
    saved.threads ?? (saved.spaces ?? []).map((w) => ({ ...w, repo: w.dir, branch: "", name: basename(w.dir) }));
  const opened = Promise.all(
    restore.map((w) => {
      const panes: PaneState[] = Array.isArray(w.panes)
        ? w.panes.map((p) => (typeof p === "string" ? { cmd: p } : p))
        : Array(Math.max(w.panes, 1)).fill({
            cmd: w.startup ?? saved.startup ?? startups[0]?.cmd ?? "",
          });
      return openThread(w, panes, w.layout, true);
    }),
  );
  renderSide();
  show(threads[saved.ui?.thread ?? 0] ?? threads[0] ?? null);
  if (saved.ui?.dashboard) toggleDashboard(true);
  toggleChanges(saved.ui?.changesOpen ?? false);
  toggleSide(saved.ui?.sideOpen ?? !narrowWindow.matches);
  $("#threads").scrollTop = saved.ui?.sideScroll ?? 0;
  // before loomctl answers, so a retried --key finds its task. Whatever goes
  // wrong in replay, startup goes on with the history unavailable.
  await loadTasks().catch((e) => {
    journalUnreadable ||= `replay failed: ${e instanceof Error ? e.message : String(e)}`;
    if (startupTurns) finishTaskReplay();
  });
  void recordNotify().catch(notifyError); // loadTasks recorded this run's policy; this says if the journal couldn't be read
  installCli(); // after the threads exist, before their panes finish starting
  await opened;
  restoring = false;
  await flushSave();
  pollUsage(); // restored panes shouldn't sit blank for the first interval
  pollStats(true);
}

main();
