/* Mock of the real Loom chrome. Every colour, radius and metric is lifted
   straight from src/styles.css so the video shows the actual product, not a
   prettier lie. Panes are rendered at the app's own 13px scale and the whole
   window is scaled up once (WIN_SCALE) for 1080p legibility. */
import React from 'react';
import {useCurrentFrame} from 'remotion';

export const C = {
  bg: '#0a0f1b',
  panel: '#0e1626',
  raise: '#141e33',
  line: '#1c2a45',
  lineStrong: '#2a3c5c',
  text: '#dce4f0',
  muted: '#94a6c8',
  faint: '#6e82a6',
  accent: '#d97757',
  accentDim: 'rgba(217, 119, 87, 0.14)',
  ok: '#6fbf73',
  err: '#f85149',
  warn: '#e3b341',
};

export const MONO = '"Cascadia Mono", Consolas, "Courier New", monospace';
export const SANS = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

export const WIN_W = 1020;
export const WIN_H = 560;
export const WIN_SCALE = 1.6;

/** Chars revealed per frame — 0.35 is a brisk but readable type-on. */
export const typed = (s: string, frame: number, start: number, cps = 0.35) =>
  s.slice(0, Math.max(0, Math.round((frame - start) * cps)));

export const Mark: React.FC<{size: number}> = ({size}) => (
  <svg width={size} height={size} viewBox="0 0 32 32" style={{flex: 'none'}}>
    <rect x="1" y="1" width="30" height="30" rx="8" fill={C.panel} stroke={C.lineStrong} strokeWidth="1.5" />
    <path
      d="M8.5 11 L14.5 16 L8.5 21"
      fill="none"
      stroke={C.accent}
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="18.5" y="11.5" width="4.5" height="9" rx="1" fill={C.accent} />
  </svg>
);

/** The wordmark's block cursor: blink 1.1s steps(1), same as the app. */
export const Cursor: React.FC<{w?: number; h?: number}> = ({w = 7, h = 13}) => {
  const frame = useCurrentFrame();
  return (
    <span
      style={{
        display: 'inline-block',
        width: w,
        height: h,
        marginLeft: w * 0.45,
        verticalAlign: -h * 0.15,
        background: C.accent,
        opacity: frame % 33 < 17 ? 1 : 0,
      }}
    />
  );
};

const Btn: React.FC<{children: React.ReactNode; primary?: boolean}> = ({children, primary}) => (
  <span
    style={{
      fontFamily: SANS,
      fontSize: 12,
      color: primary ? C.accent : C.muted,
      border: `1px solid ${primary ? C.line : 'transparent'}`,
      borderRadius: 6,
      padding: '3px 10px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

export type Tab = {name: string; panes: number};

const TabChip: React.FC<{tab: Tab; on: boolean; scale?: number}> = ({tab, on, scale = 1}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flex: 'none',
      padding: '3px 8px 3px 10px',
      border: `1px solid ${on ? C.line : 'transparent'}`,
      borderRadius: 6,
      background: on ? C.raise : 'transparent',
      fontFamily: MONO,
      fontSize: 12,
      color: on ? C.text : C.muted,
      transform: `scale(${scale})`,
      opacity: scale,
    }}
  >
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: on ? C.accent : C.lineStrong,
        flex: 'none',
      }}
    />
    <span>{tab.name}</span>
    <span style={{color: C.faint, fontSize: 10}}>{tab.panes}</span>
  </div>
);

export const AppWindow: React.FC<{
  tabs?: Tab[];
  active?: number;
  path?: string;
  count?: number;
  tabScale?: (i: number) => number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({tabs = [], active = 0, path = '', count = 4, tabScale, children, style}) => (
  <div
    style={{
      width: WIN_W,
      height: WIN_H,
      display: 'flex',
      flexDirection: 'column',
      background: C.bg,
      border: `1px solid ${C.lineStrong}`,
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: '0 40px 90px rgba(0, 0, 0, 0.55)',
      fontFamily: SANS,
      color: C.text,
      ...style,
    }}
  >
    <div
      style={{
        height: 44,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        background: C.panel,
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <Mark size={18} />
      <span style={{fontFamily: MONO, fontSize: 13, fontWeight: 600, letterSpacing: 0.4}}>
        loom
        <Cursor />
      </span>
      <div style={{display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, marginLeft: 6}}>
        {tabs.map((t, i) => (
          <TabChip key={t.name} tab={t} on={i === active} scale={tabScale ? tabScale(i) : 1} />
        ))}
      </div>
      <Btn primary>+ Folder</Btn>
      <span
        style={{
          width: 46,
          flex: 'none',
          textAlign: 'center',
          fontFamily: MONO,
          fontSize: 12,
          color: C.muted,
          background: C.raise,
          border: `1px solid ${C.line}`,
          borderRadius: 6,
          padding: '3px 0',
        }}
      >
        {count}
      </span>
    </div>

    <div
      style={{
        height: 34,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        background: C.panel,
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <span style={{fontFamily: MONO, fontSize: 11, color: C.faint}}>{path}</span>
      <span style={{flex: 1}} />
      <Btn>▥ cols</Btn>
      <Btn>VS Code</Btn>
      <Btn primary>+</Btn>
    </div>

    <div style={{position: 'relative', flex: 1, minHeight: 0}}>{children}</div>
  </div>
);

export type PaneState = 'idle' | 'active' | 'waiting';

export const Pane: React.FC<{
  title: string;
  state?: PaneState;
  busy?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({title, state = 'idle', busy, children, style}) => {
  const frame = useCurrentFrame();
  const border = state === 'waiting' ? C.warn : state === 'active' ? C.accent : C.line;
  const glow =
    state === 'waiting'
      ? '0 0 0 1px rgba(227, 179, 65, 0.22), 0 2px 14px rgba(0, 0, 0, 0.35)'
      : state === 'active'
        ? `0 0 0 1px ${C.accentDim}, 0 2px 14px rgba(0, 0, 0, 0.35)`
        : 'none';
  // .pane.busy pulses its status dot, 1.4s ease-in-out.
  const dotPulse = busy ? 0.35 + 0.65 * Math.abs(Math.cos((frame / 42) * Math.PI)) : 1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: C.panel,
        border: `1px solid ${border}`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: glow,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 'none',
          padding: '3px 6px 3px 10px',
          borderBottom: `1px solid ${C.line}`,
          background: 'rgba(255, 255, 255, 0.015)',
          color: state === 'waiting' ? C.warn : state === 'active' ? C.muted : C.faint,
          fontFamily: MONO,
          fontSize: 11,
        }}
      >
        <span
          style={{
            color: busy ? C.accent : C.lineStrong,
            fontSize: 9,
            marginRight: 1,
            opacity: dotPulse,
          }}
        >
          ●
        </span>
        <span>{title}</span>
        <span style={{flex: 1}} />
        <span style={{color: C.muted, opacity: 0.75, fontSize: 12}}>⛶</span>
        <span style={{color: C.muted, opacity: 0.75, fontSize: 12}}>✕</span>
      </div>
      <div style={{flex: 1, minHeight: 0, padding: '4px 0 4px 12px', background: C.bg, overflow: 'hidden'}}>
        {children}
      </div>
    </div>
  );
};

/** A shell command block: OSC 133 accent bar, exit code, hover actions. */
export type Blk = {cmd: string; out?: string[]; status?: 'ok' | 'err'; exit?: number};

const MiniBtn: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span
    style={{
      padding: '0 6px',
      fontSize: 10,
      lineHeight: '15px',
      fontFamily: MONO,
      color: C.muted,
      background: C.raise,
      border: `1px solid ${C.line}`,
      borderRadius: 4,
    }}
  >
    {children}
  </span>
);

export const Block: React.FC<{blk: Blk; size?: number; hover?: number}> = ({blk, size = 12, hover = 0}) => (
  <div
    style={{
      marginLeft: -6,
      marginBottom: 6,
      borderLeft: `2px solid ${blk.status === 'ok' ? C.ok : blk.status === 'err' ? C.err : C.line}`,
      borderTop: '1px solid #131e33',
      background: 'rgba(120, 145, 190, 0.06)',
      padding: '3px 0 5px 10px',
      fontFamily: MONO,
      fontSize: size,
      lineHeight: 1.65,
    }}
  >
    <div style={{display: 'flex', alignItems: 'center'}}>
      <span style={{color: C.accent, marginRight: 8}}>❯</span>
      <span style={{color: C.text}}>{blk.cmd}</span>
      <span style={{flex: 1}} />
      <span style={{display: 'flex', alignItems: 'center', gap: 4, paddingRight: 12, opacity: hover}}>
        {blk.exit ? (
          <span style={{color: C.err, fontFamily: MONO, fontSize: 10, marginRight: 2}}>exit {blk.exit}</span>
        ) : null}
        <MiniBtn>copy</MiniBtn>
        <MiniBtn>output</MiniBtn>
        <MiniBtn>rerun</MiniBtn>
      </span>
    </div>
    {(blk.out ?? []).map((l, i) => (
      <div key={i} style={{color: C.muted, whiteSpace: 'pre'}}>
        {l}
      </div>
    ))}
  </div>
);

/** Claude-in-a-pane filler. Kept short so it stays legible in a 4×4 grid. */
export const Session: React.FC<{lines: string[]; size?: number; caret?: boolean}> = ({
  lines,
  size = 11,
  caret,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{fontFamily: MONO, fontSize: size, lineHeight: 1.7, color: C.muted}}>
      {lines.map((l, i) => {
        const cmd = l.startsWith('❯');
        const done = l.startsWith('✓');
        return (
          <div key={i} style={{color: cmd ? C.text : done ? C.ok : C.muted, whiteSpace: 'pre'}}>
            {cmd ? <span style={{color: C.accent}}>❯</span> : null}
            {cmd ? l.slice(1) : l}
          </div>
        );
      })}
      {caret ? (
        <span
          style={{
            display: 'inline-block',
            width: size * 0.55,
            height: size,
            background: C.accent,
            opacity: frame % 30 < 15 ? 0.9 : 0,
            verticalAlign: -1,
          }}
        />
      ) : null}
    </div>
  );
};

/** 4 → 2×2, 9 → 3×3, 16 → 4×4 — same square-ish tiling as the app. */
export const gridDims = (n: number) => {
  const cols = Math.ceil(Math.sqrt(n));
  return {cols, rows: Math.ceil(n / cols)};
};

export const PaneGrid: React.FC<{n: number; children: React.ReactNode}> = ({n, children}) => {
  const {cols, rows} = gridDims(n);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        gap: 7,
        padding: 7,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {children}
    </div>
  );
};
