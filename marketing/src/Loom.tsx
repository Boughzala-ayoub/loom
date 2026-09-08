import React from 'react';
import {AbsoluteFill, Easing, Series, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {
  AppWindow,
  Blk,
  Block,
  C,
  Cursor,
  MONO,
  Mark,
  Pane,
  PaneGrid,
  SANS,
  Session,
  Tab,
  WIN_SCALE,
  gridDims,
  typed,
} from './ui';

/* ── content ─────────────────────────────────────────────────────────────── */

const FOLDERS: (Tab & {path: string})[] = [
  {name: 'newaa', panes: 4, path: 'C:\\Users\\ayoub\\Videos\\claude\\newaa'},
  {name: 'aa', panes: 2, path: 'C:\\Users\\ayoub\\dev\\aa'},
  {name: 'api-gw', panes: 4, path: 'C:\\srv\\api-gw'},
  {name: 'docs', panes: 1, path: 'C:\\srv\\docs'},
  {name: 'infra', panes: 2, path: 'C:\\srv\\infra'},
];

const SESSIONS = [
  [
    '❯ claude',
    '● read src-tauri/src/lib.rs',
    '  412 lines',
    '● edit shell-init.ps1',
    '● run cargo check',
    '  Checking loom v2.1.0',
    '  Finished dev [unoptimized]',
    '✓ done · 42s',
  ],
  [
    '❯ claude',
    '● grep app_data_dir',
    '  3 matches in 2 files',
    '● edit src/session.ts',
    '● edit src/main.ts',
    '● run npm test',
    '  12 passed',
    '✓ cargo test ok',
  ],
  [
    '❯ claude',
    '● plan: split the pty writer',
    '  1. move writer behind a mutex',
    '  2. drain on a worker thread',
    '  3. keep the killer handle',
    '● proceed with this plan?',
    '● waiting on you',
    '  ...',
  ],
  [
    '❯ claude --resume',
    '● restored 24 messages',
    '● npm run tauri build',
    '  vite v6.0.3 building...',
    '  ✓ 41 modules transformed',
    '  Compiling loom v2.1.0',
    '  Built NSIS installer',
    '✓ bundled · 1m 04s',
  ],
  [
    '❯ claude',
    '● scan workspaces.json',
    '  found a UTF-8 BOM',
    '● edit src-tauri/src/lib.rs',
    '● strip it before parse',
    '● run cargo test',
    '  8 passed',
    '✓ done · 18s',
  ],
  [
    '❯ claude',
    '● trace OSC 133 marks',
    '  prompt_start, cmd_start',
    '● patch src/scroll.ts',
    '● redraw the accent bar',
    '● run npm test',
    '  scroll.test.ts ok',
    '✓ 12 tests pass',
  ],
];

const BLOCKS: Blk[] = [
  {cmd: 'npm run tauri build', out: ['  Compiling loom v2.1.0', '  Finished release [optimized]', '  Built NSIS installer'], status: 'ok'},
  {cmd: 'cargo test --quiet', out: ['  test take_utf8 ... FAILED', '  1 failed, 11 passed'], status: 'err', exit: 101},
  {cmd: 'claude', out: ['  ● fixed the split multi-byte read', '  ✓ 12 passed'], status: 'ok'},
];

/* ── shared bits ─────────────────────────────────────────────────────────── */

const Backdrop: React.FC = () => (
  <AbsoluteFill style={{background: `radial-gradient(1300px 760px at 50% -12%, #13223d 0%, ${C.bg} 62%)`}}>
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${C.line}33 1px, transparent 1px), linear-gradient(90deg, ${C.line}33 1px, transparent 1px)`,
        backgroundSize: '56px 56px',
        maskImage: 'radial-gradient(1000px 620px at 50% 45%, #000 0%, transparent 78%)',
        WebkitMaskImage: 'radial-gradient(1000px 620px at 50% 45%, #000 0%, transparent 78%)',
      }}
    />
  </AbsoluteFill>
);

const Scene: React.FC<{dur: number; children: React.ReactNode}> = ({dur, children}) => {
  const frame = useCurrentFrame();
  const opacity = Math.min(
    interpolate(frame, [0, 10], [0, 1], {extrapolateRight: 'clamp'}),
    interpolate(frame, [dur - 10, dur], [1, 0], {extrapolateLeft: 'clamp'}),
  );
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

const Head: React.FC<{title: React.ReactNode; sub?: React.ReactNode; delay?: number}> = ({
  title,
  sub,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 200}});
  return (
    <div
      style={{
        position: 'absolute',
        top: 54,
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: s,
        transform: `translateY(${(1 - s) * 16}px)`,
      }}
    >
      <div style={{fontFamily: SANS, fontSize: 47, fontWeight: 600, letterSpacing: -0.6, color: C.text}}>
        {title}
      </div>
      {sub ? (
        <div style={{marginTop: 12, fontFamily: MONO, fontSize: 19, color: C.faint, letterSpacing: 0.3}}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};

/** Drops the mock window in at 1080p scale, springing up from the headline. */
const Stage: React.FC<{delay?: number; children: React.ReactNode}> = ({delay = 0, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 200, mass: 0.9}});
  return (
    <div
      style={{
        position: 'absolute',
        top: 172,
        left: '50%',
        transform: `translateX(-50%) translateY(${(1 - s) * 26}px) scale(${WIN_SCALE})`,
        transformOrigin: 'top center',
        opacity: s,
      }}
    >
      {children}
    </div>
  );
};

/** Fewer lines as the tiles shrink — the 4×4 grid only has room for two. */
const paneLines = (i: number, n: number) => {
  const s = SESSIONS[i % SESSIONS.length];
  return s.slice(0, n <= 2 ? 8 : n <= 4 ? 6 : n <= 9 ? 4 : 2);
};
const paneFont = (n: number) => (n <= 4 ? 12 : n <= 9 ? 10 : 8);

/* ── 1 · cold open ───────────────────────────────────────────────────────── */

const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({frame, fps, config: {damping: 11, mass: 0.6}});
  const word = typed('loom', frame, 14, 0.17);
  const tag = spring({frame: frame - 48, fps, config: {damping: 200}});

  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 30, transform: `scale(${pop})`}}>
        <Mark size={110} />
        <span style={{fontFamily: MONO, fontSize: 102, fontWeight: 600, letterSpacing: 2, color: C.text}}>
          {word}
          {frame > 14 ? <Cursor w={26} h={76} /> : null}
        </span>
      </div>
      <div
        style={{
          marginTop: 40,
          opacity: tag,
          transform: `translateY(${(1 - tag) * 14}px)`,
          fontFamily: SANS,
          fontSize: 31,
          color: C.muted,
        }}
      >
        a multi-folder agentic terminal workspace
      </div>
      <div style={{marginTop: 16, opacity: tag, fontFamily: MONO, fontSize: 19, color: C.faint, letterSpacing: 1.5}}>
        windows · tauri v2 · no electron
      </div>
    </AbsoluteFill>
  );
};

/* ── 2 · the sprawl ──────────────────────────────────────────────────────── */

const SPRAWL = [
  {x: -430, y: -140, rot: -6},
  {x: -120, y: -20, rot: 3},
  {x: 180, y: -180, rot: -3},
  {x: 380, y: 40, rot: 5},
  {x: -260, y: 190, rot: -4},
];

const MiniWin: React.FC<{i: number}> = ({i}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = SPRAWL[i];
  const f = FOLDERS[i];
  const s = spring({frame: frame - (6 + i * 10), fps, config: {damping: 14, mass: 0.8}});
  const c = interpolate(frame, [92, 122], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <div
      style={{
        position: 'absolute',
        width: 360,
        height: 216,
        left: '50%',
        top: '50%',
        marginLeft: -180,
        marginTop: -108,
        transform: `translate(${p.x * (1 - c)}px, ${p.y * (1 - c)}px) rotate(${p.rot * (1 - c)}deg) scale(${s * (1 - 0.45 * c)})`,
        opacity: s * (1 - c),
        background: C.panel,
        border: `1px solid ${C.lineStrong}`,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 30,
          padding: '0 10px',
          borderBottom: `1px solid ${C.line}`,
          fontFamily: MONO,
          fontSize: 12,
          color: C.faint,
        }}
      >
        <span style={{width: 7, height: 7, borderRadius: '50%', background: C.lineStrong}} />
        {f.name}
        <span style={{flex: 1}} />
        <span>✕</span>
      </div>
      <div style={{padding: '8px 0 0 12px', background: C.bg, height: '100%'}}>
        <Session lines={SESSIONS[i % SESSIONS.length].slice(0, 3)} size={11} />
      </div>
    </div>
  );
};

const Sprawl: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const out = spring({frame: frame - 108, fps, config: {damping: 200}});

  return (
    <AbsoluteFill>
      <div style={{opacity: interpolate(frame, [86, 104], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>
        <Head title="one window per folder doesn't scale" sub="alt+tab · alt+tab · which one was waiting?" />
      </div>
      <AbsoluteFill>
        {SPRAWL.map((_, i) => (
          <MiniWin key={i} i={i} />
        ))}
      </AbsoluteFill>

      <AbsoluteFill style={{opacity: out, alignItems: 'center', justifyContent: 'center'}}>
        <div style={{transform: `translateY(${(1 - out) * 20}px)`}}>
          <div style={{fontFamily: SANS, fontSize: 47, fontWeight: 600, color: C.text, textAlign: 'center'}}>
            one window. every folder.
          </div>
          <div
            style={{
              display: 'flex',
              gap: 10,
              marginTop: 40,
              transform: 'scale(1.9)',
              transformOrigin: 'center',
              justifyContent: 'center',
            }}
          >
            <Mark size={20} />
            {FOLDERS.map((f, i) => (
              <div
                key={f.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 9px',
                  borderRadius: 6,
                  border: `1px solid ${i === 0 ? C.line : 'transparent'}`,
                  background: i === 0 ? C.raise : 'transparent',
                  fontFamily: MONO,
                  fontSize: 13,
                  color: i === 0 ? C.text : C.muted,
                  opacity: spring({frame: frame - 116 - i * 5, fps, config: {damping: 200}}),
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: i === 0 ? C.accent : C.lineStrong,
                  }}
                />
                {f.name}
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ── 3 · folders become tabs ─────────────────────────────────────────────── */

const Tabs: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const shown = Math.min(FOLDERS.length, 1 + Math.max(0, Math.floor((frame - 14) / 30)));
  const active = shown - 1;
  const folder = FOLDERS[active];

  return (
    <AbsoluteFill>
      <Head
        title={
          <>
            every folder is a <span style={{color: C.accent}}>tab</span>
          </>
        }
        sub="switch tabs — every shell stays alive behind you"
      />
      <Stage delay={4}>
        <AppWindow
          tabs={FOLDERS.slice(0, shown)}
          active={active}
          path={folder.path}
          count={folder.panes}
          tabScale={(i) => spring({frame: frame - 14 - i * 30, fps, config: {damping: 200}})}
        >
          <PaneGrid n={folder.panes}>
            {Array.from({length: folder.panes}, (_, i) => (
              <Pane
                key={`${folder.name}-${i}`}
                title={`${String(i + 1).padStart(2, '0')} · claude`}
                state={i === 0 ? 'active' : 'idle'}
                busy={i % 2 === 0}
              >
                <Session lines={paneLines(i + active, folder.panes)} size={paneFont(folder.panes)} caret={i === 0} />
              </Pane>
            ))}
          </PaneGrid>
        </AppWindow>
      </Stage>
    </AbsoluteFill>
  );
};

/* ── 4 · pane grid scales ────────────────────────────────────────────────── */

// The 4×4 has to land early enough to actually be looked at before the cut.
const BEATS = [
  {at: 0, n: 1},
  {at: 40, n: 4},
  {at: 78, n: 9},
  {at: 112, n: 16},
];

const Panes: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const beat = BEATS.filter((b) => frame >= b.at).pop() ?? BEATS[0];
  const {cols, rows} = gridDims(beat.n);

  return (
    <AbsoluteFill>
      <Head
        title={
          <>
            one folder, up to <span style={{color: C.accent}}>16 agents</span>
          </>
        }
        sub={`${beat.n} real ConPTY pane${beat.n > 1 ? 's' : ''} · ${cols}×${rows} · all rooted in newaa`}
      />
      <Stage delay={4}>
        <AppWindow tabs={FOLDERS} active={0} path={FOLDERS[0].path} count={beat.n}>
          <PaneGrid n={beat.n}>
            {Array.from({length: beat.n}, (_, i) => {
              const s = spring({frame: frame - beat.at - i * 0.8, fps, config: {damping: 200}});
              return (
                <Pane
                  key={i}
                  title={`${String(i + 1).padStart(2, '0')} · claude`}
                  state={i === 0 ? 'active' : 'idle'}
                  busy={i % 3 !== 1}
                  style={{transform: `scale(${0.94 + 0.06 * s})`, opacity: s}}
                >
                  <Session lines={paneLines(i, beat.n)} size={paneFont(beat.n)} caret={i === 0} />
                </Pane>
              );
            })}
          </PaneGrid>
        </AppWindow>
      </Stage>
    </AbsoluteFill>
  );
};

/* ── 5 · the waiting cue ─────────────────────────────────────────────────── */

const WAITING = 4;

const Waiting: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const hit = 62;
  const on = frame >= hit;
  // One ring per blip, two blips, ~1s apart.
  const ring = (start: number) => ({
    scale: interpolate(frame, [start, start + 34], [1, 1.35], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    opacity: interpolate(frame, [start, start + 34], [0.75, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
  });

  return (
    <AbsoluteFill>
      <Head
        title={
          <>
            you'll know <span style={{color: C.warn}}>which one</span> is waiting
          </>
        }
        sub="turn done → yellow border, waiting in the header, and a blip"
      />
      <Stage delay={4}>
        <AppWindow tabs={FOLDERS} active={0} path={FOLDERS[0].path} count={9}>
          <PaneGrid n={9}>
            {Array.from({length: 9}, (_, i) => {
              const isW = on && i === WAITING;
              return (
                <div key={i} style={{position: 'relative', display: 'flex'}}>
                  {isW
                    ? [hit, hit + 30].map((start) => {
                        const r = ring(start);
                        return (
                          <div
                            key={start}
                            style={{
                              position: 'absolute',
                              inset: 0,
                              border: `2px solid ${C.warn}`,
                              borderRadius: 8,
                              transform: `scale(${r.scale})`,
                              opacity: r.opacity,
                            }}
                          />
                        );
                      })
                    : null}
                  <Pane
                    title={`${String(i + 1).padStart(2, '0')} · ${isW ? 'waiting' : 'claude'}`}
                    state={isW ? 'waiting' : i === 0 ? 'active' : 'idle'}
                    busy={!isW && i % 3 !== 1}
                    style={{flex: 1, minWidth: 0}}
                  >
                    <Session
                      lines={isW ? ['❯ claude', '● ready for your call', '  waiting…'] : paneLines(i, 9)}
                      size={10}
                      caret={isW}
                    />
                  </Pane>
                </div>
              );
            })}
          </PaneGrid>
        </AppWindow>
      </Stage>
    </AbsoluteFill>
  );
};

/* ── 6 · command blocks ──────────────────────────────────────────────────── */

const Blocks: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const hover = interpolate(frame, [86, 100], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const shown = BLOCKS.filter((_, i) => frame >= 16 + i * 26);

  return (
    <AbsoluteFill>
      <Head
        title={
          <>
            every command is a <span style={{color: C.accent}}>block</span>
          </>
        }
        sub="OSC 133 marks · green passed, red failed · copy, output, rerun"
      />
      <Stage delay={4}>
        <AppWindow tabs={FOLDERS} active={0} path={FOLDERS[0].path} count={4}>
          <div style={{position: 'absolute', inset: 7, display: 'flex'}}>
            <Pane title="01 · powershell — zoomed (F2)" state="active" busy style={{flex: 1}}>
              <div style={{paddingTop: 4, paddingRight: 6}}>
                {shown.map((b, i) => (
                  <div
                    key={b.cmd}
                    style={{
                      opacity: spring({frame: frame - 16 - i * 26, fps, config: {damping: 200}}),
                    }}
                  >
                    <Block blk={b} size={13} hover={hover} />
                  </div>
                ))}
                <Session lines={['❯ ']} size={13} caret />
              </div>
            </Pane>
          </div>
        </AppWindow>
      </Stage>
    </AbsoluteFill>
  );
};

/* ── 7 · session resume ──────────────────────────────────────────────────── */

const Resume: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // closed between 30 and 58; the window comes back with everything in place.
  const close = interpolate(frame, [26, 44], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const reopen = spring({frame: frame - 58, fps, config: {damping: 200}});
  const back = frame < 44 ? close : reopen;
  const restored = frame > 78;

  return (
    <AbsoluteFill>
      <Head title="close it. reopen it. nothing is lost." sub="each pane pins its own claude session id" />
      <div style={{opacity: back, transform: `scale(${0.96 + 0.04 * back})`, transformOrigin: '50% 45%'}}>
        <Stage delay={0}>
          <AppWindow tabs={FOLDERS} active={0} path={FOLDERS[0].path} count={4}>
            <PaneGrid n={4}>
              {Array.from({length: 4}, (_, i) => (
                <Pane
                  key={i}
                  title={`${String(i + 1).padStart(2, '0')} · claude`}
                  state={i === 0 ? 'active' : 'idle'}
                  busy={restored && i % 2 === 0}
                >
                  <Session
                    lines={
                      restored
                        ? paneLines(i, 4)
                        : [`❯ claude --resume ${['a3f1', '9c04', '77be', 'd128'][i]}`, '↻ restoring conversation…']
                    }
                    size={12}
                    caret={i === 0}
                  />
                </Pane>
              ))}
            </PaneGrid>
          </AppWindow>
        </Stage>
      </div>
    </AbsoluteFill>
  );
};

/* ── 8 · close ───────────────────────────────────────────────────────────── */

const SPECS = ['tauri v2', 'system webview2', 'real conpty', 'no electron', 'no node at runtime'];

const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({frame: frame - 4, fps, config: {damping: 12, mass: 0.7}});
  const line = spring({frame: frame - 34, fps, config: {damping: 200}});
  const cta = spring({frame: frame - 68, fps, config: {damping: 200}});

  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 26, transform: `scale(${pop})`}}>
        <Mark size={92} />
        <span style={{fontFamily: MONO, fontSize: 86, fontWeight: 600, letterSpacing: 2, color: C.text}}>
          loom
          <Cursor w={22} h={64} />
        </span>
      </div>

      <div style={{display: 'flex', gap: 10, marginTop: 44}}>
        {SPECS.map((s, i) => (
          <span
            key={s}
            style={{
              fontFamily: MONO,
              fontSize: 17,
              color: C.muted,
              background: C.panel,
              border: `1px solid ${C.line}`,
              borderRadius: 999,
              padding: '7px 16px',
              opacity: spring({frame: frame - 34 - i * 5, fps, config: {damping: 200}}),
            }}
          >
            {s}
          </span>
        ))}
      </div>

      <div style={{marginTop: 46, opacity: line, fontFamily: SANS, fontSize: 27, color: C.faint}}>
        open every folder you're working in. keep every agent in sight.
      </div>

      <div
        style={{
          marginTop: 34,
          opacity: cta,
          transform: `translateY(${(1 - cta) * 12}px)`,
          fontFamily: MONO,
          fontSize: 20,
          color: C.accent,
          background: C.accentDim,
          border: `1px solid ${C.accent}`,
          borderRadius: 8,
          padding: '10px 22px',
        }}
      >
        npm run tauri build
      </div>
      <div style={{marginTop: 16, opacity: cta, fontFamily: MONO, fontSize: 15, color: C.faint}}>
        windows 10/11 · installer in src-tauri\target\release\bundle\nsis
      </div>
    </AbsoluteFill>
  );
};

/* ── timeline ────────────────────────────────────────────────────────────── */

const SCENES: {c: React.FC; dur: number}[] = [
  {c: ColdOpen, dur: 90},
  {c: Sprawl, dur: 150},
  {c: Tabs, dur: 180},
  {c: Panes, dur: 200},
  {c: Waiting, dur: 180},
  {c: Blocks, dur: 180},
  {c: Resume, dur: 150},
  {c: Close, dur: 150},
];

export const TOTAL = SCENES.reduce((n, s) => n + s.dur, 0);

export const Loom: React.FC = () => (
  <AbsoluteFill style={{background: C.bg}}>
    <Backdrop />
    <Series>
      {SCENES.map(({c: Comp, dur}, i) => (
        <Series.Sequence key={i} durationInFrames={dur}>
          <Scene dur={dur}>
            <Comp />
          </Scene>
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
