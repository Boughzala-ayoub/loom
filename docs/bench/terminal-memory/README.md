# Terminal memory and parse bench

Replays the same two byte streams through xterm.js (headless) and `alacritty_terminal`,
24 panes of 120x45. Numbers and caveats are in `docs/ui-stack-study.md`.

```
cd docs/bench/terminal-memory
npm install && node gen.mjs                        # writes scroll.bin and tui.bin
node --expose-gc xterm-bench.mjs mem 1500          # also: mem 5000, tp
cargo build --release
BENCH_DIR=. target/release/alac-bench.exe mem 1500 # also: mem 5000, tp
```

Run each scenario in its own process, or the second one inherits the first's heap.
