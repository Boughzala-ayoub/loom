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

fn sample() -> (Times, Vec<Proc>) {
    let mut times = Times { at: Some(Instant::now()), ..Default::default() };
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_ok() {
        // Kernel time counts the idle time too.
        times.total = ticks(kernel) + ticks(user);
        times.busy = times.total.saturating_sub(ticks(idle));
    }
    let procs = list();
    times.procs = procs.iter().map(|p| ((p.pid, p.created), p.time)).collect();
    (times, procs)
}

/// Every process but the idle one (pid 0, the CPU's idle time), as Task
/// Manager lists them: one call, no process opened, so a protected one
/// (System, csrss) or another user's (svchost, Defender) has its numbers too.
/// OpenProcess refuses about two in five of them to a Loom that isn't elevated.
fn list() -> Vec<Proc> {
    // u64s, so each entry's 8-byte fields are aligned.
    let mut buf: Vec<u64> = Vec::new();
    for _ in 0..5 {
        let mut needed = 0u32;
        let status = unsafe { NtQuerySystemInformation(SystemProcessInformation, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut needed) };
        if status.is_ok() && !buf.is_empty() {
            return entries(&buf);
        }
        if status != STATUS_INFO_LENGTH_MISMATCH {
            break;
        }
        // Room for the processes that start before the next try.
        buf = vec![0; needed as usize / 8 + 8192];
    }
    Vec::new()
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
            procs.push(Proc { pid, name, created: field(24), time: field(32) + field(40), memory: field(0) });
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
}
