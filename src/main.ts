import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { homeDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { proofFor, statusFor, flat, foot } from "./apply";
import { agentOf, launch, ownSession, validSessionId, type Agent } from "./agent";
import { icon } from "./icons";
import { parseStatus, parseNumstat, sumStat, diffRows, hunkPatch, tree, gitAct, type Act, type Change, type DiffRow, type Sec, type Stat, type Node as Tree } from "./gitparse";
import { wheelInit } from "./scroll";
import { dropText } from "./drop";
import { fileLinks, imageMime } from "./links";
import "@xterm/xterm/css/xterm.css";

const MAX_PANES = 16;
/** Provider title spinners ("✻ Thinking…"): stripped before a title is shown or compared. */
const SPIN = /^[✳✻✽✶✢·◐◓◑◒⠁-⣿]+\s*/u;

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

const ABS_RE = /^(?:[A-Za-z]:|[\\/])/;

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
  ["bg", "panel", "raise", "line", "line-strong", "text", "muted", "accent"].map(k => [`--${k}`, cssVar(`--${k}`)]),
);
const THEMES: Theme[] = [
  { label: "loom", vars: {} },
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
      "--bg": "#101b2a",
      "--panel": "#172538",
      "--raise": "#22334a",
      "--line": "#2b4059",
      "--line-strong": "#47617e",
      "--text": "#e0eaf5",
      "--muted": "#a5bad1",
      "--faint": "#8ea7c2",
      "--accent": "#8bbafa",
      "--accent-dim": "rgba(139, 186, 250, 0.12)",
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
      "--bg": "#002b36",
      "--panel": "#04303b",
      "--raise": "#073642",
      "--line": "#0d4552",
      "--line-strong": "#586e75",
      "--text": "#93a1a1",
      "--muted": "#8c9b9d",
      "--faint": "#8a9ba1",
      "--accent": "#db815c",
      "--blue": "#54a0cc",
      "--magenta": "#d87aab",
      "--cyan": "#56b4ad",
      "--accent-dim": "rgba(203, 75, 22, 0.16)",
      "--ok": "#8fa114",
      "--err": "#e87674",
      "--warn": "#bc9417",
    },
  },
  {
    label: "gruvbox",
    vars: {
      "--bg": "#1d2021",
      "--panel": "#282828",
      "--raise": "#32302f",
      "--line": "#3c3836",
      "--line-strong": "#504945",
      "--text": "#ebdbb2",
      "--muted": "#bdae93",
      "--faint": "#a29689",
      "--accent": "#fe8019",
      "--blue": "#83a598",
      "--magenta": "#d3869b",
      "--cyan": "#8ec07c",
      "--accent-dim": "rgba(254, 128, 25, 0.14)",
      "--ok": "#b8bb26",
      "--err": "#fc6857",
      "--warn": "#fabd2f",
    },
  },
  {
    label: "dracula",
    vars: {
      "--bg": "#21222c",
      "--panel": "#282a36",
      "--raise": "#343746",
      "--line": "#44475a",
      "--line-strong": "#6272a4",
      "--text": "#f8f8f2",
      "--muted": "#b4b6c4",
      "--faint": "#9b9fb7",
      "--accent": "#bd93f9",
      "--blue": "#9aaeff",
      "--magenta": "#ff79c6",
      "--cyan": "#8be9fd",
      "--accent-dim": "rgba(189, 147, 249, 0.16)",
      "--ok": "#50fa7b",
      "--err": "#ff7575",
      "--warn": "#f1fa8c",
    },
  },
  {
    label: "nord",
    vars: {
      "--bg": "#2e3440",
      "--panel": "#333b48",
      "--raise": "#3b4252",
      "--line": "#434c5e",
      "--line-strong": "#4c566a",
      "--text": "#eceff4",
      "--muted": "#d8dee9",
      "--faint": "#a5aebf",
      "--accent": "#88c0d0",
      "--blue": "#96b1cc",
      "--magenta": "#c3a5bd",
      "--cyan": "#8fbcbb",
      "--accent-dim": "rgba(136, 192, 208, 0.16)",
      "--ok": "#a3be8c",
      "--err": "#d89fa4",
      "--warn": "#ebcb8b",
    },
  },
  {
    label: "tokyo",
    vars: {
      "--bg": "#1a1b26",
      "--panel": "#1f2030",
      "--raise": "#292e42",
      "--line": "#2f3549",
      "--line-strong": "#3b4261",
      "--text": "#c0caf5",
      "--muted": "#9aa5ce",
      "--faint": "#8f95b1",
      "--accent": "#7aa2f7",
      "--blue": "#7aa2f7",
      "--magenta": "#bb9af7",
      "--cyan": "#7dcfff",
      "--accent-dim": "rgba(122, 162, 247, 0.16)",
      "--ok": "#9ece6a",
      "--err": "#f7768e",
      "--warn": "#e0af68",
    },
  },
  {
    label: "catppuccin",
    vars: {
      "--bg": "#181825",
      "--panel": "#1e1e2e",
      "--raise": "#313244",
      "--line": "#45475a",
      "--line-strong": "#585b70",
      "--text": "#cdd6f4",
      "--muted": "#a6adc8",
      "--faint": "#969aae",
      "--accent": "#cba6f7",
      "--blue": "#89b4fa",
      "--magenta": "#f5c2e7",
      "--cyan": "#94e2d5",
      "--accent-dim": "rgba(203, 166, 247, 0.16)",
      "--ok": "#a6e3a1",
      "--err": "#f38ba8",
      "--warn": "#f9e2af",
    },
  },
  {
    label: "one dark",
    vars: {
      "--bg": "#21252b",
      "--panel": "#282c34",
      "--raise": "#2f343d",
      "--line": "#3e4451",
      "--line-strong": "#4f5666",
      "--text": "#abb2bf",
      "--muted": "#959ca9",
      "--faint": "#989da5",
      "--accent": "#61afef",
      "--blue": "#61afef",
      "--magenta": "#c97fdf",
      "--cyan": "#56b6c2",
      "--accent-dim": "rgba(97, 175, 239, 0.16)",
      "--ok": "#98c379",
      "--err": "#e47e86",
      "--warn": "#e5c07b",
    },
  },
  {
    label: "everforest",
    vars: {
      "--bg": "#2d353b",
      "--panel": "#333c43",
      "--raise": "#3d484d",
      "--line": "#475258",
      "--line-strong": "#56635f",
      "--text": "#d3c6aa",
      "--muted": "#aeb7a9",
      "--faint": "#adb6b0",
      "--accent": "#e9a486",
      "--blue": "#85beb7",
      "--magenta": "#dba4be",
      "--cyan": "#85c194",
      "--accent-dim": "rgba(230, 152, 117, 0.16)",
      "--ok": "#a7c080",
      "--err": "#eca0a1",
      "--warn": "#dbbc7f",
    },
  },
  {
    label: "rosé pine",
    vars: {
      "--bg": "#191724",
      "--panel": "#1f1d2e",
      "--raise": "#26233a",
      "--line": "#302d43",
      "--line-strong": "#403d52",
      "--text": "#e0def4",
      "--muted": "#908caa",
      "--faint": "#8e8ba1",
      "--accent": "#c4a7e7",
      "--blue": "#9ccfd8",
      "--magenta": "#c4a7e7",
      "--cyan": "#9ccfd8",
      "--accent-dim": "rgba(196, 167, 231, 0.16)",
      "--ok": "#9ccfd8",
      "--err": "#eb6f92",
      "--warn": "#f6c177",
    },
  },
  {
    label: "dusk",
    vars: {
      "--bg": "#1c1a20",
      "--panel": "#232028",
      "--raise": "#2d2933",
      "--line": "#3a3542",
      "--line-strong": "#544d5e",
      "--text": "#e2dbe6",
      "--muted": "#b3a9bb",
      "--faint": "#9a90a2",
      "--accent": "#c9a0b8",
      "--accent-dim": "rgba(201, 160, 184, 0.14)",
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
      "--bg": "#171c18",
      "--panel": "#1d231f",
      "--raise": "#262e29",
      "--line": "#313b34",
      "--line-strong": "#4a574e",
      "--text": "#d9e0d6",
      "--muted": "#a8b4a6",
      "--faint": "#8c9a8b",
      "--accent": "#a9c39a",
      "--accent-dim": "rgba(169, 195, 154, 0.14)",
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
      "--bg": "#1b1e24",
      "--panel": "#21252c",
      "--raise": "#2a2f38",
      "--line": "#353b46",
      "--line-strong": "#4e5665",
      "--text": "#dcdfe5",
      "--muted": "#aab1bd",
      "--faint": "#8f97a4",
      "--accent": "#9db4cf",
      "--accent-dim": "rgba(157, 180, 207, 0.14)",
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
      "--bg": "#000000",
      "--panel": "#070709",
      "--raise": "#101014",
      "--line": "#1c1c22",
      "--line-strong": "#33333d",
      "--text": "#e8e8f0",
      "--muted": "#9a9aa8",
      "--faint": "#8e8e9e",
      "--accent": "#9a80ff",
      "--accent-dim": "rgba(154, 128, 255, 0.18)",
      "--ok": "#3ef2a3",
      "--err": "#ff5470",
      "--warn": "#ffc857",
      "--blue": "#5ec8ff",
      "--magenta": "#c07cff",
      "--cyan": "#4ef0e0",
    },
  },
  {
    label: "kanagawa",
    vars: {
      "--bg": "#16161d",
      "--panel": "#1f1f28",
      "--raise": "#2a2a37",
      "--line": "#363646",
      "--line-strong": "#54546d",
      "--text": "#dcd7ba",
      "--muted": "#a6a69c",
      "--faint": "#a09f93",
      "--accent": "#ffa066",
      "--accent-dim": "rgba(255, 160, 102, 0.14)",
      "--ok": "#98bb6c",
      "--err": "#ee8391",
      "--warn": "#e6c384",
      "--blue": "#7e9cd8",
      "--magenta": "#ad98d0",
      "--cyan": "#7aa89f",
    },
  },
  {
    label: "sepia",
    vars: {
      "--bg": "#1e1a16",
      "--panel": "#26211c",
      "--raise": "#302a24",
      "--line": "#3e3630",
      "--line-strong": "#5a5047",
      "--text": "#e6ddd0",
      "--muted": "#b8ac9c",
      "--faint": "#9d9182",
      "--accent": "#d2a679",
      "--accent-dim": "rgba(210, 166, 121, 0.14)",
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
      "--bg": "#241b2f",
      "--panel": "#2a2139",
      "--raise": "#34294a",
      "--line": "#3d3357",
      "--line-strong": "#5c4b7e",
      "--text": "#f4eee4",
      "--muted": "#c3b9d9",
      "--faint": "#a99fc4",
      "--accent": "#ff7edb",
      "--accent-dim": "rgba(255, 126, 219, 0.16)",
      "--ok": "#72f1b8",
      "--err": "#ff5c7a",
      "--warn": "#fede5d",
      "--blue": "#6fc1ff",
      "--magenta": "#ff7edb",
      "--cyan": "#36f9f6",
    },
  },
  {
    label: "cyberpunk",
    vars: {
      "--bg": "#0a0e14",
      "--panel": "#101623",
      "--raise": "#17202f",
      "--line": "#263145",
      "--line-strong": "#43536e",
      "--text": "#dfe7f0",
      "--muted": "#a9b7c9",
      "--faint": "#93a2b8",
      "--accent": "#fcee0a",
      "--accent-dim": "rgba(252, 238, 10, 0.12)",
      "--ok": "#3df29b",
      "--err": "#ff4d6d",
      "--warn": "#ffb020",
      "--blue": "#4da6ff",
      "--magenta": "#ff4dd2",
      "--cyan": "#00e0ff",
    },
  },
  {
    label: "matrix",
    vars: {
      "--bg": "#020604",
      "--panel": "#071009",
      "--raise": "#0d1a12",
      "--line": "#14301f",
      "--line-strong": "#1f4a33",
      "--text": "#d3f8d3",
      "--muted": "#96d69a",
      "--faint": "#7dbe84",
      "--accent": "#2bff6f",
      "--accent-dim": "rgba(43, 255, 111, 0.12)",
      "--ok": "#3bff80",
      "--err": "#ff5f56",
      "--warn": "#ffd23f",
      "--blue": "#5aa8ff",
      "--magenta": "#d67eea",
      "--cyan": "#3fe0c5",
    },
  },
  {
    label: "ayu mirage",
    vars: {
      "--bg": "#1f2430",
      "--panel": "#242936",
      "--raise": "#2c3345",
      "--line": "#343c50",
      "--line-strong": "#4a5468",
      "--text": "#cccac2",
      "--muted": "#a3abb8",
      "--faint": "#99a3b5",
      "--accent": "#ffcc66",
      "--accent-dim": "rgba(255, 204, 102, 0.14)",
      "--ok": "#bae67e",
      "--err": "#f28779",
      "--warn": "#ffd173",
      "--blue": "#73d0ff",
      "--magenta": "#d4bfff",
      "--cyan": "#95e6cb",
    },
  },
  {
    label: "palenight",
    vars: {
      "--bg": "#292d3e",
      "--panel": "#2e3247",
      "--raise": "#333850",
      "--line": "#444a66",
      "--line-strong": "#5a6187",
      "--text": "#d3d7f0",
      "--muted": "#a6accd",
      "--faint": "#9ca4cb",
      "--accent": "#c3e88d",
      "--accent-dim": "rgba(195, 232, 141, 0.14)",
      "--ok": "#c3e88d",
      "--err": "#ff7f86",
      "--warn": "#ffcb6b",
      "--blue": "#82aaff",
      "--magenta": "#d0a0f0",
      "--cyan": "#89ddff",
    },
  },
  {
    label: "night owl",
    vars: {
      "--bg": "#011627",
      "--panel": "#0b253a",
      "--raise": "#12314e",
      "--line": "#1d3b53",
      "--line-strong": "#2e5070",
      "--text": "#d6deeb",
      "--muted": "#9db4cb",
      "--faint": "#8aa5c0",
      "--accent": "#f78c6c",
      "--accent-dim": "rgba(247, 140, 108, 0.14)",
      "--ok": "#addb67",
      "--err": "#ff6b68",
      "--warn": "#ffcb6b",
      "--blue": "#82aaff",
      "--magenta": "#d0a0f0",
      "--cyan": "#7fdbca",
    },
  },
  {
    label: "monokai",
    vars: {
      "--bg": "#272822",
      "--panel": "#2c2d26",
      "--raise": "#31322b",
      "--line": "#3b3c34",
      "--line-strong": "#6e6c5f",
      "--text": "#f8f8f2",
      "--muted": "#d0cfc2",
      "--faint": "#a9a79a",
      "--accent": "#a6e22e",
      "--accent-dim": "rgba(166, 226, 46, 0.14)",
      "--ok": "#a6e22e",
      "--err": "#ff6b6b",
      "--warn": "#e6db74",
      "--blue": "#ae81ff",
      "--magenta": "#ff6aa8",
      "--cyan": "#66d9ef",
    },
  },
  {
    label: "horizon",
    vars: {
      "--bg": "#1c1e26",
      "--panel": "#232530",
      "--raise": "#2e303e",
      "--line": "#3a3f52",
      "--line-strong": "#555a6e",
      "--text": "#d5d8da",
      "--muted": "#a2a8bd",
      "--faint": "#98a0b8",
      "--accent": "#ff6d94",
      "--accent-dim": "rgba(255, 109, 148, 0.14)",
      "--ok": "#38e8b0",
      "--err": "#ff6d94",
      "--warn": "#fac29a",
      "--blue": "#26bbd9",
      "--magenta": "#f381c0",
      "--cyan": "#26c6da",
    },
  },
  {
    label: "vesper",
    vars: {
      "--bg": "#101010",
      "--panel": "#161616",
      "--raise": "#1c1c1c",
      "--line": "#242424",
      "--line-strong": "#3d3d3d",
      "--text": "#ffffff",
      "--muted": "#bdbdbd",
      "--faint": "#8f8f8f",
      "--accent": "#ffc799",
      "--accent-dim": "rgba(255, 199, 153, 0.12)",
      "--ok": "#99ffe4",
      "--err": "#ff8080",
      "--warn": "#ffc799",
      "--blue": "#91b4d8",
      "--magenta": "#dcaee8",
      "--cyan": "#8fe8cc",
    },
  },
  {
    label: "poimandres",
    vars: {
      "--bg": "#1b1e28",
      "--panel": "#1f222c",
      "--raise": "#262a38",
      "--line": "#2f3343",
      "--line-strong": "#454b63",
      "--text": "#cfe0ff",
      "--muted": "#9aa7cc",
      "--faint": "#8b96b8",
      "--accent": "#5de4c3",
      "--accent-dim": "rgba(93, 228, 195, 0.12)",
      "--ok": "#5de4c3",
      "--err": "#f387ba",
      "--warn": "#fffac2",
      "--blue": "#89ddff",
      "--magenta": "#fcc5e9",
      "--cyan": "#add7ff",
    },
  },
  {
    label: "flexoki",
    vars: {
      "--bg": "#100f0c",
      "--panel": "#1c1b1a",
      "--raise": "#282726",
      "--line": "#343331",
      "--line-strong": "#575653",
      "--text": "#cecdc3",
      "--muted": "#a4a49c",
      "--faint": "#96948c",
      "--accent": "#e8863a",
      "--accent-dim": "rgba(232, 134, 58, 0.14)",
      "--ok": "#a9c14a",
      "--err": "#ff705e",
      "--warn": "#eab818",
      "--blue": "#5f9fdc",
      "--magenta": "#e579ae",
      "--cyan": "#3ab5a8",
    },
  },
  {
    label: "oxocarbon",
    vars: {
      "--bg": "#161616",
      "--panel": "#1d1d1d",
      "--raise": "#262626",
      "--line": "#393939",
      "--line-strong": "#525252",
      "--text": "#f2f4f8",
      "--muted": "#b4b9c4",
      "--faint": "#9b9fa8",
      "--accent": "#be95ff",
      "--accent-dim": "rgba(190, 149, 255, 0.14)",
      "--ok": "#42be65",
      "--err": "#ff7d70",
      "--warn": "#ffcc75",
      "--blue": "#78a9ff",
      "--magenta": "#ff7eb6",
      "--cyan": "#3ddbd9",
    },
  },
  {
    label: "amber",
    vars: {
      "--bg": "#080300",
      "--panel": "#120a02",
      "--raise": "#1b1104",
      "--line": "#2a1a06",
      "--line-strong": "#452d0a",
      "--text": "#ffc26b",
      "--muted": "#d19a3f",
      "--faint": "#a67c2e",
      "--accent": "#ffb000",
      "--accent-dim": "rgba(255, 176, 0, 0.12)",
      "--ok": "#e8c170",
      "--err": "#ff7a45",
      "--warn": "#ffd23f",
      "--blue": "#e0b268",
      "--magenta": "#d68a52",
      "--cyan": "#e5c687",
    },
  },
  {
    label: "terafox",
    vars: {
      "--bg": "#0f1c1d",
      "--panel": "#132325",
      "--raise": "#1a2c2e",
      "--line": "#233a3e",
      "--line-strong": "#38606a",
      "--text": "#dde6e4",
      "--muted": "#a2b4b4",
      "--faint": "#7e9997",
      "--accent": "#ff8340",
      "--accent-dim": "rgba(255, 131, 64, 0.14)",
      "--ok": "#7aa4a1",
      "--err": "#f26d5e",
      "--warn": "#fda66f",
      "--blue": "#6fb1c4",
      "--magenta": "#e086a8",
      "--cyan": "#a1cdd8",
    },
  },
  //deepseek
  {
    label: "solarized light",
    scheme: "light",
    vars: {
      "--bg": "#fdf6e3",
      "--panel": "#fbf2da",
      "--raise": "#eee8d5",
      "--line": "#e0d9c1",
      "--line-strong": "#a9b3ad",
      "--text": "#073642",
      "--muted": "#566c73",
      "--faint": "#5e6b6c",
      "--accent": "#b54314",
      "--blue": "#216e9f",
      "--magenta": "#a8316b",
      "--cyan": "#227470",
      "--accent-dim": "rgba(203, 75, 22, 0.12)",
      "--ok": "#616f00",
      "--err": "#c42c2a",
      "--warn": "#866300",
    },
  },
  {
    label: "latte",
    scheme: "light",
    vars: {
      "--bg": "#eff1f5",
      "--panel": "#ffffff",
      "--raise": "#e6e9ef",
      "--line": "#dce0e8",
      "--line-strong": "#bcc0cc",
      "--text": "#4c4f69",
      "--muted": "#64677c",
      "--faint": "#666876",
      "--accent": "#8738ed",
      "--blue": "#1c5fe4",
      "--magenta": "#8738ed",
      "--cyan": "#157381",
      "--accent-dim": "rgba(136, 57, 239, 0.12)",
      "--ok": "#307820",
      "--err": "#d00f38",
      "--warn": "#905f0b",
    },
  },
  {
    label: "paper",
    scheme: "light",
    vars: {
      "--bg": "#f7f6f2",
      "--panel": "#ffffff",
      "--raise": "#eaeae3",
      "--line": "#dcded4",
      "--line-strong": "#b4b9a9",
      "--text": "#30362c",
      "--muted": "#5c6555",
      "--faint": "#646a5e",
      "--accent": "#586c3c",
      "--accent-dim": "rgba(88, 108, 60, 0.10)",
      "--ok": "#2d7830",
      "--err": "#c22a24",
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
      "--bg": "#f3f6fa",
      "--panel": "#ffffff",
      "--raise": "#e7edf5",
      "--line": "#d8e0eb",
      "--line-strong": "#aabbd1",
      "--text": "#27364b",
      "--muted": "#53657d",
      "--faint": "#5c6c7f",
      "--accent": "#365fa0",
      "--accent-dim": "rgba(54, 95, 160, 0.10)",
      "--ok": "#287452",
      "--err": "#b43f56",
      "--warn": "#886116",
      "--blue": "#365fa0",
      "--magenta": "#8154a1",
      "--cyan": "#247078",
    },
  },
  {
    label: "polar",
    scheme: "light",
    vars: {
      "--bg": "#e9edf4",
      "--panel": "#f6f8fb",
      "--raise": "#dde3ee",
      "--line": "#d2d9e6",
      "--line-strong": "#a9b4c7",
      "--text": "#2e3440",
      "--muted": "#4c566a",
      "--faint": "#4f5a72",
      "--accent": "#3f628f",
      "--accent-dim": "rgba(63, 98, 143, 0.10)",
      "--ok": "#466338",
      "--err": "#993d47",
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
      "--bg": "#fdf1f6",
      "--panel": "#fff8fa",
      "--raise": "#f3dfe8",
      "--line": "#ead4de",
      "--line-strong": "#cfa2b6",
      "--text": "#4b3a44",
      "--muted": "#63505a",
      "--faint": "#6b5862",
      "--accent": "#a83558",
      "--accent-dim": "rgba(168, 53, 88, 0.10)",
      "--ok": "#3c7050",
      "--err": "#ab2e4e",
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
  background: cssVar("--bg"),
  foreground: cssVar("--text"),
  cursor: cssVar("--accent"),
  cursorAccent: cssVar("--bg"),
  selectionBackground: cssVar("--line-strong"),
  selectionForeground: cssVar("--text"),
  black: theme.scheme === "light" ? cssVar("--text") : cssVar("--bg"),
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
type PaneState = { cmd: string; sid?: string; effort?: string; sessionId?: string };

type Startup = { label: string; cmd: string };
const DEFAULT_STARTUPS: Startup[] = [
  { label: "claude", cmd: "claude" },
  { label: "codex", cmd: "codex" },
  { label: "opencode", cmd: "opencode" },
  { label: "powershell", cmd: "" },
  { label: "cmd", cmd: "cmd" },
  { label: "git bash", cmd: '& "$env:ProgramFiles\\Git\\bin\\bash.exe" -i -l' },
];
let startups: Startup[] = [...DEFAULT_STARTUPS];
let fontSize = 13; // Ctrl+= / Ctrl+- / Ctrl+0, global to every pane, persisted
let paneCount = 1; // the new-thread form's pane count, persisted so it keeps your last pick
let silent = false; // Preferences → Notifications: no chimes, no taskbar flash; persisted
let planUsage = true; // Preferences → Plan usage: off = no top-bar chips and no account API calls; persisted

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
  if (silent) return; // every sound routes through here: the wake blip and the mic cues
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
  /** From the statusline tee: what the pane runs RIGHT NOW, ahead of the
   * transcript — follows a /model typed by hand the moment it runs. "" until
   * the tee has fired. */
  liveModel: string;
  liveEffort: string;
};

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
type Plan = { tier: string; limits: Limit[]; stale: boolean; bankedResets?: number; bankedResetExpiries?: (string | null)[]; note?: string };
type PlanProvider = "claude" | "codex";
const PLAN_PROVIDERS = {
  claude: { name: "Claude", button: "plan", command: "plan_usage", url: "https://claude.ai/settings/usage" },
  codex: { name: "Codex", button: "codex-plan", command: "codex_plan_usage", url: "https://chatgpt.com/codex/settings/usage" },
};
const plans: Partial<Record<PlanProvider, Plan>> = {};
const planErrors: Partial<Record<PlanProvider, string>> = {};

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
let recording: { pane: Pane; prefix: Prefix; lang: Lang } | null = null;
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
  try {
    await invoke("dictate_start");
    recording = { pane, prefix, lang };
    if (prefix.text) pane.term.paste(prefix.text);
    micState("rec");
    chime(660, 990, 0.09, 0.18); // rising: mic open
  } catch (e) {
    micState("err", String(e));
  }
}

async function micStop() {
  const r = recording;
  if (!r) return;
  const { pane: p, prefix: pre } = r;
  // null, not "": whisper takes Option<&str> and None is what means "detect".
  const code = r.lang.code || null;
  recording = null;
  micState("busy");
  chime(990, 660, 0.08, 0.18); // falling: mic closed
  try {
    const text = await invoke<string>("dictate_stop", { lang: code });
    micState("");
    if (text) {
      p.term.paste(text); // not pty_write: paste honors bracketed-paste mode
      if (pre.enter) {
        // Codex reads an Enter that lands right behind pasted text as part of
        // the paste (a newline in the composer), so let the input settle first.
        await p.settle(150, 1000);
        invoke("pty_write", { id: p.id, data: "\r" });
      }
    } else if (pre.text) {
      // A mis-tapped F4 with nothing said: take the prefix back out instead of
      // leaving a bare "/prompt " in the input. Backspaces have to go raw — a
      // DEL inside a bracketed paste is literal text, not a keypress.
      // ponytail: blind, so it eats anything you typed into the pane while
      // dictating. You weren't typing, you were talking.
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
// the rest.
const BOOTS = 2;
let booting = 0;
const bootWaiting: (() => void)[] = [];
async function bootSlot(): Promise<() => void> {
  while (booting >= BOOTS) await new Promise<void>((r) => bootWaiting.push(r));
  booting++;
  return () => {
    booting--;
    bootWaiting.shift()?.();
  };
}
async function booted(pane: string) {
  for (let i = 0; i < 60; i++) {
    if (await invoke<boolean>("pane_booted", { pane }).catch(() => true)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

class Pane {
  readonly id = uid();
  readonly el = document.createElement("div");
  readonly term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize,
    lineHeight: 1.25,
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true, // parser.registerOscHandler
    theme: termTheme(),
  });
  busy = false;
  waiting = false; // the agent rang: turn finished / wants input
  waitingSince = 0;
  dead = false; // the process exited; Enter relaunches it
  appTitle = ""; // OSC 0/2 from the running app
  label = ""; // appTitle as shown: spinner stripped, a name when there is none
  startup = ""; // command this pane booted with, persisted for restore
  agent: Agent = "shell"; // what `startup` runs, see agent.ts
  sid = ""; // and the claude session it owns, so the next launch resumes it
  sessionId?: string; // Provider-reported ID, never a generated placeholder.
  effort = ""; // session's effort per the last hook, "" until one reports
  usage: Usage | null = null; // null until claude is up in this pane; zeroed until its first turn
  lastOut = 0; // when the pty last drew anything, for settle()
  lastIn = 0; // when you last typed, so an echo doesn't read as the agent working
  /** What the config panel last set, each stamped with the turn count at the
   * time. `/model` and `/effort` change nothing the transcript records until the
   * next turn runs, so these are what the panel shows meanwhile. Stamped one by
   * one: setting the effort says nothing about the model, and must not discard
   * what was chosen for it. */
  want: { model?: Set_; effort?: Set_ } | null = null;
  readonly search = new SearchAddon();

  private fit = new FitAddon();
  private gl?: WebglAddon;
  private host = document.createElement("div");
  private title = document.createElement("span");
  private stateTag = document.createElement("span");
  private gauge = document.createElement("span");
  private cfg: HTMLButtonElement;
  private unlisten: UnlistenFn[] = [];
  private out = new Channel<string>();
  private idle = 0;
  private codexStatus = false;
  private resumeNotice?: HTMLElement;
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
    copy.append(this.rowName, this.rowLabel);
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
    const head = document.createElement("div");
    head.className = "pane-head";
    const actions = document.createElement("div");
    actions.className = "pane-actions";
    actions.append(
      this.cfg,
      mini(glyph("maximize"), "Zoom (F2)", () => this.th.toggleZoom(this)),
      mini(glyph("x"), "Close pane", () => this.th.closePane(this)),
    );
    head.append(this.ico, this.title, this.stateTag, this.gauge, actions);
    this.el.append(head, this.host);
    this.el.addEventListener("mousedown", () => this.th.focusPane(this));
    this.term.attachCustomKeyEventHandler((e) => {
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
    // Registered after web-links, so a URL still wins over the path shape inside it.
    this.term.registerLinkProvider({
      provideLinks: (y, cb) => {
        cb(
          fileLinks(this.term.buffer.active, y).map((link) => ({
            ...link,
            activate: async () => {
              try {
                const target = /^~[\\/]/.test(link.text) ? await join(await homeDir(), link.text.slice(2)) : link.text;
                const path = target.replace(/:\d+(?::\d+)?$/, "");
                if (imageMime(path)) return openTab(this.th, basename(path), { file: path });
                await invoke("open_vscode", {
                  dir: this.th.dir,
                  goto: ABS_RE.test(target) ? target : `${this.th.dir}\\${target}`,
                });
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
    // An agent owns the alternate screen, and what scrolls off it is gone
    // either way — a deep normal-buffer scrollback would only hold memory.
    this.term.options.scrollback = this.agent === "shell" ? 5000 : 1500;
    this.term.open(this.host);
    // WebGL from the start, hidden or not (the budget in gpu() still caps it).
    // A hidden pane on the DOM renderer re-renders every row on every scroll
    // (xterm's selection refresh bypasses its render pause) and, with no width
    // to measure in display:none, caches nothing — 8 restored agent panes
    // streaming in the background ate ~90% of the main thread; on WebGL, ~20%.
    this.gpu(true);
    this.term.onTitleChange((t) => {
      // Agents redraw the title with a spinner glyph while working, ~10 times a
      // second; paint() strips it, so those are the same title — skip them.
      const same = t.replace(SPIN, "") === this.appTitle.replace(SPIN, "");
      this.appTitle = t;
      if (!same) this.paint();
    });
    this.term.onData((d) => {
      // A dead pane has nowhere to send keys; Enter brings the process back.
      if (this.dead) return void (d === "\r" && this.spawn(true));
      this.lastIn = Date.now();
      const waitingSince = this.waitingSince;
      void invoke("pty_write", { id: this.id, data: d }).then(() => {
        if (this.waitingSince === waitingSince) this.seen(); // A failed write must leave the attention signal intact.
        if (d === "\x1b" && this.agent === "codex" && this.busy) ((this.busy = false), this.paint());
      }, e => toast(`Could not write to ${this.agent}: ${String(e)}`));
    });
    this.term.parser.registerOscHandler(133, (d) => (this.mark(d), true));
    // Codex reports a finished turn (and an approval prompt) as OSC 9 — see
    // CODEX_FLAGS in agent.ts. OSC 99 is the kitty notification opentui TUIs
    // use; "p=?" there is a capability probe, not news.
    this.term.parser.registerOscHandler(9, () => (this.wake(), true));
    this.term.parser.registerOscHandler(99, (d) => (d.includes("p=?") || this.wake(), true));
    // Claude rings BEL when a turn finishes (Stop hook / idle prompt).
    this.term.onBell(() => this.wake());
    this.fit.fit();

    this.unlisten.push(
      await listen<number>(`pty-exit:${this.id}`, (e) => {
        this.dead = true;
        this.busy = false;
        this.waiting = false;
        this.term.write(`\r\n\x1b[90m[exited ${e.payload}] — Enter relaunches\x1b[0m\r\n`);
        this.paint();
      }),
    );
    // Channel, not an event: stdout is the hot path and channels skip the
    // event bus' JSON round-trip through every other listener.
    this.out.onmessage = (d) => {
      this.lastOut = Date.now(); // settle() waits on this
      this.term.write(d, () => { if (this.agent === "codex") this.activity(); });
      if (this.agent !== "codex") this.activity();
    };
    await this.spawn(!!sid);
    new ResizeObserver(() => this.resize()).observe(this.host);
  }

  /** Start (or restart) the pane's process. `resume` = pick the session up
   * where it was. For claude that means `--resume`, which exits on an id that
   * was never written to — a pane opened and never used — so the transcript
   * is checked first and a fresh `--session-id` boot takes over. A codex or
   * opencode pane with no reported session yet (made before Loom captured one)
   * asks once instead of guessing. */
  async spawn(resume: boolean) {
    if (resume && this.agent === "codex" && this.sessionId && !ownSession(this.startup)) {
      try {
        if (!(await invoke<boolean>("has_codex_session", { sid: this.sessionId }))) this.sessionId = undefined;
      } catch (e) {
        this.dead = true;
        this.term.write(`\r\nCould not check saved session: ${String(e)} — Enter retries\r\n`);
        this.paint();
        return;
      }
    }
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
      return;
    }
    this.resumeNotice?.remove();
    this.resumeNotice = undefined;
    if (!resume) this.sessionId = undefined;
    if (this.dead) this.term.reset(); // the old TUI's screen is not the new one's
    this.dead = false;
    this.codexStatus = false;
    const can =
      resume &&
      (this.agent !== "claude" ||
        (await invoke<boolean>("has_session", { dir: this.th.dir, sid: this.sid }).catch(() => false)));
    const release = restoring && this.agent === "claude" ? await bootSlot() : undefined;
    const ok = await invoke("pty_spawn", {
      id: this.id,
      cwd: this.th.dir,
      argv: launch(this.startup, this.sid, can, this.effort || undefined, this.sessionId),
      codexStateId: this.agent === "codex" ? this.sid : undefined,
      cols: this.term.cols,
      rows: this.term.rows,
      onOut: this.out,
    }).then(() => true, (e) => {
      this.dead = true;
      this.term.write(`\r\n\x1b[31m${e}\x1b[0m — Enter retries\r\n`);
      return false;
    });
    if (release) void (ok ? booted(this.id) : Promise.resolve()).then(release);
    this.paint();
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
      const rows = await invoke<{ id: string; title: string }[]>(`${this.agent}_sessions`, { dir: this.th.dir });
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
    if (this.agent === "codex") {
      // ponytail: codex keeps drawing while idle (the astra prompt's star field),
      // so output alone says nothing. Its "Working (3s • esc to interrupt)"
      // line is the tell; OSC 9 (wake) or Esc ends the turn. Read the rendered
      // screen after xterm joins PTY chunks, including the first post-key redraw.
      const status = /esc\s+to\s+interrupt/i.test(this.screen());
      if (status && !this.codexStatus && !this.waiting) ((this.busy = true), this.paint());
      this.codexStatus = status;
      return;
    }
    if (Date.now() - this.lastIn < 300) return;
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => ((this.busy = false), this.paint()), 1500);
    if (this.busy || this.waiting) return;
    this.busy = true;
    this.paint();
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
  /** rAF-coalesced: splitter drags fire ResizeObserver per pointermove per pane —
   * one fit per frame, and IPC only when the cell grid actually changed. */
  resize() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      if (!this.host.clientWidth || !this.host.clientHeight) return;
      const { cols, rows } = this.term;
      this.fit.fit();
      if (this.term.cols === cols && this.term.rows === rows) return;
      invoke("pty_resize", {
        id: this.id,
        cols: this.term.cols,
        rows: this.term.rows,
      }).catch(() => {});
    });
  }

  run(cmd: string) {
    invoke("pty_write", { id: this.id, data: cmd + "\r" });
    this.th.focusPane(this);
  }

  /** Alt+Shift+Arrow scrolling: hand xterm a wheel event on the element it already
   * listens on and let it encode one for whatever the app negotiated. See
   * scroll.ts for why this isn't a hand-written escape sequence. */
  scroll(up: boolean) {
    this.term.element?.dispatchEvent(
      new WheelEvent("wheel", wheelInit(up, this.host.getBoundingClientRect())),
    );
  }

  /** Turn finished: flag the pane yellow and blip, until you look at it.
   * The marker carries the session's effort level — keep the last-known one
   * (letters only: it lands on a command line at next boot). */
  wake(effort?: string) {
    if (effort && /^[a-z]+$/.test(effort) && effort !== this.effort) {
      this.effort = effort;
      save();
    }
    if (this.waiting) return;
    this.waiting = true;
    this.waitingSince = Date.now();
    this.busy = false;
    this.paint();
    beep();
    // Loom isn't on screen: flash the taskbar button too. Cleared in main().
    // The sidebar dot and the `N waiting` chip still say who wants you in silent mode.
    if (!silent && !document.hasFocus())
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
  }

  private seen() {
    if (!this.waiting) return;
    this.waiting = false;
    this.paint();
  }

  paint(index = this.th.panes.indexOf(this)) {
    // cmd.exe and powershell.exe title themselves with their own path until
    // something under them sets one (codex never does) — the agent's name
    // says more, and a shell's says nothing.
    const app = /\.exe\s*$/i.test(this.appTitle) ? (this.agent === "shell" ? "" : this.agent) : this.appTitle;
    // Provider title spinners go: the pane's own state says "working" once, in
    // Loom's colours, wherever the pane shows.
    const own = this.agent === "shell" ? app : app.replace(SPIN, "");
    const title = (this.label = own && own !== this.agent ? own : this.agent === "shell" ? "Terminal" : "Agent session");
    const state = paneState(this);
    const word = this.dead ? "Exited" : this.waiting ? "Waiting" : this.busy ? "Working" : "Ready";
    this.title.textContent = title;
    this.title.title = `${this.agent}, pane ${index + 1}: ${this.appTitle || title}`;
    this.stateTag.textContent = state ? word : "";
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
    this.th.paint(); // the thread row sums its panes
    // Exiting or relaunching changes whether this pane can be dictated into.
    if (this.th === current && this.th.active === this) micRefresh();
  }

  /** What the pane is showing, so a command can be checked for having taken.
   * The visible rows only: a TUI keeps its answer on screen. */
  screen() {
    const buf = this.term.buffer.active;
    let s = "";
    for (let y = 0; y < this.term.rows; y++)
      s += (buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "") + "\n";
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
    const drawn = u?.ctx === this.usage?.ctx && u?.turns === this.usage?.turns;
    this.usage = u;
    if (drawn) return;
    if (!u) return void (this.gauge.className = "ctx hidden");
    const pct = Math.min(100, Math.round((u.ctx / u.window) * 100));
    // 90% is about where Claude Code starts compacting on you.
    this.gauge.className = `ctx${pct >= 90 ? " hot" : pct >= 70 ? " warm" : ""}`;
    this.gauge.style.setProperty("--pct", `${pct}%`);
    this.gauge.textContent = `${pct}%`;
    this.gauge.title =
      `Context ${tok(u.ctx)} of ${tok(u.window)} — ${pct}% full\n` +
      `${u.turns} turns · ${tok(u.output)} out · ${tok(u.input + u.cacheWrite)} in · ` +
      `${tok(u.cacheRead)} cached\nClick for what filled it`;
  }

  focus() {
    if (!dashboardPreview.open || dashboardPreviewPane !== this) this.seen(); // Inspecting a preview stays unread until input is sent.
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
    // Closing the pane mid-sentence: drop the recording, there's nowhere to put it.
    if (recording?.pane === this) {
      recording = null;
      micState("");
      mic(() => invoke("dictate_stop").then(() => {}, () => {}));
    }
    clearTimeout(this.idle);
    cancelAnimationFrame(this.raf);
    this.unlisten.forEach((u) => u());
    this.out.onmessage = () => {};
    this.gpu(false);
    this.term.dispose();
    this.el.remove();
    this.row.remove();
    this.pip.remove();
    await invoke("pty_kill", { id: this.id }).catch(() => {});
  }

  /** OSC 133 from shell-init.ps1. All it drives is the pane's busy state — ;C a
   * command started, ;D it exited. A/B/E are emitted and ignored. */
  private mark(data: string) {
    const kind = data.split(";")[0];
    if (kind !== "C" && kind !== "D") return;
    this.busy = kind === "C";
    this.paint();
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
  private label = document.createElement("button");
  private list = document.createElement("div");
  private pips = document.createElement("span");
  private stat = document.createElement("span");
  private age = document.createElement("span");
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
    new ResizeObserver(() => { if (this.grid.clientWidth) this.relayout(); }).observe(this.grid);
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
    meta.append(this.pips, this.stat, this.age);
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
    this.stat.innerHTML = statHtml(s);
    if (this === current) paintHead();
  }

  /** Does this row survive the sidebar filter? Name, branch, or an agent's title. */
  matches(q: string) {
    const hay = [basename(this.repo), this.name, this.branch, ...this.panes.map((p) => `${p.agent} ${p.appTitle}`)].join(" ").toLowerCase();
    return hay.includes(q);
  }

  async addPane(st: PaneState = { cmd: startups[0]?.cmd ?? "" }) {
    if (this.panes.length >= MAX_PANES) return;
    const p = new Pane(this);
    if (st.sessionId && validSessionId(st.sessionId)) p.sessionId = st.sessionId;
    if (st.effort) p.effort = st.effort;
    this.panes.push(p);
    this.grid.append(p.el);
    this.list.append(p.row); // sidebar order = grid order
    this.pips.append(p.pip);
    dragRow(p.row, () => this.panes.map((q) => q.row), (over, after) => {
      moveNextTo(this.panes, p, this.panes.find((q) => q.row === over)!, after);
      this.reordered(p);
    });
    this.relayout();
    await p.start(st.cmd, st.sid);
    this.focusPane(p);
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

  async closePane(p: Pane) {
    const i = this.panes.indexOf(p);
    if (i === -1) return;
    // A misclick on ✕ would otherwise kill a running agent on the spot.
    if (p.agentUp && !(await confirm(`Close ${p.agent} pane?`, {
      title: "Loom", action: "Close pane",
      detail: "This stops the running agent and removes this pane from the workspace. Your project files stay on disk.",
    }))) return;
    if (this.zoomed === p) this.toggleZoom(p);
    this.panes.splice(i, 1);
    const cleanup = p.dispose();
    this.relayout();
    this.focusPane(this.panes[Math.min(i, this.panes.length - 1)] ?? null);
    save(); // else the pane is back on the next launch
    await cleanup;
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
    const cleanup = Promise.all(this.panes.splice(0).map((p) => p.dispose()));
    this.grid.remove();
    this.row.remove();
    await cleanup;
  }
}

// --- app state ------------------------------------------------------------
const threads: Thread[] = [];
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
        panes: t.panes.map((p) => ({ cmd: p.startup, sid: p.sid, sessionId: p.sessionId, effort: p.effort || undefined })),
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
      reposFolded: [...reposFolded],
      startups,
      prefixes,
      prefix: prefixes.indexOf(prefix),
      langs,
      lang: langs.indexOf(lang),
      theme: theme.label,
      fontSize,
      paneCount,
      silent,
      planUsage,
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

function revealPane(p: Pane) {
  p.th.active = p; // Switching must not clear a different pane's notification.
  p.th.tab = null;
  show(p.th);
  if (p.th.zoomed && p.th.zoomed !== p) p.th.toggleZoom(p);
  if (matchMedia("(max-width: 1100px)").matches) toggleChanges(false);
  p.el.scrollIntoView({ block: "nearest" });
}

/** The header chip: how many panes want you, across every thread. One glance
 * covers what a zoomed pane or another thread's tab would hide. */
let waitingShown = -1;
let pickerRaf = 0;
function paintWaiting() {
  const n = threads.reduce((s, t) => s + t.panes.filter((p) => p.waiting).length, 0);
  // Every pane repaint lands here; rewriting the same text would still relayout the bar.
  if (n !== waitingShown) {
    waitingShown = n;
    const b = $("#waiting");
    b.classList.toggle("hidden", !n);
    b.textContent = `${n} waiting`;
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
const paneState = (p: Pane) => p.dead ? "dead" : p.waiting ? "waiting" : p.busy ? "busy" : "";

let dashboardOpen = false;
let dashboardFilter = "all";
let dashboardTimer = 0;
let dashboardSignature = "";
let dashboardCompact = false;
let dashboardNext: Pane | undefined;
let dashboardPreviewPane: Pane | null = null;
let dashboardPreviewSlot: Comment | null = null;
const dashboardPreview = $<HTMLDialogElement>("#dashboard-preview");
const dashboardPreviewOutput = $("#dashboard-preview-output");
let dashboardControlBusy = false;
const dashboardQuery = $<HTMLInputElement>("#dashboard-query");
const dashboardProject = $<HTMLSelectElement>("#dashboard-project");

function toggleDashboard(on = !dashboardOpen) {
  dashboardOpen = on;
  document.body.classList.toggle("dashboard-open", on);
  $("#dashboard").classList.toggle("hidden", !on);
  $("#dashboard-btn").setAttribute("aria-pressed", String(on));
  clearInterval(dashboardTimer);
  if (on) {
    hideMenu();
    togglePreferences(false);
    closeFind(false);
    if (recording) mic(micStop);
    if (matchMedia("(max-width: 760px)").matches) toggleSide(false);
    renderDashboard();
    dashboardQuery.focus();
    // Only read the existing terminal buffers while the overview is visible.
    dashboardTimer = window.setInterval(() => { if (!document.hidden) renderDashboard(); }, 1000);
  } else {
    closeDashboardPreview();
    current?.panes.forEach(p => p.resize());
  }
  micRefresh();
  save();
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
    const buf = p.term.buffer.active;
    const lines: string[] = [];
    // ponytail: rendered terminal lines, not an inferred task summary. Provider task events can replace this when available.
    for (let y = buf.baseY; y < buf.baseY + p.term.rows; y++) {
      const line = buf.getLine(y);
      const text = line?.translateToString(false) ?? "";
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const preview = lines.map(line => line.trim()).filter(Boolean).slice(-3).join("\n");
    const stamp = state === "waiting" ? p.waitingSince : p.lastOut;
    const age = stamp ? `${state === "waiting" ? "Waiting" : "Output"} ${ago(stamp)}` : "No output yet";
    return { th, p, state, preview, age };
  }));
  const scoped = all.filter(({ th, p, preview }) => (!dashboardProject.value || th.repo === dashboardProject.value)
    && (!q || `${th.repo} ${th.name} ${th.branch} ${p.agent} ${p.label} ${preview}`.toLowerCase().includes(q)));
  const counts = $("#dashboard-counts");
  const labels: Record<string, string> = { all: "All sessions", waiting: "Waiting for you", busy: "Working", "": "Idle", dead: "Exited" };
  if (!counts.childElementCount) {
    for (const state of ["all", "waiting", "busy", "", "dead"]) {
      const button = document.createElement("button");
      button.dataset.state = state;
      button.append(document.createElement("b"), document.createElement("span"));
      button.querySelector("span")!.textContent = state === "all" ? "All" : state === "waiting" ? "Waiting" : labels[state];
      button.onclick = () => { dashboardFilter = state; renderDashboard(); };
      counts.append(button);
    }
  }
  for (const button of counts.querySelectorAll("button")) {
    const state = button.dataset.state!;
    button.querySelector("b")!.textContent = String(state === "all" ? scoped.length : scoped.filter(r => r.state === state).length);
    button.setAttribute("aria-pressed", String(dashboardFilter === state));
  }
  const waiting = all.filter(r => r.state === "waiting").length;
  $("#dashboard-summary").textContent = `${all.length} sessions across ${threads.length} threads. ${waiting ? `${waiting} waiting for you.` : "Nothing waiting for you."}`;
  $<HTMLButtonElement>("#dashboard-back").disabled = !current;
  const rows = scoped.filter(r => dashboardFilter === "all" || r.state === dashboardFilter)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.state === "waiting" ? a.p.waitingSince - b.p.waitingSince : 0));
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
  // Keep the DOM and keyboard focus stable between unchanged refreshes.
  const signature = JSON.stringify([dashboardCompact, rows.map(({ th, p, state, preview, age }) => [p.id, th.name, th.repo, th.branch, p.agent, p.label, state, preview, age])]);
  if (signature !== dashboardSignature) {
    dashboardSignature = signature;
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    const fragment = document.createDocumentFragment();
    let group: string | undefined;
    for (const { th, p, state, preview, age } of rows) {
      if (state !== group) {
        group = state;
        const heading = document.createElement("h2");
        heading.className = "dashboard-group";
        heading.dataset.state = state;
        heading.textContent = `${labels[state]} (${rows.filter(r => r.state === state).length})`;
        fragment.append(heading);
      }
      const card = document.createElement("div");
      card.className = "dashboard-card";
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
      const activity = document.createElement("span");
      activity.className = "dashboard-activity";
      const title = document.createElement("span");
      title.textContent = p.label;
      const output = document.createElement("pre");
      output.textContent = preview || "No terminal output yet. Open the session to get started.";
      output.setAttribute("aria-label", "Latest terminal lines");
      activity.append(title, output);
      const status = document.createElement("span");
      status.className = "dashboard-status";
      status.textContent = labels[state];
      const time = document.createElement("span");
      time.className = "dashboard-age";
      time.textContent = age;
      row.append(identity, location, activity, status, time);
      const previewPane = () => {
        dashboardPreviewPane = p;
        dashboardPreviewSlot = document.createComment("preview pane returns here");
        p.el.replaceWith(dashboardPreviewSlot);
        dashboardPreviewOutput.append(p.el);
        $("#dashboard-control-result").textContent = "";
        dashboardPreview.showModal();
        $("#dashboard-preview-close").focus(); // Opening a preview should not focus the terminal or acknowledge an alert.
        p.gpu(true);
        p.resize();
        renderDashboard();
      };
      row.onclick = dashboardCompact ? () => revealPane(p) : previewPane;
      const open = document.createElement("button");
      open.className = dashboardCompact ? "dashboard-preview-button" : "dashboard-open-terminal";
      open.innerHTML = dashboardCompact ? '<i class="i i-eye" aria-hidden="true"></i>' : '<i class="i i-terminal" aria-hidden="true"></i><span>Open terminal</span>';
      open.dataset.key = `${dashboardCompact ? "preview" : "open"}-${p.id}`;
      open.title = `${dashboardCompact ? "Preview" : "Open"} ${p.agent} in ${th.name}, pane ${th.panes.indexOf(p) + 1}`;
      open.setAttribute("aria-label", open.title);
      if (dashboardCompact) open.setAttribute("aria-haspopup", "dialog");
      open.onclick = dashboardCompact ? previewPane : () => revealPane(p);
      card.append(row, open);
      fragment.append(card);
    }
    list.replaceChildren(fragment);
    if (focused) ([...list.querySelectorAll<HTMLButtonElement>("button")].find(b => b.dataset.key === focused) ?? dashboardQuery).focus({ preventScroll: true });
  }
  $("#dashboard-empty").classList.toggle("hidden", rows.length > 0);
  $("#dashboard-empty").textContent = !all.length ? "No sessions yet. Create a thread to start an agent."
    : q || dashboardProject.value ? "No sessions match. Try another search or project."
    : dashboardFilter === "waiting" ? "Nothing waiting for you. Other sessions will appear here when they need attention."
    : "No sessions with this status.";
  if (dashboardPreview.open) {
    const selected = all.find(r => r.p === dashboardPreviewPane);
    if (!selected) return closeDashboardPreview();
    const { p, th, state, age } = selected;
    $("#dashboard-preview-title").textContent = `${th.name} / ${p.agent}`;
    $("#dashboard-preview-meta").textContent = `${th.repo} / ${th.branch || th.dir} / Pane ${th.panes.indexOf(p) + 1}`;
    $("#dashboard-preview-status").textContent = `${labels[state]} · ${age}`;
    $("#dashboard-preview-status").dataset.state = state;
    const u = p.usage;
    $("#dashboard-preview-usage").textContent = u ? [u.liveModel || u.model, u.window ? `${Math.round(u.ctx / u.window * 100)}% context` : "", `${u.mainTurns} turns`].filter(Boolean).join(" · ") : "";
    $<HTMLButtonElement>("#dashboard-preview-open").disabled = dashboardControlBusy;
    $<HTMLButtonElement>("#dashboard-preview-close").disabled = dashboardControlBusy;
    const process = $<HTMLButtonElement>("#dashboard-process");
    process.disabled = dashboardControlBusy;
    process.textContent = p.dead ? needsSession(p) ? "Choose session" : "Relaunch" : "Stop process";
  }
}

function closeDashboardPreview() {
  const p = dashboardPreviewPane;
  if (!p) return;
  if (dashboardPreviewSlot) {
    if (p.th.panes.includes(p)) {
      dashboardPreviewSlot.replaceWith(p.el);
      p.resize();
    } else dashboardPreviewSlot.remove();
    dashboardPreviewSlot = null;
  }
  dashboardPreviewPane = null;
  dashboardPreview.close();
  const key = dashboardCompact ? `preview-${p.id}` : p.id;
  if (dashboardOpen) ([...$("#dashboard-list").querySelectorAll<HTMLButtonElement>("button")].find(b => b.dataset.key === key) ?? dashboardQuery).focus({ preventScroll: true });
}

dashboardQuery.oninput = renderDashboard;
dashboardProject.onchange = renderDashboard;
$("#dashboard-btn").onclick = () => { if (dashboardOpen) show(current); else toggleDashboard(true); };
$("#dashboard-back").onclick = () => show(current);
$("#dashboard-next").onclick = jumpWaiting;
$("#dashboard-reset").onclick = () => {
  dashboardQuery.value = "";
  dashboardProject.value = "";
  dashboardFilter = "all";
  renderDashboard();
  dashboardQuery.focus();
};
$("#dashboard-compact").onclick = () => { dashboardCompact = !dashboardCompact; renderDashboard(); save(); };
$("#dashboard-preview-close").onclick = closeDashboardPreview;
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
    if (stop) await invoke("pty_kill", { id: p.id });
    else await p.spawn(true);
  } catch (error) {
    if (dashboardPreviewPane === p) $("#dashboard-control-result").textContent = String(error);
  } finally {
    dashboardControlBusy = false;
    renderDashboard();
  }
};

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
    h.append(glyph("chevron"), name, count, mini(glyph("plus"), `New worktree in ${basename(repo)}`, () => newThread(repo)));
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

async function openThread(st: ThreadState, panes: PaneState[], layout: LayoutMode = "cols") {
  const th = new Thread(st.repo, st.dir, st.branch, st.name);
  th.layout = layout;
  th.open = st.open ?? (st.folded ? false : undefined);
  threads.push(th); // before any await, so restore order is saved order
  // A thread on the checkout itself follows whatever branch is checked out
  // there, so ask git rather than trust what was saved.
  if (st.dir === st.repo)
    git(st.dir, "rev-parse", "--abbrev-ref", "HEAD")
      .then((b) => ((th.branch = b.trim()), th.setStat(th.changed)))
      .catch(() => {});
  if (!repos.includes(st.repo)) repos.push(st.repo);
  $("#stage").append(th.grid);
  // Restoring N threads used to show() each in turn: N sidebar rebuilds, and
  // every pane got a WebGL context only to lose it when the next thread showed.
  // main() renders the sidebar and shows the saved thread once all are up.
  if (restoring) th.grid.classList.add("hidden");
  else (renderSide(), show(th));
  // Parallel: a spawn is up to ~1s. addPane pushes its pane before the first
  // await, so mapping in order still lands them in order.
  await Promise.all(panes.slice(0, MAX_PANES).map((st) => th.addPane(st)));
  if (!th.panes.length) await th.addPane();
  th.colW = st.colW?.filter(w => Number.isFinite(w) && w > 0) ?? [];
  th.rowH = st.rowH?.filter(w => Number.isFinite(w) && w > 0) ?? [];
  th.active = th.panes[st.active ?? 0] ?? th.panes[0];
  if (th.panes[st.zoomed ?? -1]) th.toggleZoom(th.panes[st.zoomed!]);
  th.commitDraft = st.commitDraft ?? "";
  th.tabs = (st.tabs ?? []).filter(t => t.source).map(t => ({ ...t, load: diffLoader(th, t.source) }));
  th.tab = th.tabs[st.tab ?? -1] ?? null;
  th.relayout();
  save();
  void pollStats();
  return th;
}

const git = (dir: string, ...args: string[]) => invoke<string>("git_run", { dir, args });

/** Extra exit codes count as success — `git diff --no-index` says 1 for "they differ". */
const gitOk = (dir: string, ok: number[], ...args: string[]) =>
  invoke<string>("git_run", { dir, args, ok });

/** What deleting a worktree destroys that exists nowhere else: uncommitted
 * files, and with `branch` the commits no other branch or remote holds. Empty
 * when nothing, else warning lines framed for the confirm's detail. */
async function atRisk(th: Thread, branch: boolean): Promise<string> {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const [dirty, only] = await Promise.all([
    git(th.dir, "status", "--porcelain=v1", "-z", "-uall").then(s => parseStatus(s).length, () => -1),
    branch && th.branch
      ? git(th.repo, "rev-list", "--count", th.branch, "--not", `--exclude=${th.branch}`, "--branches", "--remotes")
          .then(s => +s.trim(), () => -1)
      : 0,
  ]);
  const lines = [
    dirty < 0 ? "⚠ Could not read the worktree's status." : dirty ? `⚠ ${plural(dirty, "uncommitted file")} will be deleted.` : "",
    only < 0 ? `⚠ Could not check whether ${th.branch} is merged.` : only ? `⚠ ${plural(only, "commit")} ${only === 1 ? "exists" : "exist"} only on ${th.branch}.` : "",
  ].filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/** Take a thread out of the list, and out of git as far as `mode` says:
 * "close" keeps the worktree on disk, "worktree" removes the folder and keeps
 * the branch, "all" deletes the branch too. Panes go first either way — a
 * folder with a shell still in it cannot be removed. */
async function removeThread(th: Thread, mode: "close" | "worktree" | "all") {
  const risk = mode === "close" || !th.isWorktree ? "" : await atRisk(th, mode === "all");
  const what =
    mode === "close"
      ? `Close ${th.name}?`
      : mode === "worktree"
        ? `Delete the worktree folder for ${th.name}?\n${th.dir}\n${risk}\nThe branch ${th.branch} is kept.`
        : `Delete the worktree AND the branch ${th.branch}?\n${th.dir}\n${risk}\nCommits only on that branch are lost.`;
  if (th.panes.length || mode !== "close") {
    if (!(await confirm(what, { title: "Loom", kind: mode === "close" ? "info" : "warning", action: mode === "close" ? "Close thread" : "Delete worktree" }))) return;
  }
  const i = threads.indexOf(th);
  threads.splice(i, 1);
  const cleanup = th.dispose();
  renderSide();
  show(threads[Math.min(i, threads.length - 1)] ?? null);
  save();
  await cleanup;
  if (mode === "close" || !th.isWorktree) return;
  try {
    // The killed panes' processes take a beat to die, and Windows refuses to
    // delete a folder that is still some process's cwd — retry a few times.
    for (let n = 0; ; n++) {
      try {
        await git(th.repo, "worktree", "remove", "--force", th.dir);
        break;
      } catch (e) {
        if (n === 10) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (mode === "all" && th.branch) await git(th.repo, "branch", "-D", th.branch);
  } catch (e) {
    toast(String(e));
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
  ? () => git(th.dir, "show", "--stat", "--patch", ...ctx(), source.commit)
  : "file" in source
    ? () => invoke<string>("read_file", { dir: th.dir, path: source.file })
    : diffOf(th, source.sec, source.paths);
const tabsEl = $("#tabs");
const diffView = $("#diff");
let showGen = 0; // bumped per showTab, so a chunked render stops when its tab is gone
let shownTab: DiffTab | null = null; // whose rows #diff-body holds right now

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
  if (!th || !t) return void (showGen++, diffView.classList.add("hidden"));
  $("#diff-name").textContent = t.label;
  const body = $("#diff-body");
  const isFile = "file" in t.source;
  $("#diff-full").classList.toggle("hidden", isFile); // a file is already all of it
  diffView.classList.remove("hidden");
  const gen = ++showGen; // a later showTab, or a closed tab, stops this one's chunks
  // A commit can't change: once its rows are up there is nothing to re-read.
  if ("commit" in t.source && shownTab === t && t.rendered !== undefined) return;
  if (t.rendered === undefined) (body.textContent = "Loading…"), ruler([]); // else keep the old rows up while git answers
  const imagePath = "file" in t.source && imageMime(t.source.file) ? t.source.file : null;
  body.classList.toggle("image-preview", !!imagePath);
  if (imagePath) {
    ruler([]);
    const img = document.createElement("img");
    img.alt = imagePath;
    try {
      const bytes = await invoke<ArrayBuffer>("read_image", { dir: th.dir, path: imagePath });
      if (current !== th || th.tab !== t) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: imageMime(imagePath) }));
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => { URL.revokeObjectURL(url); if (body.contains(img)) body.textContent = "Could not display this image."; };
      img.src = url;
      body.replaceChildren(img);
      shownTab = t;
    } catch (e) {
      if (current === th && th.tab === t) body.textContent = `Could not open image: ${String(e)}`;
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
  body.textContent = "";
  const rows = isFile
    ? text.replace(/\n$/, "").split("\n").map((line, i) => ({ kind: "" as const, old: 0, neu: i + 1, text: line }))
    : diffRows(text);
  // Which way a hunk moves depends on the side the tab is showing: an unstaged
  // hunk goes into the index or out of the file, a staged one comes back out.
  const moves: [string, string, string[]][] =
    t.sec === "unstaged"
      ? [
          ["Stage", "Stage this hunk", ["apply", "--cached"]],
          ["Discard", "Throw this hunk away", ["apply", "--reverse"]],
        ]
      : t.sec === "staged"
        ? [["Unstage", "Take this hunk out of the index", ["apply", "--cached", "--reverse"]]]
        : [];
  // ponytail: 50k rows keeps the DOM sane; a full-file diff of anything bigger is not for reading.
  const CAP = 50_000;
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
        d.append(mini(label, title, () => void applyHunk(th, hunkPatch(rows, i), args)));
    return d;
  };
  // A screenful now, the rest a frame at a time: the panes keep drawing while
  // a long full-file diff lands, instead of freezing for the whole build.
  let i = 0;
  const step = () => {
    if (gen !== showGen) return;
    const frag = document.createDocumentFragment();
    for (const stop = Math.min(end, i + 2000); i < stop; i++) frag.append(line(rows[i], i));
    body.append(frag);
    if (i < end) return void requestAnimationFrame(step);
    rulerFit();
    if (rows.length > CAP) note(body, `… ${rows.length - CAP} more lines`);
    if (!rows.length) note(body, "no differences");
  };
  step();
}

/** Every file of a section as one diff, against the base that section is
 * measured from: the index for staged rows, the file on disk for the rest.
 * Untracked files have no base at all, so they go against nothing.
 * That base is also what makes a hunk button meaningful — a diff of `HEAD`
 * mixes both sides and cannot be applied to either. */
const diffOf = (th: Thread, sec: Sec, paths: string[]) => async () => {
  if (sec !== "untracked") return git(th.dir, "diff", ...ctx(), ...(sec === "staged" ? ["--cached"] : []), "--", ...paths);
  const parts: string[] = [];
  for (const u of paths)
    parts.push(await gitOk(th.dir, [1], "diff", "--no-index", "--", "/dev/null", u).catch((e) => String(e)));
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
/** The right panel is Orca's: git's view of the thread, or every file in it. */
let panel: "changes" | "files" = "changes";
const openDirs = new Set<string>(); // Files tree folders unfolded; shut by default, the repo is big
let panelSig = ""; // what the panel body last drew, so an unchanged poll leaves the DOM alone

function toggleChanges(on = !changesOpen) {
  changesOpen = on;
  changes.classList.toggle("hidden", !on);
  changesBtn.classList.toggle("on", on);
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
  body.textContent = "";
  const walk = (node: Tree, depth: number) => {
    for (const d of node.dirs) {
      const row = document.createElement("div");
      row.className = `dir${openDirs.has(d.path) ? "" : " folded"}`;
      row.style.setProperty("--depth", String(depth));
      row.innerHTML = `<i class="chev"></i><span>${esc(d.name)}</span><b>${d.count}</b>`;
      row.onclick = () => {
        openDirs.has(d.path) ? openDirs.delete(d.path) : openDirs.add(d.path);
        save();
        void refreshChanges();
      };
      body.append(row);
      if (openDirs.has(d.path)) walk(d, depth + 1);
    }
    for (const f of node.files) {
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
      body.append(row);
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
  walk(tree(paths), 0);
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
function actBtns(sec: Sec, files: () => Change[], words = false) {
  const b: HTMLButtonElement[] = [];
  const add = (glyph: string, word: string, title: string, act: Act) =>
    b.push(mini(words ? word : glyph, title, () => void doAct(sec, act, files())));
  if (sec === "staged") add("−", "Unstage", "Unstage", "unstage");
  else add("+", "Stage", "Stage", "stage");
  if (sec === "untracked") add("✕", "Delete", "Delete — git has no copy of it", "discard");
  else add("↺", "Discard", "Discard these changes", "discard");
  return b;
}

/** Run one verb over some files, asking first when it throws work away. */
async function doAct(sec: Sec, act: Act, files: Change[]) {
  const th = current;
  if (!th || !files.length) return;
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
      menuItem(list, `Keep ours${n}`, () => void resolve("--ours", files));
      menuItem(list, `Keep theirs${n}`, () => void resolve("--theirs", files));
    }
    menuItem(list, fight ? `Mark resolved${n}` : sec === "staged" ? `Unstage${n}` : `Stage${n}`, () =>
      void doAct(sec, !fight && sec === "staged" ? "unstage" : "stage", files),
    );
    menuItem(
      list,
      sec === "untracked" ? `Delete${n || " file"}` : `Discard changes${n}`,
      () => void doAct(sec, "discard", files),
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
 * Re-reads HEAD afterwards because half of these move the branch. */
async function gitDo(ask: string, ...args: string[]) {
  const th = current;
  if (!th) return;
  if (ask && !(await confirm(ask, { title: "Loom", kind: "warning" }))) return;
  const b = $<HTMLButtonElement>("#changes-more");
  b.disabled = true;
  try {
    await git(th.dir, ...args);
  } catch (e) {
    toast(String(e));
  }
  b.disabled = false;
  th.branch = (await git(th.dir, "rev-parse", "--abbrev-ref", "HEAD").catch(() => th.branch)).trim() || th.branch;
  th.setStat(th.changed);
  save();
  await refreshChanges();
  void pollStats();
}

/** A conflicted file: both sides touched it and git wants a decision. */
const conflicted = (c: Change) => c.x === "U" || c.y === "U" || (c.x === c.y && (c.x === "A" || c.x === "D"));

/** Take one side of a conflict wholesale and mark it resolved. */
async function resolve(side: "--ours" | "--theirs", files: Change[]) {
  const th = current;
  if (!th) return;
  const paths = files.map((c) => c.path);
  try {
    await git(th.dir, "checkout", side, "--", ...paths);
    await git(th.dir, "add", "--", ...paths);
  } catch (e) {
    toast(String(e));
  }
  await refreshChanges();
  void pollStats();
}

/** Right-click a commit in the log. */
const commitMenuFor = (sha: string): Menu => ({
  placeholder: "",
  rows: (list) => {
    menuItem(list, "Revert this commit", () =>
      void gitDo(`Revert ${sha}?\nA new commit undoing it lands on this branch.`, "-c", "core.editor=true", "revert", "--no-edit", sha),
    );
    menuItem(
      list,
      "Reset to here (keep changes)",
      () => void gitDo(`Move the branch back to ${sha}?\nEverything after it stays in the tree, staged.`, "reset", "--soft", sha),
      true,
    );
    menuItem(
      list,
      "Reset to here (throw changes away)",
      () => void gitDo(`Reset hard to ${sha}?\nEvery change after it is lost.`, "reset", "--hard", sha),
      true,
    );
    menuItem(list, "Copy SHA", () => void navigator.clipboard.writeText(sha));
  },
});

/** Branches, newest first, with the input adding one. `switch` refuses while
 * the tree is dirty or the branch is checked out in another worktree — git's
 * complaint goes to the toast, which is the answer either way. */
async function showBranches() {
  const th = current;
  if (!th) return;
  const out = await git(th.dir, "branch", "--format=%(refname:short)", "--sort=-committerdate").catch(() => "");
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 40);
  showMenu($("#changes-more"), {
    placeholder: "new branch…",
    add: (v) => void gitDo("", "switch", "-c", v),
    rows: (list) => {
      if (!names.length) return note(list, "no branches yet");
      for (const n of names)
        menuItem(list, n === th.branch ? `${n} ✓` : n, () => void gitDo("", "switch", n));
    },
  });
}

/** The stash, applied rather than popped and picked by name: the stack is
 * shared with every other worktree of this repo, so "the top one" is not
 * necessarily yours. */
async function showStashes() {
  const th = current;
  if (!th) return;
  const out = await git(th.dir, "stash", "list", "--format=%gd%x09%gs").catch(() => "");
  const rows = out.trim() ? out.trim().split("\n").map((l) => l.split("\t")) : [];
  showMenu($("#changes-more"), {
    placeholder: "",
    rows: (list) => {
      if (!rows.length) return note(list, "no stashes");
      for (const [ref, msg] of rows) {
        const d = document.createElement("div");
        d.className = "menu-item";
        const s = document.createElement("span");
        s.textContent = `${ref}  ${msg ?? ""}`;
        s.title = msg ?? ref;
        d.append(
          s,
          mini("✕", "Drop this stash", () => (hideMenu(), void gitDo(`Drop ${ref}?`, "stash", "drop", ref))),
        );
        d.onclick = () => (hideMenu(), void gitDo("", "stash", "apply", ref));
        list.append(d);
      }
    },
  });
}

/** Amend with whatever is staged; the message box replaces the message when
 * it has something in it. */
async function amend() {
  const th = current;
  const box = $<HTMLTextAreaElement>("#commit-msg");
  const m = box.value.trim();
  await gitDo(
    `Amend the last commit?\n${m ? "Its message becomes what is in the box." : "Its message is kept."}`,
    "commit",
    "--amend",
    ...(m ? ["-m", m] : ["--no-edit"]),
  );
  if (th) th.commitDraft = "";
  if (current === th) box.value = "";
  save();
}

/** Everything git that isn't about one file: the ⋯ beside Create PR. */
const repoMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    const th = current;
    if (!th) return;
    menuItem(list, "Fetch", () => void gitDo("", "fetch", "--all", "--prune"));
    menuItem(list, "Pull (rebase)", () => void gitDo("", "pull", "--rebase", "--autostash"));
    menuItem(list, "Push", () => void gitDo("", "push", "-u", "origin", "HEAD"));
    menuItem(
      list,
      "Force push (with lease)",
      () => void gitDo(`Force-push ${th.branch}?\nIt overwrites the remote branch unless someone else has pushed since you last fetched.`, "push", "--force-with-lease"),
      true,
    );
    menuItem(list, "Switch branch…", () => void showBranches());
    menuItem(list, "Amend last commit", () => void amend());
    menuItem(list, "Undo last commit (keep changes)", () =>
      void gitDo("Undo the last commit?\nIts changes come back as staged work.", "reset", "--soft", "HEAD~1"),
    );
    menuItem(list, "Stash all changes", () =>
      void gitDo("", "stash", "push", "-u", "-m", `loom ${th.name}`),
    );
    menuItem(list, "Restore a stash…", () => void showStashes());
  },
};

/** Continue / skip / abort, when git has stopped half way through something.
 * `core.editor=true` because nothing here can pop an editor and wait. */
function midwayBar(state: string) {
  const bar = document.createElement("div");
  bar.className = "sel-bar warn";
  const label = document.createElement("span");
  label.textContent = `${state} in progress`;
  const btns =
    state === "merge"
      ? [
          mini("Commit", "Finish the merge", () => void gitDo("", "-c", "core.editor=true", "commit", "--no-edit")),
          mini("Abort", "Undo the merge", () => void gitDo("Abort the merge?", "merge", "--abort")),
        ]
      : state === "revert"
        ? [
            mini("Continue", "Finish the revert", () => void gitDo("", "-c", "core.editor=true", "revert", "--continue")),
            mini("Abort", "Undo the revert", () => void gitDo("Abort the revert?", "revert", "--abort")),
          ]
        : [
            mini("Continue", "Go on with the rebase", () => void gitDo("", "-c", "core.editor=true", "rebase", "--continue")),
            mini("Skip", "Drop the commit being applied", () => void gitDo("Skip this commit?", "rebase", "--skip")),
            mini("Abort", "Put the branch back", () => void gitDo("Abort the rebase?", "rebase", "--abort")),
          ];
  bar.append(label, ...btns);
  return bar;
}

async function refreshChanges() {
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
    [status, unstaged, staged, upstream, log, span, midway, head] = await Promise.all([
      git(th.dir, "status", "--porcelain=v1", "-z", "-uall").then(parseStatus),
      git(th.dir, "diff", "--numstat").then(parseNumstat),
      git(th.dir, "diff", "--numstat", "--cached").then(parseNumstat),
      git(th.dir, "rev-parse", "--abbrev-ref", "@{upstream}").then((s) => s.trim(), () => ""),
      git(th.dir, "log", "--oneline", "-10").catch(() => ""),
      git(th.dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD").then((s) => s.trim(), () => ""),
      // What git stopped in the middle of. MERGE_HEAD and REVERT_HEAD are
      // cleared by the commit that ends them; REBASE_HEAD is not, so a rebase
      // has to be asked about directly.
      Promise.all([
        git(th.dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(() => "merge", () => ""),
        git(th.dir, "rev-parse", "-q", "--verify", "REVERT_HEAD").then(() => "revert", () => ""),
        git(th.dir, "rebase", "--show-current-patch").then(() => "rebase", () => ""),
      ]).then((r) => r.find(Boolean) ?? ""),
      git(th.dir, "diff", "--numstat", "HEAD").then(parseNumstat, () => new Map<string, Stat>()),
    ]);
  } catch (e) {
    panelSig = "";
    body.textContent = "";
    note(body, String(e));
    return;
  }
  if (th !== current) return; // switched threads while git was answering
  th.setStat({ ...sumStat(head.values()), files: status.length }); // pollStats skips this thread while the panel is up
  const total = sumStat([...unstaged.values(), ...staged.values()]);
  $("#changes-branch").textContent = th.branch || "(no branch)";
  $("#changes-stat").innerHTML = statHtml(total);
  const [behind, ahead] = span.split("\t");
  const gap = +behind || +ahead ? `  ${+behind ? `↓${behind}` : ""}${+ahead ? ` ↑${ahead}` : ""}`.trimEnd() : "";
  $("#changes-base").textContent = upstream ? `→ ${upstream}${gap}` : "→ not pushed yet";

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
  body.textContent = "";
  if (midway) body.append(midwayBar(midway));
  if (selSec) {
    const sec = selSec;
    const bar = document.createElement("div");
    bar.className = "sel-bar";
    const n = document.createElement("span");
    n.textContent = `${sel.size} selected`;
    bar.append(
      n,
      ...actBtns(sec, () => secRows[sec].filter((c) => sel.has(c.path)), true),
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
    hActs.append(...actBtns(sec, () => rows)); // on the header the verbs mean "all of it"
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
        acts.append(...actBtns(sec, under));
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
        row.title = c.path;
        row.style.setProperty("--depth", String(depth));
        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = f.name;
        const acts = document.createElement("span");
        acts.className = "acts";
        acts.append(...actBtns(sec, () => [c]));
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
    if (!foldedSections.has("Commits"))
      for (const line of log.trim().split("\n")) {
        const d = document.createElement("div");
        d.className = "commit";
        const [sha, ...msg] = line.split(" ");
        d.innerHTML = `<b>${esc(sha)}</b> ${esc(msg.join(" "))}`;
        d.title = "Show this commit — right-click to revert or reset";
        d.onclick = () => openTab(th, `${sha} (commit)`, { commit: sha });
        d.oncontextmenu = (e) => (e.preventDefault(), showMenu(d, commitMenuFor(sha)));
        body.append(d);
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

/** Commit everything the thread has changed, and push when asked. Orca's box
 * does the same; the staged/unstaged split above is for reading. */
async function commitAll(push = false, all = true) {
  const th = current;
  const msg = $<HTMLTextAreaElement>("#commit-msg");
  if (!th || !msg.value.trim()) return msg.focus();
  const btn = $<HTMLButtonElement>("#commit-btn");
  btn.disabled = true;
  let err = "";
  try {
    if (all) await git(th.dir, "add", "-A");
    await git(th.dir, "commit", "-m", msg.value.trim());
    th.commitDraft = "";
    if (current === th) msg.value = "";
    save();
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
  const body = $("#changes-body");
  try {
    const url = (await git(th.dir, "remote", "get-url", "origin")).trim();
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!m) throw new Error(`origin is not on GitHub: ${url || "(no origin)"}`);
    const head = (await git(th.dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").catch(() => "")).trim();
    const base = head.replace(/^origin\//, "") || "main";
    await git(th.dir, "push", "-u", "origin", "HEAD");
    await openUrl(`https://github.com/${m[1]}/${m[2]}/compare/${base}...${encodeURIComponent(th.branch)}?expand=1`);
  } catch (e) {
    note(body, String(e));
  }
  void refreshChanges();
}

/** Sidebar and header stats: lines changed against HEAD plus the untracked
 * count. Two git calls per thread; a folder that is not a repo answers nothing
 * and stays blank. The current thread every 10 s, every thread once a minute
 * (`all`): a hidden thread's `+N −M` needs no more, and each call is a git.exe
 * launch that stats the whole worktree. The open Changes panel reads the
 * current thread's numbers itself, so that one is skipped while it is up. */
async function pollStats(all = false) {
  const targets = all ? threads : current ? [current] : [];
  await Promise.all(
    targets.filter((th) => !(changesOpen && panel === "changes" && th === current)).map(async (th) => {
      const [numstat, status] = await Promise.all([
        git(th.dir, "diff", "--numstat", "HEAD").then(parseNumstat, () => null),
        git(th.dir, "status", "--porcelain=v1", "-z", "-uall").then(parseStatus, () => null),
      ]);
      if (!numstat || !status) return;
      th.setStat({ ...sumStat(numstat.values()), files: status.length });
    }),
  );
  if (changesOpen) void refreshChanges();
}

/** Where a new worktree goes: ~\loom\<repo>\<thread>, like Orca's own
 * ~\orca\workspaces. Never inside the repo, where git would see it as untracked. */
const worktreeDir = async (repo: string, slug: string) => join(await homeDir(), "loom", basename(repo), slug);

/** Does `ref` name something in `repo`? Fetches it from origin first if not,
 * so a branch that only exists on the remote still counts. */
async function refExists(repo: string, ref: string) {
  const ok = () => git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}").then(() => true, () => false);
  if (await ok()) return true;
  await git(repo, "fetch", "origin", ref).catch(() => {});
  return ok();
}

/** Cut a thread from `repo`, or — no name given — open the checkout itself as
 * one. A new name becomes branch `loom/<slug>` off `base` (HEAD when blank),
 * suffixed -2, -3… when that name is already a branch or a folder. A `base`
 * that names nothing, locally or on origin, is taken as a NEW branch name: the
 * thread is created on it, off HEAD. */
async function createThread(repo: string, name: string, cmd: string, base: string, n: number) {
  let dir = repo;
  let branch = "";
  // A base with no name still means "cut me a worktree" — the branch names it.
  name ||= base;
  if (name) {
    // A missing base becomes the branch itself — unless it is spelled like a
    // remote ref (origin/x) that just isn't there, which is a typo, not a wish.
    let fresh = "";
    if (base && !(await refExists(repo, base))) {
      const remotes = (await git(repo, "remote").catch(() => "")).split(/\r?\n/).filter(Boolean);
      if (remotes.includes(base.split("/")[0])) throw new Error(`${base} is not a branch on that remote`);
      fresh = base;
      base = "";
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("name needs a letter or digit in it");
    // Folders deleted by hand leave git believing the worktree is still
    // there, which blocks the same path from ever being used again.
    await git(repo, "worktree", "prune").catch(() => {});
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
      const cand = i === 1 ? slug : `${slug}-${i}`;
      branch = fresh || `loom/${cand}`;
      dir = await worktreeDir(repo, cand);
      if (taken.has(branch) || dirs.has(dir.toLowerCase())) continue;
      // git itself is the "does the folder exist" check: it refuses a
      // non-empty one, and that is the one error worth trying the next name on.
      try {
        await git(repo, "worktree", "add", "-b", branch, dir, ...(base ? [base] : []));
        break;
      } catch (e) {
        if (!/already exists/.test(String(e))) throw e;
      }
    }
  } else {
    const have = threads.find((t) => t.dir === dir);
    if (have) return show(have);
    branch = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "")).trim();
  }
  await openThread({ repo, dir, branch, name: name || basename(repo) }, Array(n).fill({ cmd }));
}

/** "+ Thread": a native <dialog> — repo, name, agent, base branch, pane count.
 * The repo list is what threads were cut from so far; "browse…" adds one. */
const dlg = $<HTMLDialogElement>("#new");
const dlgRepo = $<HTMLSelectElement>("#new-repo");
const dlgErr = $("#new-err");

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
  const agent = $<HTMLSelectElement>("#new-agent");
  agent.textContent = "";
  for (const s of startups) agent.append(new Option(s.label, s.cmd));
  $<HTMLInputElement>("#new-name").value = "";
  $<HTMLInputElement>("#new-base").value = "";
  $<HTMLInputElement>("#new-count").value = String(paneCount);
  dlgErr.textContent = "";
  $<HTMLDetailsElement>("#new-advanced").open = false;
  updateThreadMode();
  dlg.showModal();
  (repos.length && threadMode() === "worktree" ? $("#new-name") : dlgRepo).focus();
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
  $("#new-description").textContent = worktree
    ? "Create an isolated folder and branch for this thread. Your checkout stays where it is."
    : "Work in the existing folder. No new branch or copy.";
  dlgErr.textContent = "";
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="thread-mode"]')) radio.onchange = updateThreadMode;

async function browseRepo() {
  const previous = dlgRepo.value;
  try {
    const dir = await pickFolder({ directory: true, multiple: false });
    if (typeof dir !== "string") return void (dlgRepo.value = previous);
    // A folder outside Git can still be opened as a checkout thread.
    const root = (await git(dir, "rev-parse", "--show-toplevel").catch(() => dir)).trim().replace(/\//g, "\\");
    if (!repos.includes(root)) repos.push(root);
    if (![...dlgRepo.options].some((o) => o.value === root))
      dlgRepo.insertBefore(new Option(basename(root), root), dlgRepo.lastElementChild);
    dlgRepo.value = root;
    (threadMode() === "worktree" ? $("#new-name") : $("#new-agent")).focus();
  } catch (err) {
    dlgErr.textContent = String(err);
  }
}
dlgRepo.onchange = () => { if (!dlgRepo.value) void browseRepo(); };
$("#new-browse").onclick = () => void browseRepo();

$("#new-cancel").onclick = () => dlg.close();

$<HTMLFormElement>("#new-form").onsubmit = async (e) => {
  e.preventDefault();
  const repo = dlgRepo.value;
  if (!repo) return void (dlgErr.textContent = "pick a repo");
  const worktree = threadMode() === "worktree";
  const name = $<HTMLInputElement>("#new-name").value.trim();
  if (worktree && !name) return void (dlgErr.textContent = "Give this worktree a thread name.");
  const n = Math.max(1, Math.min(parseInt($<HTMLInputElement>("#new-count").value, 10) || 1, MAX_PANES));
  paneCount = n; // openThread save()s on the way out, so this rides along
  const go = $<HTMLButtonElement>("#new-go");
  go.disabled = true;
  const controls = [...$("#new-form").querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input:not(:disabled), select:not(:disabled), #new-browse")];
  controls.forEach((el) => (el.disabled = true));
  go.textContent = worktree ? "Creating…" : "Opening…";
  dlgErr.textContent = "creating…"; // a fetch can take a moment
  try {
    await createThread(
      repo,
      worktree ? name : "",
      $<HTMLSelectElement>("#new-agent").value,
      worktree ? $<HTMLInputElement>("#new-base").value.trim() : "",
      n,
    );
    dlg.close();
  } catch (err) {
    dlgErr.textContent = String(err);
  } finally {
    controls.forEach((el) => (el.disabled = false));
    go.disabled = false;
    go.textContent = worktree ? "Create worktree" : "Open checkout";
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
}

/** "+ pane" and "+ Folder": pick a startup command, or extend the list. */
const startupMenu = (pick: (cmd: string) => void): Menu => ({
  placeholder: "add a command…",
  add: (v) => startups.push({ label: v, cmd: v }),
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
type Sent = "ok" | "sent" | "lost";

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
  p.term.paste(cmd);
  await p.settle(150, 1000); // let the input take it before the Enter
  await invoke("pty_write", { id: p.id, data: "\r" });
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
  if (!menu.classList.contains("hidden")) cfgPaint?.(got === "lost");
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
    pane: p.id,
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
    heading.append(icon(provider), `${info.name}${plan?.tier ? ` · ${TIERS[plan.tier] ?? plan.tier}` : ""}`);
    list.append(heading);
    const site = document.createElement("a");
    site.className = "plan-site";
    site.textContent = `Open ${info.name} usage page ↗`;
    site.href = info.url;
    site.onclick = (e) => { e.preventDefault(); void openUrl(info.url).catch(e => toast(String(e))); };
    list.append(site);
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
const planMenus = { claude: makePlanMenu("claude"), codex: makePlanMenu("codex") };

/** The palette. Built in, so no add input — every row is one of THEMES. */
const themeMenu: Menu = {
  placeholder: "",
  rows: (list) => {
    for (const t of THEMES) {
      const row = document.createElement("div");
      row.className = `menu-item theme-card${t === theme ? " on" : ""}`;
      row.setAttribute("aria-label", `${t.label}, ${t.scheme ?? "dark"} theme`);
      row.setAttribute("aria-pressed", String(t === theme));
      const lbl = document.createElement("span");
      lbl.className = "theme-caption";
      lbl.textContent = t.label;
      const scheme = document.createElement("small");
      scheme.textContent = t.scheme ?? "dark";
      lbl.append(scheme);
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
    b.replaceChildren(icon(provider), document.createTextNode(text));
  }
  b.setAttribute("aria-label", `${info.name} usage${s ? `, ${Math.round(s.percent)}% used` : " unavailable"}`);
  if (!s) { b.title = `${info.name}: ${planErrors[provider] || "Fetching usage…"}`; return; }
  b.title =
    `${info.name} · ${TIERS[plan!.tier] ?? plan!.tier}${plan!.tier ? " — " : ""}` +
    `${KIND_LABELS[s.label] ?? s.label} ${Math.round(s.percent)}% used\n` +
    `${fmtReset(s.resetsAt)}\nClick for the weekly limits too`;
}

/** Poll: the endpoint rate-limits hard and these numbers move slowly, so five
 * minutes is as often as it's worth asking. A failure keeps the last good
 * numbers and shows why underneath them. */
async function pollPlan(provider: PlanProvider) {
  if (!planUsage) return;
  const plan = plans[provider];
  try {
    const got = await invoke<Plan>(PLAN_PROVIDERS[provider].command);
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
    planErrors[provider] = "";
  } catch (e) {
    planErrors[provider] = String(e);
  }
  paintPlan(provider);
  if (!menu.classList.contains("hidden") && openMenu === planMenus[provider]) renderMenu();
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
    ? "Claude and Codex plan usage in the top bar — click to hide it and stop asking the accounts"
    : "Plan usage is off: no chips, no calls to the usage endpoints — click to show it";
  b.setAttribute("aria-pressed", String(planUsage));
}

function paintSilent() {
  const b = $("#silent");
  b.textContent = silent ? "Silent" : "Sound and taskbar";
  b.title = silent ? "No chime, no taskbar flash — click to turn them back on" : "Chime and flash the taskbar when an agent wants you — click to silence";
  b.setAttribute("aria-pressed", String(silent));
}

/** A dictation setting beside Speak: its current value, then a caret. Always
 * in sight, so a glance says what the next dictation will type. */
function paintSetting(b: HTMLElement, value: string, title: string) {
  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = value;
  b.replaceChildren(label, glyph("chevron"));
  b.title = title;
}

function paintLang() {
  paintSetting($("#lang"), lang.label, lang.code
    ? `Dictation is transcribed as ${lang.label} — click to change`
    : "Dictation language is detected per clip — click to change");
}

function paintPrefix() {
  paintSetting($("#prefix"), `${prefix.text.trim() || "no prefix"}${prefix.enter ? " ⏎" : ""}`, prefix.enter
    ? "Dictation is sent the moment it lands — click to change"
    : "Dictation is inserted and waits for your Enter — click to change");
}

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
  menu.style.top = `${Math.max(gap, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - gap))}px`;
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
async function main() {
  // panes: PaneState[]; a bare string is the pre-session format, a number the
  // pre-list one before that. `spaces` is the pre-thread format: a folder and
  // its panes, which is what a thread on the checkout itself still is.
  type Saved = { panes: number | (string | PaneState)[]; layout?: LayoutMode; startup?: string };
  let saved: {
    threads?: (Saved & ThreadState)[];
    spaces?: (Saved & { dir: string })[];
    repos?: string[];
    reposFolded?: string[];
    startups?: Startup[];
    startup?: string;
    prefixes?: Prefix[];
    prefix?: number;
    langs?: Lang[];
    lang?: number;
    theme?: string;
    fontSize?: number;
    paneCount?: number;
    silent?: boolean;
    planUsage?: boolean;
    ui?: { thread?: number; dashboard?: boolean; dashboardCompact?: boolean; sideOpen?: boolean; changesOpen?: boolean; sideQuery?: string;
      sideW?: { side?: number; changes?: number }; sideScroll?: number; foldedSections?: string[]; foldedDirs?: string[];
      panel?: "changes" | "files"; openDirs?: string[]; diffFull?: boolean };
  } = {};
  try {
    // strip a BOM: the file is hand-editable and Notepad/PowerShell add one
    const raw = (await invoke<string>("load_state")).replace(/^﻿/, "").trim();
    saved = JSON.parse(raw || "{}");
  } catch {}
  if (saved.startups?.length) startups = saved.startups;
  if (saved.prefixes?.length) prefixes = saved.prefixes;
  prefix = prefixes[saved.prefix ?? 0] ?? prefixes[0];
  if (saved.langs?.length) langs = saved.langs;
  lang = langs[saved.lang ?? 0] ?? langs[0];
  // Before the first Pane too: its Terminal is built from the live palette.
  applyTheme(THEMES.find((t) => t.label === saved.theme) ?? THEMES[0]);
  // Before any Pane exists — the Terminal is built with it. Hand-editable file.
  fontSize = Math.min(Math.max(saved.fontSize ?? fontSize, 8), 24);
  paneCount = Math.min(Math.max(saved.paneCount ?? paneCount, 1), MAX_PANES);
  silent = saved.silent === true;
  planUsage = saved.planUsage !== false;
  repos = saved.repos ?? [];
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
  let closing = false;
  await getCurrentWindow().onCloseRequested(async e => {
    e.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await pollSessions();
      await flushSave();
      await saveQueue; // flushSave swallows the error into a toast; this rethrows it, so a failed save cancels the close
      await invoke("pty_shutdown");
      await getCurrentWindow().destroy();
    } catch (e) {
      toast(`Could not close safely: ${String(e)}`);
    } finally { closing = false; }
  });

  for (const id of ["#new-thread", "#open-first"]) $(id).onclick = () => newThread();
  $("#preferences-btn").onclick = () => togglePreferences();
  $("#preferences-close").onclick = () => (togglePreferences(false), $("#preferences-btn").focus());
  $("#shortcuts").onclick = () => {
    togglePreferences(false);
    $<HTMLDialogElement>("#keys").showModal();
  };
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
  $("#changes-refresh").onclick = () => void (pollStats(), refreshChanges());
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
  const prefixBtn = $("#prefix");
  const langBtn = $("#lang");
  const themeBtn = $("#theme");
  // keep pane focus
  for (const b of [dictate, prefixBtn, langBtn, themeBtn, $("#silent"), $("#plan-usage")]) b.onmousedown = (e) => e.preventDefault();
  dictate.onclick = () => mic(recording ? micStop : micStart);
  prefixBtn.onclick = () => showMenu(prefixBtn, prefixMenu);
  langBtn.onclick = () => showMenu(langBtn, langMenu);
  themeBtn.onclick = () => showMenu(themeBtn, themeMenu);
  $("#silent").onclick = () => ((silent = !silent), paintSilent(), save());
  $("#plan-usage").onclick = () => {
    planUsage = !planUsage;
    if (openMenu === planMenus.claude || openMenu === planMenus.codex) hideMenu();
    for (const provider of ["claude", "codex"] as const) {
      paintPlan(provider);
      void pollPlan(provider); // back on: fresh numbers now, not in five minutes
    }
    paintPlanUsage();
    save();
  };
  micState("");
  paintPrefix();
  paintLang();
  paintSilent();
  paintPlanUsage();
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
  // as letting go — a keyup that never arrives would leave the mic open.
  window.addEventListener("keyup", (e) => e.key === "F4" && mic(micStop), true);
  window.addEventListener("blur", () => {
    if (recording) mic(micStop);
  });

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

  // Claude's Stop/Notification hooks drop $TEMP\loom-wait\$env:LOOM_PANE; drain
  // it into pane.wake(). ponytail: a 250ms poll of one temp dir, no file watcher.
  setInterval(async () => {
    const wakes = await invoke<[string, string][]>("take_wakes").catch(() => []);
    if (!wakes.length) return;
    const effortById = new Map(wakes);
    for (const p of threads.flatMap((t) => t.panes)) {
      const e = effortById.get(p.id);
      if (e !== undefined) p.wake(e);
    }
  }, 250);

  // Codex's notify script and the opencode plugin drop the session id a pane is
  // really on (agent.ts). Only the next launch needs it, so it rides the 4 s
  // tick — on the 250 ms one it cost a file open per pane, under the pty lock.
  let sessionPoll: Promise<void> | undefined;
  const pollSessions = () => sessionPoll ??= (async () => {
    const panes = threads.flatMap((t) => t.panes).filter((p) => p.agent === "codex" || p.agent === "opencode");
    if (!panes.length) return;
    const got = await invoke<[string, string][]>("take_sessions", { ids: panes.map((p) => p.id) }).catch(() => []);
    let changed = false;
    for (const [id, sid] of got) {
      const p = panes.find((x) => x.id === id);
      if (p && validSessionId(sid) && sid !== p.sessionId) (p.sessionId = sid), (changed = true);
    }
    if (changed) save();
  })().finally(() => { sessionPoll = undefined; });

  // Context and token totals, read from Claude Code's own transcripts.
  // ponytail: a 4s poll beside the wake one — the Rust side reads only what was
  // appended since last time, so an idle pane costs a metadata() call.
  const pollUsage = async () => {
    const panes = threads.flatMap((t) => t.panes).filter((p) => p.isClaude);
    if (!panes.length) return;
    const got = await invoke<Record<string, Usage>>("session_usage", {
      panes: panes.map((p) => [p.id, p.th.dir, p.sid]),
    }).catch(() => ({}) as Record<string, Usage>);
    let moved = false;
    for (const p of panes) {
      const u = got[p.id] ?? null;
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
  };
  // Nothing reads git or transcripts while Loom is minimised or covered —
  // WebView2 reports that as document.hidden — and it all catches up the
  // moment the window is back. Session marks are the exception: a pane whose
  // agent finished while Loom was hidden must not lose its id to a close.
  const tick = (fn: () => unknown) => () => void (document.hidden || fn());
  let statTick = 0;
  setInterval(tick(pollUsage), 4000);
  setInterval(pollSessions, 4000);
  setInterval(tick(() => pollStats(++statTick % 6 === 0)), 10_000);
  setInterval(tick(() => threads.forEach((t) => t.paintAge())), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void pollUsage();
    void pollStats(true);
  });

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
  // Once a launch is plenty: the roster changes on Anthropic's schedule, not
  // yours, and the panel falls back to the CLI's aliases if this never answers.
  invoke<ModelOpt[]>("model_options")
    .then((m) => (models = m))
    .catch(() => {});

  show(null);
  // Parallel too: openThread pushes its thread before awaiting, so sidebar
  // order stays saved order. Each one show()s itself as it starts, hence the
  // explicit show() after restores the selection once every pane exists.
  const restore =
    saved.threads ?? (saved.spaces ?? []).map((w) => ({ ...w, repo: w.dir, branch: "", name: basename(w.dir) }));
  await Promise.all(
    restore.map((w) => {
      const panes: PaneState[] = Array.isArray(w.panes)
        ? w.panes.map((p) => (typeof p === "string" ? { cmd: p } : p))
        : Array(Math.max(w.panes, 1)).fill({
            cmd: w.startup ?? saved.startup ?? startups[0]?.cmd ?? "",
          });
      return openThread(w, panes, w.layout);
    }),
  );
  renderSide();
  show(threads[saved.ui?.thread ?? 0] ?? threads[0] ?? null);
  if (saved.ui?.dashboard) toggleDashboard(true);
  toggleChanges(saved.ui?.changesOpen ?? false);
  toggleSide(saved.ui?.sideOpen ?? !narrowWindow.matches);
  $("#threads").scrollTop = saved.ui?.sideScroll ?? 0;
  restoring = false;
  await flushSave();
  pollUsage(); // restored panes shouldn't sit blank for the first interval
  pollStats(true);
}

main();
