//! The PC's half of the phone link. The phone's half is Loom's phone app (android/; its Link.java describes
//! the protocol), and overlayv3's link.js is this in Node, for the AI Usage bubble. On the phone's own hotspot
//! Tailscale can't reach the phone (tailscale/tailscale#20782), so the phone app listens on its hotspot
//! address, port 7498, and Loom, finding it as this PC's gateway, connects out to it. Both prove they know the
//! secret the phone read from /api/link over Tailscale. Each connection then waits for the phone's "GO" and
//! pipes one of the phone page's connections to remote.rs's port. The phone takes these only while Tailscale
//! fails. Only outgoing connections: nothing new listens here, so no firewall asks, and a café's network sees
//! nothing new.
use sha2::{Digest, Sha256};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Loom's phone app's link on the phone; the AI Usage bubble's is 7499.
const PORT: u16 = 7498;
/// Connections kept waiting at the phone: a page opens a few at once.
const POOL: usize = 6;

/// One secret for every app on this PC that speaks the link (the overlay too), so the phone needs only one.
fn secret_file() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("phone-link").join("secret")
}

pub fn secret() -> String {
    let file = secret_file();
    if let Some(s) = std::fs::read_to_string(&file).ok().map(|s| s.trim().to_string()).filter(|s| s.len() == 64) {
        return s;
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("Windows has no random numbers");
    let s = hex(&bytes);
    let _ = std::fs::create_dir_all(file.parent().unwrap_or(&file));
    // The overlay may be making it at the same moment: the first one wins.
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
        Ok(mut f) => {
            use std::io::Write;
            let _ = f.write_all(s.as_bytes());
            s
        }
        Err(_) => std::fs::read_to_string(&file).map(|t| t.trim().to_string()).unwrap_or(s),
    }
}

/// Keeps POOL connections waiting at the phone whenever this PC's gateway is the phone's link. `name` is
/// what the phone knows this app by; `port` is where its connections go on this PC.
pub async fn run(name: &'static str, port: u16) {
    let waiting = Arc::new(AtomicUsize::new(0));
    // Dropped when this is: the remote turned off, so the connections waiting at the phone end too.
    let alive = Arc::new(());
    let (mut key, mut gw, mut gw_at, mut retry_at) = (None::<String>, None::<Ipv4Addr>, Instant::now(), Instant::now());
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let n = POOL.saturating_sub(waiting.load(Ordering::Acquire));
        if n == 0 || Instant::now() < retry_at {
            continue;
        }
        let k = key.get_or_insert_with(secret).clone();
        // While connections keep working, `route print` is asked every 10 s at most.
        if gw.is_none() || gw_at.elapsed() > Duration::from_secs(10) {
            gw = gateway().await;
            gw_at = Instant::now();
        }
        let Some(g) = gw else {
            retry_at = Instant::now() + Duration::from_secs(5);
            continue;
        };
        // Every missing one at once: a page that just used several wants them back before it asks again.
        waiting.fetch_add(n, Ordering::AcqRel);
        let tries: Vec<_> = (0..n).map(|_| {
            let k = k.clone();
            tauri::async_runtime::spawn(async move { prove((g, PORT).into(), name, &k).await })
        }).collect();
        let mut failed = 0;
        for t in tries {
            match t.await.ok().flatten() {
                Some(s) => drop(tauri::async_runtime::spawn(wait(s, port, waiting.clone(), Arc::downgrade(&alive)))),
                None => {
                    failed += 1;
                    waiting.fetch_sub(1, Ordering::AcqRel);
                }
            }
        }
        if failed == n {
            // ponytail: one back-off for a gateway that isn't the phone and for a phone that's away; every 5 s
            // costs a `route print` and a refused connection to the router at home
            retry_at = Instant::now() + Duration::from_secs(5);
            (key, gw) = (None, None); // both read again: the overlay may have just made the file, the network may have changed
        }
    }
}

/// One connection to the phone at `addr`, proven both ways, or None if it isn't the phone's link.
async fn prove(addr: SocketAddr, name: &str, key: &str) -> Option<TcpStream> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut s = TcpStream::connect(addr).await.ok()?;
        let _ = s.set_nodelay(true);
        let hello = line(&mut s).await.ok()?;
        let theirs = hello.strip_prefix("LINK1 ").filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))?.to_string();
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).ok()?;
        let mine = hex(&nonce);
        let proof = hmac(key.as_bytes(), &format!("pc|{name}|{theirs}|{mine}"));
        s.write_all(format!("{name} {mine} {proof}\n").as_bytes()).await.ok()?;
        (line(&mut s).await.ok()? == hmac(key.as_bytes(), &format!("phone|{name}|{theirs}|{mine}"))).then_some(s)
    }).await.ok().flatten()
}

/// Waits at the phone, answering its pings (every 10 s), until it says GO; then pipes to `port`. `waiting`
/// counts down as soon as it stops waiting, so `run` opens another. It ends at the next line once `run` has.
async fn wait(mut s: TcpStream, port: u16, waiting: Arc<AtomicUsize>, alive: Weak<()>) {
    let go = loop {
        let next = tokio::time::timeout(Duration::from_secs(30), line(&mut s)).await;
        if alive.strong_count() == 0 {
            break false;
        }
        match next {
            Ok(Ok(l)) if l == "P" => {
                if s.write_all(b"P\n").await.is_err() {
                    break false;
                }
            }
            Ok(Ok(l)) => break l == "GO",
            _ => break false,
        }
    };
    waiting.fetch_sub(1, Ordering::AcqRel);
    if !go {
        return;
    }
    let Ok(mut local) = TcpStream::connect(("127.0.0.1", port)).await else { return };
    if s.write_all(b"OK\n").await.is_ok() {
        let _ = tokio::io::copy_bidirectional(&mut s, &mut local).await;
    }
}

/// One line, read a byte at a time so nothing past it is taken from the stream the pipe gets next.
async fn line(s: &mut TcpStream) -> std::io::Result<String> {
    let mut out = Vec::new();
    loop {
        match s.read_u8().await? {
            b'\n' => return Ok(String::from_utf8_lossy(&out).into_owned()),
            _ if out.len() > 300 => return Err(std::io::Error::other("no line")),
            b => out.push(b),
        }
    }
}

/// This PC's default gateway, if it's a private address: the phone, on its hotspot.
async fn gateway() -> Option<Ipv4Addr> {
    if let Ok(g) = std::env::var("LINK_GATEWAY") {
        return g.parse().ok(); // a check's stand-in phone on this PC
    }
    tauri::async_runtime::spawn_blocking(|| {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("route").args(["print", "-4", "0.0.0.0"]).creation_flags(0x0800_0000).output().ok()?; // CREATE_NO_WINDOW
        gateways(&String::from_utf8_lossy(&out.stdout)).into_iter().next()
    }).await.ok().flatten()
}

/// `route print`'s default routes through private gateways, best metric first.
fn gateways(text: &str) -> Vec<Ipv4Addr> {
    let mut routes: Vec<(u32, Ipv4Addr)> = text.lines().filter_map(|l| match l.split_whitespace().collect::<Vec<_>>()[..] {
        ["0.0.0.0", "0.0.0.0", gw, _, metric] => {
            let gw: Ipv4Addr = gw.parse().ok()?;
            gw.is_private().then_some((metric.parse().ok()?, gw))
        }
        _ => None,
    }).collect();
    routes.sort();
    routes.into_iter().map(|(_, gw)| gw).collect()
}

/// HMAC-SHA-256 (RFC 2104), in hex: Java's Mac and Node's createHmac on the phone's and the overlay's side.
fn hmac(key: &[u8], message: &str) -> String {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner = Sha256::new().chain_update(block.map(|b| b ^ 0x36)).chain_update(message.as_bytes()).finalize();
    hex(&Sha256::new().chain_update(block.map(|b| b ^ 0x5c)).chain_update(inner).finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};

    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(hmac(b"Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // A key longer than a block is hashed first (case 6).
        assert_eq!(hmac(&[0xaa; 131], "Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn takes_private_gateways_best_first() {
        let out = "Itinéraires actifs :\n  0.0.0.0          0.0.0.0     192.168.1.1     192.168.1.15     35\n  0.0.0.0          0.0.0.0     100.100.1.1     100.94.6.17       5\n  0.0.0.0          0.0.0.0  10.149.184.129  10.149.184.102     25\n";
        assert_eq!(gateways(out), ["10.149.184.129".parse::<Ipv4Addr>().unwrap(), "192.168.1.1".parse().unwrap()]);
        assert!(gateways("Aucun").is_empty());
    }

    /// A stand-in phone: says hello, checks the PC's proof, proves itself with `its_key`, pings, then sends GO
    /// and five bytes, and returns what came back through Loom's stand-in.
    fn phone(its_key: String) -> (SocketAddr, std::thread::JoinHandle<Option<[u8; 5]>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        (addr, std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let nonce = "0123456789abcdef".repeat(2);
            s.write_all(format!("LINK1 {nonce}\n").as_bytes()).unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut hello = String::new();
            r.read_line(&mut hello).unwrap();
            let f: Vec<&str> = hello.trim_end().split(' ').collect();
            assert_eq!(f[0], "loom-test");
            if f[2] != hmac(its_key.as_bytes(), &format!("pc|loom-test|{nonce}|{}", f[1])) {
                return None; // a phone with another secret hangs up
            }
            s.write_all(format!("{}\n", hmac(its_key.as_bytes(), &format!("phone|loom-test|{nonce}|{}", f[1]))).as_bytes()).unwrap();
            let mut l = String::new();
            s.write_all(b"P\n").unwrap();
            r.read_line(&mut l).unwrap();
            assert_eq!(l, "P\n", "a ping is answered");
            s.write_all(b"GO\n").unwrap();
            l.clear();
            r.read_line(&mut l).unwrap();
            assert_eq!(l, "OK\n");
            s.write_all(b"hello").unwrap();
            let mut back = [0u8; 5];
            r.read_exact(&mut back).unwrap();
            Some(back)
        }))
    }

    #[test]
    fn proves_itself_then_pipes_a_connection() {
        let key = "ab".repeat(32);
        // Loom's port, standing in: it answers what it reads, reversed.
        let app = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let app_port = app.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = app.accept().unwrap();
            let mut b = [0u8; 5];
            c.read_exact(&mut b).unwrap();
            b.reverse();
            c.write_all(&b).unwrap();
        });
        let (addr, phone) = phone(key.clone());
        let (waiting, alive) = (Arc::new(AtomicUsize::new(1)), Arc::new(()));
        tauri::async_runtime::block_on(async {
            let s = prove(addr, "loom-test", &key).await.expect("proved both ways");
            wait(s, app_port, waiting.clone(), Arc::downgrade(&alive)).await;
        });
        assert_eq!(&phone.join().unwrap().unwrap(), b"olleh");
        assert_eq!(waiting.load(Ordering::Acquire), 0, "once used it no longer counts as waiting");
    }

    #[test]
    fn a_phone_with_another_secret_is_refused() {
        let (addr, phone) = phone("cd".repeat(32));
        assert!(tauri::async_runtime::block_on(prove(addr, "loom-test", &"ab".repeat(32))).is_none());
        assert!(phone.join().unwrap().is_none());
    }
}
