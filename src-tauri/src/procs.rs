//! The phone's task manager (src/remote/tasks.ts): the PC's CPU, memory and
//! processes, which Loom reads from Windows itself, so Task Manager needn't be
//! open. Read-only: nothing here can end a process.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
use windows::Win32::Foundation::{FILETIME, STATUS_INFO_LENGTH_MISMATCH};
use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;
use windows::Win32::System::WindowsProgramming::SYSTEM_PROCESS_INFORMATION;

/// CPU time used so far, in 100 ns ticks: the whole PC's, busy and in all
/// (summed over its logical cores), and each process's by pid and creation
/// time, so a pid Windows hands out again doesn't take a dead process's time.
#[derive(Default)]
struct Times {
    at: Option<Instant>,
    busy: u64,
    total: u64,
    procs: HashMap<(u32, u64), u64>,
}

struct Proc {
    pid: u32,
    /// The process that started it, which may have ended since.
    parent: u32,
    name: String,
    created: u64,
    time: u64,
    /// The private working set: Task Manager's Memory column.
    memory: u64,
}

// ponytail: one last reading for the whole app: two phones polling at once each get the share since the other's.
static LAST: Mutex<Option<Times>> = Mutex::new(None);
/// Older than this, the last reading says nothing about now: read twice instead.
const STALE: Duration = Duration::from_secs(10);

/// The PC now, with each CPU share since the last call.
pub fn read() -> Value {
    let mut last = LAST.lock().unwrap();
    // The first reading in a while: a second one shortly after, so the phone's first answer has numbers.
    if last.as_ref().and_then(|t| t.at).is_none_or(|at| at.elapsed() > STALE) {
        *last = Some(sample().0);
        std::thread::sleep(Duration::from_millis(400));
    }
    let (now, procs) = sample();
    let was = last.replace(now).unwrap_or_default();
    let now = last.as_ref().unwrap();
    let total = now.total.saturating_sub(was.total);
    // A process new since the last reading used all its time in between.
    let procs: Vec<Value> = procs.iter().map(|p| {
        let cpu = share(p.time.saturating_sub(*was.procs.get(&(p.pid, p.created)).unwrap_or(&0)), total);
        json!({ "pid": p.pid, "name": p.name, "cpu": cpu, "memory": p.memory })
    }).collect();
    let mut mem = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    let _ = unsafe { GlobalMemoryStatusEx(&mut mem) };
    json!({
        "cpu": share(now.busy.saturating_sub(was.busy), total),
        "memory": { "used": mem.ullTotalPhys - mem.ullAvailPhys, "total": mem.ullTotalPhys, "commit": mem.ullTotalPageFile - mem.ullAvailPageFile, "limit": mem.ullTotalPageFile },
        "uptime": unsafe { GetTickCount64() } / 1000,
        "procs": procs,
    })
}

/// The PC's Preferences → Task manager: the reading the phone gets from /api/procs.
#[tauri::command]
pub async fn procs() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())
}

/// `part` of `total` CPU time, in percent. `total` is the PC's own time summed
/// over its cores, elapsed time × logical cores, so a process's share is its
/// time ÷ elapsed ÷ cores, as Task Manager counts it: 100% is every core busy.
/// To a tenth, as Task Manager shows it.
fn share(part: u64, total: u64) -> f64 {
    if total == 0 { 0.0 } else { ((part as f64 * 1000.0 / total as f64).round() / 10.0).min(100.0) }
}

fn ticks(t: FILETIME) -> u64 {
    (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64
}

/// The whole PC's CPU time so far: (busy, total), 0s when Windows wouldn't say.
fn cpu_times() -> (u64, u64) {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
        return (0, 0);
    }
    // Kernel time counts the idle time too.
    let total = ticks(kernel) + ticks(user);
    (total.saturating_sub(ticks(idle)), total)
}

/// The bar's own last CPU times and when, so it and a phone's task manager don't take each other's share.
static BAR: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

/// The status bar's CPU and memory (main.ts paintStatus): the PC's CPU share
/// since the bar's last reading, and memory in use of all.
pub fn bar() -> Value {
    let mut last = BAR.lock().unwrap();
    // The first reading in a while (Loom was hidden): a second shortly after, so it says how busy the PC is now.
    if last.is_none_or(|(at, ..)| at.elapsed() > STALE) {
        let (busy, total) = cpu_times();
        *last = Some((Instant::now(), busy, total));
        std::thread::sleep(Duration::from_millis(250));
    }
    let (busy, total) = cpu_times();
    let (_, was_busy, was_total) = last.replace((Instant::now(), busy, total)).unwrap();
    let mut mem = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    let _ = unsafe { GlobalMemoryStatusEx(&mut mem) };
    json!({
        "cpu": share(busy.saturating_sub(was_busy), total.saturating_sub(was_total)),
        "memory": { "used": mem.ullTotalPhys - mem.ullAvailPhys, "total": mem.ullTotalPhys },
    })
}

/// Each TCP port listened on, IPv4 and IPv6, with the pid listening: twice
/// for a server on both (vite on 127.0.0.1 and ::1).
pub(crate) fn listening() -> Vec<(u32, u16)> {
    use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER};
    // AF_INET and AF_INET6.
    let table = |family: u32| -> Vec<u32> {
        // u32s: the count, then rows of u32s and bytes.
        let mut buf: Vec<u32> = Vec::new();
        for _ in 0..3 {
            let mut size = (buf.len() * 4) as u32;
            let ptr = if buf.is_empty() { None } else { Some(buf.as_mut_ptr().cast()) };
            match unsafe { GetExtendedTcpTable(ptr, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) } {
                0 => return buf,
                // ERROR_INSUFFICIENT_BUFFER: room for the sockets opened before the next try.
                122 => buf = vec![0; size as usize / 4 + 64],
                _ => break,
            }
        }
        Vec::new()
    };
    // SAFETY: Windows wrote the count, then that many rows of the family's type, from the second u32.
    fn rows<T>(buf: &[u32]) -> &[T] {
        if buf.is_empty() { return &[] }
        unsafe { std::slice::from_raw_parts(buf.as_ptr().add(1).cast::<T>(), buf[0] as usize) }
    }
    // The port is in network byte order, in the low 16 bits.
    let port = |p: u32| u16::from_be(p as u16);
    let v4 = table(2);
    let v6 = table(23);
    rows::<MIB_TCPROW_OWNER_PID>(&v4).iter().map(|r| (r.dwOwningPid, port(r.dwLocalPort)))
        .chain(rows::<MIB_TCP6ROW_OWNER_PID>(&v6).iter().map(|r| (r.dwOwningPid, port(r.dwLocalPort))))
        .collect()
}

fn sample() -> (Times, Vec<Proc>) {
    let mut times = Times { at: Some(Instant::now()), ..Default::default() };
    (times.busy, times.total) = cpu_times();
    let procs = list();
    times.procs = procs.iter().map(|p| ((p.pid, p.created), p.time)).collect();
    (times, procs)
}

/// Every process but the idle one (pid 0, the CPU's idle time), as Task
/// Manager lists them: one call, no process opened, so a protected one
/// (System, csrss) or another user's (svchost, Defender) has its numbers too.
/// OpenProcess refuses about two in five of them to a Loom that isn't elevated.
fn list() -> Vec<Proc> {
    read_list().unwrap_or_default()
}

/// list, or None when Windows wouldn't give it.
fn read_list() -> Option<Vec<Proc>> {
    // u64s, so each entry's 8-byte fields are aligned.
    let mut buf: Vec<u64> = Vec::new();
    for _ in 0..5 {
        let mut needed = 0u32;
        let status = unsafe { NtQuerySystemInformation(SystemProcessInformation, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut needed) };
        if status.is_ok() && !buf.is_empty() {
            return Some(entries(&buf));
        }
        if status != STATUS_INFO_LENGTH_MISMATCH {
            break;
        }
        // Room for the processes that start before the next try.
        buf = vec![0; needed as usize / 8 + 8192];
    }
    None
}

/// Each git.exe still running but `ours` and what it started, created before
/// `before` (100 ns ticks since 1601): its pid and its current folder, None when
/// Loom can't read it. One that has ended since the list was read isn't. None
/// when Windows wouldn't list the processes.
pub(crate) fn gits(ours: u32, before: u64) -> Option<Vec<(u32, Option<std::path::PathBuf>)>> {
    let all = read_list()?;
    let tree: HashMap<u32, (u32, u64)> = all.iter().map(|p| (p.pid, (p.parent, p.created))).collect();
    let started_by_ours = |mut pid: u32| {
        for _ in 0..64 {
            if pid == ours { return true; }
            match tree.get(&pid) {
                Some(&(parent, created)) if tree.get(&parent).is_some_and(|&(_, older)| older < created) => pid = parent,
                _ => return false,
            }
        }
        false
    };
    Some(all.iter().filter(|p| p.name.eq_ignore_ascii_case("git.exe") && p.created < before && !started_by_ours(p.pid))
        .filter_map(|p| current_dir(p.pid).map(|dir| (p.pid, dir))).collect())
}

/// Process `pid`'s current folder, from its process parameters (x64 layout):
/// the PEB's ProcessParameters at 0x20, and their CurrentDirectory, a
/// UNICODE_STRING, at 0x38. Some(None) when Loom may not read it, None when the
/// process has ended (gone, or only its handles left).
fn current_dir(pid: u32) -> Option<Option<std::path::PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};
    unsafe {
        let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid) {
            Ok(process) => process,
            Err(e) if e.code() == ERROR_INVALID_PARAMETER.to_hresult() => return None,
            Err(_) => return Some(None),
        };
        let mut code = 0u32;
        if GetExitCodeProcess(process, &mut code).is_ok() && code != 259 { // STILL_ACTIVE
            let _ = CloseHandle(process);
            return None;
        }
        let read = |at: usize, buf: &mut [u8]| ReadProcessMemory(process, at as *const _, buf.as_mut_ptr().cast(), buf.len(), None).ok();
        let dir = (|| {
            // PROCESS_BASIC_INFORMATION, whose second field is the PEB's address.
            let (mut basic, mut got) = ([0usize; 6], 0u32);
            NtQueryInformationProcess(process, ProcessBasicInformation, basic.as_mut_ptr().cast(), std::mem::size_of_val(&basic) as u32, &mut got).ok().ok()?;
            let mut word = [0u8; 8];
            read(basic[1] + 0x20, &mut word)?;
            let mut path = [0u8; 16];
            read(usize::from_le_bytes(word) + 0x38, &mut path)?;
            let mut units = vec![0u8; u16::from_le_bytes([path[0], path[1]]) as usize];
            read(usize::from_le_bytes(path[8..16].try_into().ok()?), &mut units)?;
            let wide: Vec<u16> = units.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(&wide)))
        })();
        let _ = CloseHandle(process);
        Some(dir)
    }
}

/// Whether this process, a hook, belongs to an agent the Loom `app` started
/// itself in a pane: the nearest of its ancestors named `image` (grok.exe) is
/// `app`'s child. A grok another agent started there (Claude asking it for a
/// second opinion), or one Grok started, has another parent. None when
/// Windows wouldn't list the processes.
/// ponytail: by image name, so a pane whose grok runs through a shim (grok.cmd) reports nothing.
pub(crate) fn agent_of(app: u32, image: &str) -> Option<bool> {
    let all = read_list()?;
    Some(started_by(&all.iter().map(|p| (p.pid, (p.parent, p.created, p.name.as_str()))).collect(), std::process::id(), app, image))
}

/// The walk `agent_of` takes over `tree` (pid: parent, creation time, image), up from `me`.
fn started_by(tree: &HashMap<u32, (u32, u64, &str)>, me: u32, app: u32, image: &str) -> bool {
    let mut pid = me;
    for _ in 0..64 {
        let Some(&(parent, created, _)) = tree.get(&pid) else { return false };
        // A parent pid that isn't older than its child went to another process after the parent ended.
        let Some(&(grand, parent_created, name)) = tree.get(&parent).filter(|p| p.1 < created) else { return false };
        if name.eq_ignore_ascii_case(image) {
            return grand == app && tree.get(&app).is_some_and(|a| a.1 < parent_created);
        }
        pid = parent;
    }
    false
}

/// Each process's parent and creation time, by pid. A parent pid that isn't
/// older than its child went to another process after the parent ended.
pub(crate) fn parents() -> HashMap<u32, (u32, u64)> {
    list().into_iter().map(|p| (p.pid, (p.parent, p.created))).collect()
}

fn entries(buf: &[u64]) -> Vec<Proc> {
    let mut procs = Vec::new();
    let mut at = 0;
    loop {
        // SAFETY: Windows wrote whole entries into `buf`, each at its predecessor's NextEntryOffset.
        let p = unsafe { &*buf.as_ptr().cast::<u8>().add(at).cast::<SYSTEM_PROCESS_INFORMATION>() };
        // Reserved1 holds, by offset: the private working set (0), creation time (24), user (32) and kernel time (40).
        let field = |i: usize| u64::from_le_bytes(p.Reserved1[i..i + 8].try_into().unwrap());
        let pid = p.UniqueProcessId.0 as usize as u32;
        if pid != 0 {
            let name = &p.ImageName;
            // SAFETY: the name points into `buf`, Length bytes long.
            let name = if name.Buffer.is_null() { String::new() } else { String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(name.Buffer.0, name.Length as usize / 2) }) };
            // Reserved2 is InheritedFromUniqueProcessId.
            procs.push(Proc { pid, parent: p.Reserved2 as usize as u32, name, created: field(24), time: field(32) + field(40), memory: field(0) });
        }
        if p.NextEntryOffset == 0 {
            return procs;
        }
        at += p.NextEntryOffset as usize;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cpu_share_is_time_used_over_every_cores_time() {
        // Two readings 2 s apart on 8 cores: 160 M ticks of PC time between them.
        let total = 8 * 2 * 10_000_000;
        assert_eq!(share(total / 8, total), 12.5, "one core busy for the whole interval");
        assert_eq!(share(0, total), 0.0);
        assert_eq!(share(total / 3, total), 33.3, "to a tenth");
        assert_eq!(share(total + 1, total), 100.0, "a late process reading never passes 100%");
        assert_eq!(share(5, 0), 0.0, "no time passed");
    }

    #[test]
    fn a_hook_is_the_panes_only_under_the_grok_its_loom_started() {
        // pid: parent, creation time, image. Loom is 10, Claude's pane 20, the hooks run through PowerShell.
        let tree: HashMap<u32, (u32, u64, &str)> = HashMap::from([
            (10, (1, 100, "loom.exe")),
            (11, (10, 110, "grok.exe")), (12, (11, 120, "powershell.exe")), (13, (12, 130, "loom.exe")),
            (20, (10, 200, "claude.exe")), (21, (20, 210, "bash.exe")), (22, (21, 220, "grok.exe")), (23, (22, 230, "powershell.exe")), (24, (23, 240, "loom.exe")),
            (30, (11, 300, "pwsh.exe")), (31, (30, 310, "grok.exe")), (32, (31, 320, "powershell.exe")), (33, (32, 330, "loom.exe")),
            (40, (39, 400, "loom.exe")),
            (50, (70, 500, "GROK.EXE")), (51, (50, 510, "loom.exe")), (70, (1, 700, "loom.exe")),
        ]);
        assert!(started_by(&tree, 13, 10, "grok.exe"), "the pane's own grok");
        assert!(!started_by(&tree, 24, 10, "grok.exe"), "a grok Claude started in its pane");
        assert!(!started_by(&tree, 33, 10, "grok.exe"), "a grok the pane's grok started");
        assert!(!started_by(&tree, 40, 10, "grok.exe"), "no grok above it");
        assert!(!started_by(&tree, 13, 20, "grok.exe"), "another Loom's grok");
        assert!(!started_by(&tree, 51, 70, "grok.exe"), "a grok whose parent's pid a newer Loom has now");
        assert!(started_by(&tree, 13, 10, "GROK.EXE"), "an image name matches in any case");
        assert!(!started_by(&tree, 99, 10, "grok.exe"), "a process Windows didn't list");
    }

    #[test]
    fn every_process_is_read_with_its_cpu_and_memory() {
        let v = read();
        let procs = v["procs"].as_array().unwrap();
        let me = procs.iter().find(|p| p["pid"] == std::process::id()).expect("this test's own process");
        assert!(me["memory"].as_u64().unwrap() > 0 && me["name"].as_str().unwrap().ends_with(".exe"), "{me}");
        let system = procs.iter().find(|p| p["pid"] == 4).expect("System, which no Loom may open");
        assert_eq!(system["name"], "System");
        assert!(system["cpu"].is_f64());
        assert!(!procs.iter().any(|p| p["pid"] == 0), "the idle process is no process");
        assert!(v["memory"]["used"].as_u64().unwrap() < v["memory"]["total"].as_u64().unwrap());
        assert!(v["uptime"].as_u64().unwrap() > 0);
    }

    #[test]
    fn a_port_listened_on_is_read_with_its_pid() {
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let v6 = std::net::TcpListener::bind("[::1]:0").unwrap();
        let all = listening();
        for l in [v4, v6] {
            let port = l.local_addr().unwrap().port();
            assert!(all.contains(&(std::process::id(), port)), "port {port} in {all:?}");
        }
    }

    #[test]
    fn the_bar_reads_cpu_and_memory_from_its_first_call() {
        let v = bar();
        assert!(v["cpu"].is_f64(), "{v}");
        assert!(v["memory"]["used"].as_u64().unwrap() < v["memory"]["total"].as_u64().unwrap(), "{v}");
    }
}
