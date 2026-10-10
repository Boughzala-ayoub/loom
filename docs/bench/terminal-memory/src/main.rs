// alacritty_terminal 0.26 on the same workloads as xterm-bench.mjs.
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::{cell::Cell, Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use std::time::Instant;

const COLS: usize = 120;
const ROWS: usize = 45;
const PANES: usize = 24;

struct Size;
impl Dimensions for Size {
    fn total_lines(&self) -> usize { ROWS }
    fn screen_lines(&self) -> usize { ROWS }
    fn columns(&self) -> usize { COLS }
}

fn mem() -> (f64, f64) {
    let m = memory_stats::memory_stats().unwrap();
    (m.physical_mem as f64 / 1048576.0, m.virtual_mem as f64 / 1048576.0)
}

fn nth_line_end(buf: &[u8], n: usize) -> usize {
    let mut c = 0;
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\n' {
            c += 1;
            if c == n { return i + 1; }
        }
    }
    buf.len()
}

fn term(scrollback: usize) -> Term<VoidListener> {
    Term::new(Config { scrolling_history: scrollback, ..Config::default() }, &Size, VoidListener)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::env::var("BENCH_DIR").unwrap();
    let scroll = std::fs::read(format!("{dir}/scroll.bin")).unwrap();
    let tui = std::fs::read(format!("{dir}/tui.bin")).unwrap();
    println!("alacritty_terminal 0.26, size_of Cell = {} bytes", std::mem::size_of::<Cell>());

    match args.get(1).map(String::as_str) {
        Some("mem") => {
            let scrollback: usize = args[2].parse().unwrap();
            let chunk = &scroll[..nth_line_end(&scroll, scrollback + ROWS + 100)];
            let (ws0, priv0) = mem();
            let mut terms: Vec<(Term<VoidListener>, Processor)> =
                (0..PANES).map(|_| (term(scrollback), Processor::default())).collect();
            let (ws1, priv1) = mem();
            for (t, p) in terms.iter_mut() {
                for piece in chunk.chunks(65536) {
                    p.advance(t, piece);
                }
            }
            let (ws2, priv2) = mem();
            let cells = (PANES * (scrollback + ROWS) * COLS) as f64;
            println!(
                "scrollback {scrollback}: empty +{:.1} MB private, filled +{:.1} MB private (+{:.1} MB working set); {:.1} bytes per cell; history {} rows",
                priv1 - priv0, priv2 - priv0, ws2 - ws0, (priv2 - priv0) * 1048576.0 / cells,
                terms[0].0.history_size()
            );
            // A run-length line store: trimmed text plus (start, len, fg, bg, flags) per style run.
            let grid = terms[0].0.grid();
            let (mut bytes, mut rows, mut runs_total) = (0usize, 0usize, 0usize);
            for l in (-(terms[0].0.history_size() as i32))..0 {
                let row = &grid[Line(l)];
                let mut text = 0usize;
                let mut runs = 0usize;
                let mut prev: Option<(_, _, _)> = None;
                let mut last_used = 0usize;
                for c in 0..COLS {
                    let cell = &row[Column(c)];
                    if cell.c != ' ' { last_used = c + 1; }
                }
                for c in 0..last_used {
                    let cell = &row[Column(c)];
                    text += cell.c.len_utf8();
                    let key = (cell.fg, cell.bg, cell.flags);
                    if prev != Some(key) { runs += 1; prev = Some(key); }
                }
                bytes += 24 + text + runs * 12; // 24 B row header, 12 B per run
                runs_total += runs;
                rows += 1;
            }
            println!("compact history estimate: {:.0} B/row, {:.1} runs/row, {:.2} B/cell; 24 panes = {:.1} MB",
                bytes as f64 / rows as f64, runs_total as f64 / rows as f64,
                bytes as f64 / rows as f64 / COLS as f64,
                bytes as f64 / rows as f64 * (scrollback * PANES) as f64 / 1048576.0);
            let _ = (ws1, terms);
        }
        _ => {
            for (name, buf) in [("scroll", &scroll), ("tui   ", &tui)] {
                let mut t = term(1500);
                let mut p: Processor = Processor::default();
                let t0 = Instant::now();
                for piece in buf.chunks(65536) {
                    p.advance(&mut t, piece);
                }
                let s = t0.elapsed().as_secs_f64();
                println!("{name}: {:.1} MB in {:.2} s = {:.1} MB/s", buf.len() as f64 / 1048576.0, s, buf.len() as f64 / 1048576.0 / s);
            }
        }
    }
}
