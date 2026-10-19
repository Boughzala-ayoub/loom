# Loom crash investigation, 2026-10-19

Loom crashed at 09:14:06 on 2026-10-19 with `STATUS_HEAP_CORRUPTION` (0xc0000374) in ntdll. It is the fourth memory-corruption crash in three weeks. All four were detected by code that did nothing wrong. Each time, a heap block had been damaged earlier by some other code, and whoever touched the heap next took the fall. The minidumps can't name that other code, because they hold no heap. They do narrow it down a lot, and the strongest lead is a confirmed use-after-free fix in wry, which Loom's wry 0.55.1 doesn't have.

## Status, 2026-10-19

Approved and done on the `loom/crash-fixes` branch:

- **B.1, the upgrade.** tauri 2.12.4 with tauri-runtime-wry 2.12.2, wry 0.57.0, tao 0.37.1, webview2-com 0.39.1 and tauri-build 2.7.3. `@tauri-apps/api` is at 2.12.4 and `@tauri-apps/cli` at 2.12.3. Loom's own `windows` dependency moved to 0.62 without a single code change. cpal and tauri-plugin-opener keep their own `windows` 0.61 pair beside it, so the windows-core 0.61.2 pin in Cargo.lock still matters. The wry patch fallback wasn't needed.
- **A.3, the log**, in `src-tauri/src/logfile.rs`. One change from the plan below: instead of pointing stderr at the file with `SetStdHandle`, the module writes through its own handle, and the seven `eprintln!` calls now go through `logfile::line`. `eprintln!` panics when its write fails, so a full disk would have turned every one of them into an abort.
- **B.3, the hardening.** `procs.rs` reads no more TCP rows than the buffer holds. `pipe.rs` reads the TOKEN_USER with `read_unaligned` after a length check, and `control.rs` builds its pipe's owner from `pipe::sid()` instead of repeating the token code.

Left to Ayoub: A.1 and A.2, the admin commands for full dumps and page heap.

The rest of this file is the investigation as first written, before approval.

## Crash history

From the Application event log and `%LOCALAPPDATA%\CrashDumps`. Uptime is from each dump's process creation time.

| When | Build | Up for | Exception | Thread that hit it | Heap failure type |
|---|---|---|---|---|---|
| 2026-09-29 09:55 | 40489b8, from the build time | 7 h 19 m | 0xc0000374 | main, in `RevokeDragDrop` | 13, free-list corruption |
| 2026-10-14 17:38 | 4095561 | 18 h 20 m | 0xc0000005 | main, in tao's event buffer | n/a, write to freed memory |
| 2026-10-16 20:54 | 5fbdb4b | 18 h 33 m | 0xc0000374 | tokio blocking, `last_messages` | 13, free-list corruption |
| 2026-10-19 09:14 | 5fbdb4b | 11 h 05 m | 0xc0000374 | tokio blocking, `git_run` | 6, buffer overrun |

Before Sep 29 the log shows only hangs (event 1002: Aug 1-2, Sep 8, Sep 12, Sep 23, Sep 28, Oct 5). The first corruption crash came a day after a burst of new native-facing work on Sep 26-28. That burst added the agent overlay window (768c2dd), the winsqlite3 seeding (4cd19e4), the output bus (fbe8547), the PTY lifetime rework (4cd19e4) and one-taskkill shutdown (df1047d).

No Loom log exists because Loom writes none. The release exe is a GUI-subsystem program, so its few `eprintln!` lines go nowhere and a panic would leave no message.

## What each dump shows

I unwound every thread with the PE unwind tables, named Windows frames from Microsoft's public PDBs (downloading the exact older ntdll, combase, ole32 and friends for the dumps taken before the Oct 18 Windows update), and named Loom frames by rebuilding the installed commits with debug info and matching each function by instruction sequence. For Oct 16 and Oct 19 every Loom frame matched its rebuilt counterpart at a similarity of 0.994 to 1.000, so those stacks are reliable. Sep 29 is a nearest match, explained in its section.

### Oct 19, the crash you asked about

The thread was a tokio blocking-pool worker running the `git_run` command. It was dropping git's captured output at the end of `git_run` (src-tauri/src/lib.rs:834 in 5fbdb4b):

```
ntdll!RtlReportFatalFailure
ntdll!RtlpHeapHandleError / RtlpHpHeapHandleError
ntdll!RtlpCoalesceFreeBlocks        <- the check that failed
ntdll!RtlpFreeHeap / RtlFreeHeap
loom_lib::git_run+0x14f4            drop(out): Vec<u8> of git's stdout/stderr
tokio blocking pool                 commands::git_run -> spawn_blocking
```

ntdll's failure record (`RtlpHeapFailureInfo`, which is in the dump) says FailureType 6, `heap_failure_buffer_overrun`. The block being freed was at 0x1396d09d6b0, 0x810 bytes. The 16-byte header of the next block, at 0x1396d09dec0, had been overwritten. ntdll knew from the neighbours what that header should have held (size 0x35 units, previous size 0x81 units) and found something else. Freeing git's buffer only noticed the damage. Overwriting a header means either a write past the end of the block in front, a write just before the start of the block behind, or a write through a stale pointer into memory that used to belong to a bigger, since-freed block.

At that moment 12 panes were open, each with its four threads: reader (`pump`), writer, output emitter and exit waiter. No thread was in Loom's own unsafe code, in whisper.cpp or in cpal. Two other blocking workers were reading child output for `usage::get_headers`.

### Oct 16, same build

A blocking worker was running `last_messages` and parsing a Claude transcript line with `serde_json::from_slice` (lib.rs:1572). The allocation failed on FailureType 13, `heap_failure_freelists_corruption`. A free block's neighbour on the free list held the link value `0x007ffc3f9cf92e28`. That is `ntdll!RtlDeactivateActivationContextUnsafeFast+0x14e`, a return address, stored one byte off. user32 calls that function when it leaves a window procedure, so the value is most likely a stale byte pattern from the UI thread's stack, copied into memory that had already been freed.

This dump happens to include 62 KB of the damaged heap region. The free block whose neighbour was corrupted had last held this string:

```
window.__TAURI_INTERNALS__.runCallback(2750536155, { message: [[3565142849,"\u001b[?25l\u001b[38;2;153;153;153m ... Update(~\\polymarket_claude\\fv_forward.py) ...
```

That is one output-bus batch on its way to the page through `webview.eval`. The same region holds WebView2's own allocations (user-agent strings, `sec-ch-ua` headers) next to Loom's Rust strings (JSON keys such as `tool_use_ids`, `porcelain`, git paths). Rust's allocator, WebView2's in-process DLL and COM all share the one process heap, so a bug in any of them damages the others.

### Oct 14, earlier build

The previous investigation decoded this one: the main thread, in `tauri_runtime_wry::handle_user_message` -> `Window::set_focus` -> `SetForegroundWindow` -> `WM_NCACTIVATE` to the other Loom window -> tao `lose_active_focus` -> `EventLoopRunner::send_event` -> `VecDeque::push_back`. The write hit unmapped memory.

I went back into that dump for the reason. tao's event buffer `VecDeque` was still in use: capacity 128, head 96, its `RefCell` mutably borrowed by the `push_back` in progress, buffer at 0x1dea2723fb0. Elsewhere in the dump, the block at 0x1dea2ff5d90 starts with two heap pointers, 0x1dea2d78080 and 0x1dea2723fb0, which is the shape of a free-list entry whose back link is tao's buffer. ntdll encrypts block headers, so I can't prove from the dump that this block is free. Together with the unmapped page tao wrote to, it's strong evidence that something called `HeapFree` on the buffer tao was still using. tao frees its buffer only when it reallocates, and then it holds the new pointer. So either another component freed this address (a double free, where the first free was by an earlier owner of the same memory), or the whole `Rc<EventLoopRunner>` was dropped early while windows still held raw references to it.

The writes tao makes into that buffer are whole `Event` values built on the UI thread's stack, padding included. That is exactly the kind of write that left a UI-stack return address, one byte off, inside a freed block on Oct 16.

### Sep 29, earlier build

The main thread was in `RevokeDragDrop` -> `GetDragDropExtensionPoint` -> `CoCreateInstance` -> COM catalog -> `CComClassInfo::~CComClassInfo` -> `RtlFreeHeap`, FailureType 13. COM was freeing its own object when it found the free list damaged.

The Loom frame under `RevokeDragDrop` was loom.exe+0x2af25e. The installed Sep 29 exe is no longer on disk, so I can't match it instruction by instruction. In the rebuilt 40489b8 exe only two functions call `RevokeDragDrop`. One is tao's `WM_DESTROY` handler (tao 0.35.3 `event_loop.rs:1072`) at RVA 0x2af72b, 0x4cd away, which is the usual drift between builds. The other is wry's `DragDropController::inject_in_hwnd` at 0x6a823, about 2.5 MB away. So a Loom window was being destroyed.

That matters because of the subclass order. wry installs its WebView2 parent subclass on the same window after tao installs its own, and the most recent subclass runs first. On `WM_DESTROY`, wry's `parent_subclass_proc` dropped the boxed WebView2 controller, then passed the message on to tao, and tao's `RevokeDragDrop` was the first to notice the heap was damaged. That drop is the code in suspect 1.

## What this rules out

- **The code on the crashing threads.** All four victims are safe Rust, tao, or COM's own bookkeeping. `git_run` and `recent_messages` are plain std and serde_json, and safe Rust can't overwrite a heap header.
- **PC dictation.** No dump has `AudioSes.dll` loaded, so cpal never opened the microphone in those sessions, and no whisper.cpp threads existed at the times of the crashes. The `models` folder exists, so phone dictation may have run earlier in a session. That doesn't clear whisper.cpp entirely, but nothing points at it.
- **Bad RAM, mostly.** The damage is pointer-shaped every time: what looks like a live buffer linked into the free list, a link value pointing 0x7b bytes below its own block (Sep 29), and a stack return address written one byte off. Random bit flips don't produce valid heap links. Windows Memory Diagnostic would settle it with one reboot, but I'd treat it as the least likely cause.
- **A crash in Loom's own unsafe Win32 code.** I read every `unsafe` block in loom.exe. See the audit table below. None writes past a buffer or frees memory it doesn't own.

## Suspected causes, ranked

### 1. wry's WebView2 parent-subclass teardown: use-after-free and double free (likely)

Loom runs wry 0.55.1. Its `parent_subclass_proc` in `src/webview2/mod.rs` handles `WM_DESTROY` and wry's own `PARENT_DESTROY_MESSAGE` like this:

```rust
if !(dwrefdata as *mut ()).is_null() {
  drop(Box::from_raw(dwrefdata as *mut ICoreWebView2Controller)); // Release() on the controller
  let _ = SetWindowSubclass(hwnd, Some(Self::parent_subclass_proc), PARENT_SUBCLASS_ID as _, null());
}
```

Releasing the controller can dispatch window messages synchronously. A nested `WM_SIZE`, `WM_SETFOCUS` or `WM_MOVE` re-enters the proc with the same `dwrefdata`, already freed, and calls the controller through it. A nested `WM_DESTROY` or `PARENT_DESTROY_MESSAGE` drops the same `Box` again. That is a double free of the box plus a second `Release()` on a COM object WebView2 still uses. That double free is my reading of the 0.55.1 code. The upstream report describes the stale-pointer half. wry fixed the re-entry in 0.56.1 (tauri-apps/wry#1794, PR #1795, merged 2026-08-10): "Fix a Windows crash when the WebView2 parent subclass is re-entered after its controller reference data is cleared." The fix clears the refdata before dropping the controller.

It fits:

- A double free leaves no trace until the freed memory is reused. That gives the "live buffer on the free list" seen on Oct 14 and the free-list damage seen on Oct 16 and Sep 29.
- An over-released COM object can let WebView2's in-process DLL keep writing into freed heap memory, and that would damage whatever reuses the memory, COM's own objects included.
- On Sep 29 the damage was found during a window's `WM_DESTROY`, moments after wry's handler had released the WebView2 controller on that same message.

It doesn't fully fit. Loom destroys a window only when the overlay preference goes to off, and when the main window closes. Your overlay preference is "always", so a teardown inside the Oct 18-19 session needs something else, for example WebView2 recreating its controller after a browser-process restart. I can't see that from the dump. Damage from a teardown can also sit unnoticed for hours before an unlucky allocation trips over it. The wry fix is still the first thing to take, because it is a confirmed memory-safety bug in code Loom runs, and one crash caught its aftermath directly.

### 2. tao's Windows event loop, the runner and its subclass input (plausible)

The Oct 14 crash shows tao's event buffer freed under it, and the Oct 16 damage looks like tao's writes landing in freed memory. tao 0.35.3 keeps the runner in an `Rc` that window subclasses reach through raw `Box::into_raw` pointers (`subclass_window`, `public_window_callback`, freed on `WM_NCDESTROY` when the recursion depth is 0). A premature drop of the runner would free its buffer while windows still use it, and would leave the runner's memory looking intact, which is what the Oct 14 dump shows. tao 0.36.0 removed window subclassing on Windows entirely ("Removed window subclassing on Windows"), and fixed two deadlocks caused by re-entrant message processing. I found no tao issue naming this exact symptom, so this stays a suspect rather than a match.

The Oct 14 trigger was a focus change between Loom's two windows. With the overlay always on, focus moves between the main window and the overlay every time you click a card or come back to Loom, and `syncOverlay` emits `overlay-rows` to both webviews as pane states change.

### 3. IPC volume through WebView2 (contributing)

Every output-bus flush becomes a `runCallback(...)` string, travels to the main thread as a user event, is converted to UTF-16 and passed to `ExecuteScript`. A pane streaming long test runs, as the Claude pane in "game website" was doing at 09:14, produces several of these a second, each a fresh heap allocation on the main thread. Oct 16 shows the corrupted free block had held one of them. Volume doesn't create a bug, but it makes the main thread allocate and free constantly next to whatever is corrupting the heap. That makes a rare race fire sooner and makes it likely that IPC buffers are the ones hit. The `loomctl read`/`send` calls every 20 minutes go through `control.rs` and the page, with no unsafe code, and I don't think they matter here.

### 4. whisper.cpp and winsqlite3 (unlikely)

Both are C code in loom.exe. whisper.cpp only runs during a dictation, and nothing shows one near any of the crashes. `codex_state.rs` uses winsqlite3 correctly: it closes every handle it opens, including on a failed open, finishes the backup before closing, and only runs when a Codex pane starts.

### 5. Loom's own unsafe code (ruled out as the cause, two small fixes)

See the audit. Nothing writes out of bounds or frees twice.

## Unsafe and FFI audit

| Where | What it does | Verdict |
|---|---|---|
| `lib.rs` `Job` (`pids`, `end_pass`, `Drop`) | `QueryInformationJobObject` into a 4097-word buffer it sizes correctly, `OpenProcess`/`TerminateProcess`/`CloseHandle` once each | Correct. `Job` isn't `Clone`, so the handle is closed exactly once. |
| `lib.rs` `image_of`, `exe_name`, `wait_exit`, `contain` | `QueryFullProcessImageNameW` with a 32 768-char buffer, job assignment, handle closes | Correct. |
| `lib.rs` `overlay` | `ShowWindow(hwnd, SW_SHOWNOACTIVATE)` from a tokio worker | Safe. Windows marshals cross-thread `ShowWindow` to the owning thread. |
| `procs.rs` `listening` | `GetExtendedTcpTable` with retry on `ERROR_INSUFFICIENT_BUFFER`, then a slice of `buf[0]` rows | Read only. The row count isn't checked against the buffer length, so a bad count would over-read, never write. Worth a one-line bound. |
| `procs.rs` `read_list`, `entries` | `NtQuerySystemInformation` into a `Vec<u64>`, walk by `NextEntryOffset` | Read only. Correct. |
| `procs.rs` `current_dir` | `ReadProcessMemory` into buffers sized from what it reads | Correct. |
| `pipe.rs` `sid`, `current_user`, `owner_is` | `GetTokenInformation` into a `Vec<u8>`, then reads it as `TOKEN_USER` | Correct sizes. Casting a `Vec<u8>` to `TOKEN_USER` is unaligned in theory (harmless on x64 since the heap returns 16-byte-aligned blocks). Use `Vec<u64>` to make it sound. |
| `control.rs` `owner_only`, `create` | SDDL to security descriptor, `SECURITY_ATTRIBUTES` leaked on purpose for the app's life | Correct. |
| `control.rs` `answer`, `unless_gone` | tokio named pipe, one request per connection, 1 MiB read cap, 64 connections max | No unsafe. Pending overlapped reads are owned by mio, which keeps the buffer alive on drop. |
| `codex_state.rs` | winsqlite3 open, backup, close | Correct. |
| `awake.rs` | `SetThreadExecutionState` | Correct. |
| `usage.rs` | `GetFileInformationByHandle` into a stack struct | Correct. |
| `dictate.rs` | whisper-rs context under a `Mutex`, a fresh state per clip; cpal stream owned by its thread | Correct use of both crates. |
| portable-pty 0.9.0 `win/*` | `CreatePseudoConsole`, attribute list, `CreateProcessW`, `ResizePseudoConsole`, `ClosePseudoConsole` in `Drop` | Correct ownership. `PsuedoCon` lives in an `Arc<Mutex<Inner>>` shared by master and slave, so `ClosePseudoConsole` runs once, after the last resize. Loom keeps resizes off the map lock and drops sessions outside it. |
| filedescriptor 0.8.3 | `ReadFile`/`WriteFile` with the slice length, `DuplicateHandle`, `CloseHandle` | Correct for ConPTY's anonymous pipes. The reader thread reads from its own duplicate handle, so closing the console under it is safe. |
| wry 0.55.1 `parent_subclass_proc` | see cause 1 | Use-after-free and double free on re-entry. Fixed upstream in 0.56.1. |

Large output doesn't take an unsafe path anywhere in Loom. `pump` reads into an 8 KiB stack buffer, `take_utf8` and the emitter are safe Rust, and back-pressure (`output::Flow`) caps four unacknowledged chunks per pane.

## Fixes

### A. Make the next crash leave a trace (do these first)

1. **Full crash dumps (admin, one command, no code).** WER already writes `%LOCALAPPDATA%\CrashDumps\loom.exe.<pid>.dmp`, but as a minidump without the heap. With the heap, the next dump shows the damaged block's contents and its neighbours, which usually names the owner. Run this once in an admin PowerShell:

   ```powershell
   $k = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\loom.exe'
   New-Item $k -Force | Out-Null
   New-ItemProperty $k -Name DumpType  -PropertyType DWord -Value 2 -Force   # full memory
   New-ItemProperty $k -Name DumpCount -PropertyType DWord -Value 3 -Force   # keep the last three
   ```

   Expect a few hundred MB per dump. I'd use this as the crash handler and skip an in-process one. A `SetUnhandledExceptionFilter` plus `MiniDumpWriteDump` would run inside a process whose heap is already broken, and ntdll raises heap corruption as a non-continuable failure, so it isn't a reliable place to catch these. WER writes the dump from outside the process, which is why the four dumps exist at all.

2. **Page heap, to catch the corruption when it happens (admin, no code, costs memory).** Page heap makes the heap check every free and allocation and record a stack for each. A double free then crashes on the second free, in the code that does it, instead of days later in `git_run`. Start with normal page heap:

   ```powershell
   $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\loom.exe'
   New-Item $k -Force | Out-Null
   New-ItemProperty $k -Name GlobalFlag     -PropertyType DWord -Value 0x02000000 -Force
   New-ItemProperty $k -Name PageHeapFlags  -PropertyType DWord -Value 0x2 -Force   # 0x3 = full page heap
   ```

   Full page heap (0x3) puts each allocation against a guard page and catches an overrun or use-after-free at the faulting instruction. It is much heavier, and your PC usually runs near 85% RAM, so try normal first. Page heap also applies to the `loom.exe --claude-hook` style helper runs, which will start a little slower. Delete the key to turn it off. Restart Loom after either change.

3. **A persistent log (code, small).** I propose `%LOCALAPPDATA%\dev.ayoub.loom\logs\loom.log`, next to the trash folder:
   - At the top of `run()`, in release builds, open the file for append, rename it to `loom.1.log` first if it's over 5 MB, and point `STD_ERROR_HANDLE` at it with `SetStdHandle`. Every existing `eprintln!` then lands in the file with no other change, and so does anything a dependency prints to stderr.
   - A panic hook that writes the message, the location and `Backtrace::force_capture()` before `panic = "abort"` kills the process. The release exe is stripped, so frames come out as addresses, which the rebuild-and-match method above turns into names.
   - A tiny `log::Log` implementation for warnings and errors, so portable-pty's `log::error!` on a failed `CreateProcessW` and tao/wry/tauri warnings are kept. The `log` crate is already in the dependency tree.
   - A few lines Loom writes itself: startup (version, pid, Windows build, WebView2 version), window and webview create/destroy, overlay show/hide, pane spawn and exit with pid and code, and one heartbeat every 10 minutes with the pane count, pane-output bytes and IPC batches since the last heartbeat, private bytes and handle count. The heartbeat is what lets a crash be lined up with load.

   This is about 60 lines in one new module. Skipped: a logging framework and log levels per module. Add them if the file proves too noisy.

### B. Candidate fixes for the cause

1. **Take wry's fix.** Two ways:
   - Upgrade the stack to tauri 2.12.4, which brings tauri-runtime-wry 2.12.2, wry 0.57.0, tao 0.37.1 and webview2-com 0.39. That also brings tao 0.36's removal of window subclassing, which covers suspect 2, and its deadlock fixes. The cost is that this stack moves to `windows` 0.62, so Loom's own `windows = "0.61"` must move too, and the cpal / windows-core pin note in `Cargo.toml` has to be rechecked. I expect a handful of signature changes in `procs.rs`, `pipe.rs`, `control.rs` and `lib.rs`, but I haven't tried the upgrade yet. This is my recommendation.
   - If the upgrade has to wait: a `[patch.crates-io]` copy of wry 0.55.1 with PR #1795's three-line reorder (clear the refdata before dropping the controller, and go straight to `DefSubclassProc` when it's null). This fixes only suspect 1.
2. **Until then, avoid turning the overlay off and on.** That is the one webview teardown Loom does during a session, which is the wry bug's path.
3. **Two small hardening changes in Loom's code, not the cause:** bound `rows()` in `procs.rs` by the buffer length, and read `TOKEN_USER` from a `Vec<u64>` in `pipe.rs`/`control.rs`.

### C. How to tell whether it worked

Three of the four crashes came within five days (Oct 14, 16 and 19), after 15 quiet days following Sep 29. With A.1 and A.2 in place, the next crash either lands in the corrupting code (page heap) or leaves the damaged block in a full dump. If B.1 ships and two weeks pass with no crash under the same workload, that's reasonable evidence. If one comes anyway, the full dump plus the log will say what to look at next.

## How this was done, for the next time

- Dumps: `%LOCALAPPDATA%\CrashDumps\loom.exe.{164508,39300,100404,31280}.dmp`. WER reports: `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\AppCrash_loom.exe_*`.
- Symbol builds of the installed commits are in two detached worktrees, `..\loom-build-5fbdb4b` and `..\loom-build-40489b8`, a few GB each. Remove them with `git worktree remove` once this is closed. They were built with `CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=1 cargo build --bins --features tauri/custom-protocol --release` after `node scripts/setup-native.mjs`. The layout differs from the stripped exe, so functions are matched by capstone mnemonic sequence first.
- Windows symbols and older system DLLs came from `msdl.microsoft.com`, keyed by each dump's module timestamp and size, because the Oct 18 Windows update (KB5121794 and two others) replaced ntdll between the Oct 16 and Oct 19 crashes.
- Upstream references: [wry PR #1795](https://github.com/tauri-apps/wry/pull/1795) for issue #1794, the [wry changelog](https://github.com/tauri-apps/wry/blob/dev/CHANGELOG.md) entry for 0.56.1, and the [tao changelog](https://github.com/tauri-apps/tao/blob/dev/CHANGELOG.md) entries for 0.36.0 and 0.37.0.
- The heap failure record is the first exception parameter of `RtlReportFatalFailure`. Its layout comes from ntdll's PDB: `+0x08 FailureType`, `+0x18 Address`, `+0x38 PreviousBlock`, `+0x40 NextBlock`, `+0x48 ExpectedDecodedEntry`.
