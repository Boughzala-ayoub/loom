// Checks Link.java's page side while the PC's connections on the hotspot stop answering, on this PC: no phone,
// no Tailscale. Loopback connections stand in for the PC's, proving themselves with a made-up secret, and a TLS
// port on localhost stands in for Tailscale. The PC keeps 6 connections waiting at the phone (link.rs's POOL), so
// the dead pools here hold 6. Needs a JDK (17+) on PATH.
// Usage: node android/link-check.mjs [revision]: that commit's Link.java instead of the working tree's.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const check = String.raw`package com.local.loom;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLServerSocketFactory;
import javax.net.ssl.TrustManagerFactory;

public class LinkCheck {
  static final String SECRET = "ab".repeat(32);
  static final List<Socket> open = new CopyOnWriteArrayList<>();
  static int failed;

  interface Job {
    void run() throws Exception;
  }

  static Thread thread(Job job) {
    Thread t = new Thread(() -> {
      try {
        job.run();
      } catch (Exception e) {
        // a stand-in hung up on: the page's answer says what matters
      }
    });
    t.setDaemon(true);
    t.start();
    return t;
  }

  /** Both ends of a loopback connection: the far one, then the link's. */
  static Socket[] pair() throws IOException {
    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      Socket far = new Socket(InetAddress.getLoopbackAddress(), server.getLocalPort());
      Socket near = server.accept();
      far.setSoTimeout(15000);
      open.add(far);
      open.add(near);
      return new Socket[] { far, near };
    }
  }

  static void echo(Socket s) throws IOException {
    s.getOutputStream().write(s.getInputStream().readNBytes(4));
    s.close();
  }

  /**
   * One of the PC's connections, proven to the link. A healthy one answers pings and, on GO, says OK and echoes, as
   * link.rs's wait() does; a delayed one does the same from 3 s on, as link.rs while one opened before it still
   * proves itself (its timeout); a stalled one never answers; a closed one has hung up. Returns the link's end.
   */
  static Socket pc(Link link, String kind) throws Exception {
    Socket[] p = pair();
    Thread proving = thread(() -> link.pc(p[1]));
    String nonce = Link.line(p[0]).substring("LINK1 ".length()), mine = "cd".repeat(16);
    Link.write(p[0], "loom " + mine + " " + Link.hmac(SECRET, "pc|loom|" + nonce + "|" + mine));
    if (!Link.line(p[0]).equals(Link.hmac(SECRET, "phone|loom|" + nonce + "|" + mine))) throw new AssertionError("the link's proof");
    proving.join();
    if (kind.equals("closed")) p[0].close();
    if (kind.equals("healthy") || kind.equals("delayed")) thread(() -> {
      if (kind.equals("delayed")) Thread.sleep(3000);
      String line;
      while ((line = Link.line(p[0])).equals("P")) Link.write(p[0], "P");
      if (!line.equals("GO")) return;
      Link.write(p[0], "OK");
      echo(p[0]);
    });
    return p[1];
  }

  /**
   * One page connection, with Tailscale marked down and the PC's connections queued in the order of kinds. late:
   * "ms kind", one that proves itself that long in ("": none). tailscale: Tailscale answers after all; otherwise
   * nothing listens there.
   */
  static void check(String name, String kinds, String late, boolean tailscale, boolean answered, long within) {
    List<String> log = new CopyOnWriteArrayList<>();
    Link.log = log::add;
    SSLServerSocket tls = null;
    Link link = null;
    String got = "", wrong = null;
    long ms = 0;
    try {
      int port;
      if (tailscale) {
        SSLServerSocket t = tls = (SSLServerSocket) SSLServerSocketFactory.getDefault().createServerSocket(0, 1, InetAddress.getLoopbackAddress());
        thread(() -> echo(t.accept()));
        port = t.getLocalPort();
      } else {
        try (ServerSocket unused = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
          port = unused.getLocalPort();
        }
      }
      Link.App app = new Link.App("loom", 0, port);
      Link l = link = new Link("localhost", new Link.Store() {
        public String get(String key) {
          return SECRET;
        }

        public void put(String key, String value) {}
      }, new Link.App[] { app }, 0, 0);
      l.tailnetDown.add("loom");
      List<Socket> dead = new ArrayList<>();
      for (String kind : kinds.split(" ")) {
        Socket s = pc(l, kind);
        if (!kind.equals("healthy")) dead.add(s);
      }
      Thread.sleep(30); // the proofs strictly before the page
      Socket[] page = pair();
      long begin = System.nanoTime();
      Thread local = thread(() -> l.local(app, page[1]));
      if (!late.isEmpty()) thread(() -> {
        Thread.sleep(Long.parseLong(late.split(" ")[0]));
        pc(l, late.split(" ")[1]);
      });
      page[0].getOutputStream().write("ping".getBytes(StandardCharsets.UTF_8));
      try {
        got = new String(page[0].getInputStream().readNBytes(4), StandardCharsets.UTF_8);
      } catch (IOException e) {
        // the link hung up on the page with "ping" unread: a reset
      }
      ms = (System.nanoTime() - begin) / 1_000_000;
      page[0].close();
      local.join(5000);
      if (local.isAlive()) wrong = "the page's side still runs";
      else if (!got.equals(answered ? "ping" : "")) wrong = answered ? "the page got no answer" : "the page got an answer";
      else if (ms >= within) wrong = "took " + ms + " ms, not under " + within;
      else if (l.tailnetDown.contains("loom") == tailscale) wrong = tailscale ? "Tailscale still marked down" : "Tailscale marked back";
      else for (Socket s : dead) if (!s.isClosed() && !l.idle.get("loom").contains(s)) wrong = "a dead connection was dropped without closing";
    } catch (Exception e) {
      wrong = e.toString();
    } finally {
      Link.close(tls);
      if (link != null) link.stop();
      for (Socket s : open) Link.close(s);
      open.clear();
    }
    System.out.printf("%-4s %-14s %s in %d ms%n", wrong == null ? "ok" : "FAIL", name, got.isEmpty() ? "no answer" : got, ms);
    if (wrong != null) {
      failed++;
      System.out.println("     " + wrong + "; the link: " + log);
    }
  }

  public static void main(String[] args) throws Exception {
    KeyStore keys = KeyStore.getInstance("PKCS12");
    try (InputStream in = new FileInputStream(args[0])) {
      keys.load(in, "changeit".toCharArray());
    }
    KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    km.init(keys, "changeit".toCharArray());
    TrustManagerFactory tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    tm.init(keys);
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(km.getKeyManagers(), tm.getTrustManagers(), null);
    SSLContext.setDefault(context); // the stand-in's certificate, for localhost: Link still checks the name
    String six = "stalled stalled stalled stalled stalled stalled";
    check("healthy", "healthy", "", false, true, 1000);
    check("closed-first", "closed healthy", "", false, true, 1000);
    check("closed-last", "healthy closed", "", false, true, 1000);
    // The PC came back on new connections while its old ones still wait here, dead.
    check("mixed", six + " healthy", "", false, true, 1000);
    check("late", "stalled", "500 healthy", false, true, 3000);
    // The newest is proven, but the PC doesn't listen on it yet: the older one still answers.
    check("newest-pending", "healthy delayed", "", false, true, 3000);
    // The PC has left: 2 s on the newest and 1 s of pings to the rest, not 2 s on each of the 6.
    check("all-stalled", six, "", false, false, 3500);
    // The PC comes back during those pings.
    check("during-pings", six, "2500 healthy", false, true, 3500);
    // A new one is proven during them, but listens only later: the old one that answered goes first.
    check("late-pending", "healthy stalled stalled", "2500 delayed", false, true, 3500);
    check("recover", six, "", true, true, 4500);
    System.exit(failed == 0 ? 0 : 1);
  }
}
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const revision = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-'));
try {
  const link = path.join(dir, 'Link.java');
  if (revision) fs.writeFileSync(link, execFileSync('git', ['show', `${revision}:android/src/com/local/loom/Link.java`], { cwd: here }));
  else fs.copyFileSync(path.join(here, 'src', 'com', 'local', 'loom', 'Link.java'), link);
  fs.writeFileSync(path.join(dir, 'LinkCheck.java'), check);
  const keys = path.join(dir, 'keys.p12');
  execFileSync('keytool', ['-genkeypair', '-alias', 'localhost', '-keystore', keys, '-storetype', 'PKCS12', '-storepass', 'changeit',
    '-keypass', 'changeit', '-keyalg', 'RSA', '-validity', '1', '-dname', 'CN=localhost', '-ext', 'SAN=dns:localhost', '-noprompt'], { stdio: 'pipe' });
  execFileSync('javac', ['--release', '17', '-d', dir, link, path.join(dir, 'LinkCheck.java')], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'com.local.loom.LinkCheck', keys], { stdio: 'inherit', timeout: 120000 });
} catch (e) {
  console.error(e.status != null ? 'link-check: failed' : e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
