package com.local.loom;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * The phone link. A page on this phone talks to http://localhost:port, which this serves from the phone itself,
 * so the page is a secure context on any network. Each of the page's connections goes on to the PC over
 * Tailscale whenever Tailscale works: TLS to the PC's tailnet name, which `tailscale serve` hands to the app's
 * port on the PC.
 *
 * <p>The other way is for when it doesn't. With the PC on this phone's own hotspot, Tailscale between them dies
 * within minutes (tailscale/tailscale#20782), so the PC also connects here, to this link's port on its
 * gateway: this phone. Both prove they hold the secret the phone read over Tailscale from GET /api/link. The
 * connection then waits until a page needs it: "GO", and the PC pipes it to its own 127.0.0.1 port. While the
 * PC is here, Tailscale is checked every 10 s, and pages go over the hotspot only while that check fails. The
 * PC only ever connects out, so nothing new listens on it.
 *
 * <p>The bytes pass untouched either way, since the PC's apps accept Host: localhost:port. This is a copy, in
 * Loom's package, of the AI Usage bubble's link in overlayv3 (phone/src/com/local/aiusage/Link.java): keep the
 * two the same. overlayv3's phone/link-check.mjs runs that one on a PC, since it uses no Android classes.
 */
public final class Link {
  public interface Store {
    String get(String key);

    void put(String key, String value);
  }

  /** An app the link carries: its name in the PC's hello, its port here and on the PC, its `tailscale serve` port (0: none). */
  public static final class App {
    final String name;
    final int port, tailnet;

    public App(String name, int port, int tailnet) {
      this.name = name;
      this.port = port;
      this.tailnet = tailnet;
    }
  }

  static final Pattern SECRET = Pattern.compile("\"secret\"\\s*:\\s*\"([0-9a-f]{64})\"");
  static Link running;
  /** What the link did, for a check or the phone's log: nothing by default. */
  static Consumer<String> log = line -> {};

  final String host; // the PC's tailnet name
  final Store store;
  final App[] apps;
  final int pcPort; // where the PC finds this link on the hotspot: each link on the phone has its own
  final int offset; // added to the pages' ports: link-check.mjs runs this on a PC whose own apps hold them
  final Map<String, LinkedBlockingDeque<Socket>> idle = new ConcurrentHashMap<>();
  final Map<String, Long> seen = new ConcurrentHashMap<>(); // app -> ms the PC last proved itself on the hotspot
  final Set<String> tailnetDown = ConcurrentHashMap.newKeySet(); // apps whose Tailscale check failed while the PC was here
  final Map<String, Set<Socket>> overTailnet = new ConcurrentHashMap<>(); // app -> its page connections on Tailscale now
  final List<ServerSocket> servers = new CopyOnWriteArrayList<>();
  final SecureRandom random = new SecureRandom();
  volatile boolean stopped;

  /** Runs one link for the process; a new tailnet name starts it over. */
  static synchronized void start(String host, Store store, App[] apps, int pcPort) {
    if (running != null && running.host.equals(host)) return;
    if (running != null) running.stop();
    running = new Link(host, store, apps, pcPort, 0);
    running.open();
  }

  /** Stops the process's link: the service holding it ended. */
  static synchronized void end() {
    if (running != null) running.stop();
    running = null;
  }

  Link(String host, Store store, App[] apps, int pcPort, int offset) {
    this.host = host;
    this.store = store;
    this.apps = apps;
    this.pcPort = pcPort;
    this.offset = offset;
    for (App a : apps) {
      idle.put(a.name, new LinkedBlockingDeque<>());
      overTailnet.put(a.name, ConcurrentHashMap.newKeySet());
    }
  }

  void open() {
    for (App a : apps) {
      // Chrome may try either loopback for localhost: a device without ::1 just gets the one.
      for (String lo : new String[] { "127.0.0.1", "::1" }) listen(a.port + offset, lo, s -> local(a, s));
    }
    listen(pcPort, null, this::pc);
    thread(this::pinger);
    thread(this::checker);
    thread(this::fetchSecret);
  }

  void stop() {
    stopped = true;
    for (ServerSocket s : servers) close(s);
    for (LinkedBlockingDeque<Socket> q : idle.values()) for (Socket s; (s = q.poll()) != null;) close(s);
  }

  /** The PC proved itself on this hotspot within the last minute (pings come every 10 s). */
  boolean onHotspot(App a) {
    return System.currentTimeMillis() - seen.getOrDefault(a.name, 0L) < 60_000;
  }

  /** Which way the app's pages go now. */
  String route(App a) {
    return onHotspot(a) && tailnetDown.contains(a.name) ? "the hotspot" : "Tailscale";
  }

  /** For the app's screen: whether the link has its secret, and how each app reaches the PC. */
  String status() {
    if (store.get("secret") == null) return "waiting for its secret, which comes from the PC over Tailscale.";
    StringBuilder b = new StringBuilder("ready.");
    for (App a : apps) if (onHotspot(a)) b.append(' ').append(a.name).append(": the PC is on this hotspot, going over ").append(route(a)).append('.');
    return b.toString();
  }

  interface Serve {
    void serve(Socket s);
  }

  void listen(int port, String address, Serve serve) {
    try {
      ServerSocket ss = new ServerSocket();
      ss.setReuseAddress(true);
      ss.bind(address == null ? new InetSocketAddress(port) : new InetSocketAddress(InetAddress.getByName(address), port));
      servers.add(ss);
      thread(() -> {
        while (!stopped) {
          try {
            Socket s = ss.accept();
            thread(() -> serve.serve(s));
          } catch (IOException e) {
            if (stopped || ss.isClosed()) return;
          }
        }
      });
    } catch (IOException e) {
      // ponytail: a taken port (another copy) or no ::1 leaves that one out; log it if a missing link ever needs explaining
    }
  }

  // ---- the PC's side: it connects over the hotspot, proves itself, and waits for a page's connection

  void pc(Socket s) {
    try {
      s.setSoTimeout(5000);
      s.setTcpNoDelay(true);
      String nonce = hex(16);
      write(s, "LINK1 " + nonce);
      String[] hello = line(s).split(" ");
      String secret = store.get("secret");
      if (hello.length != 3 || secret == null || !idle.containsKey(hello[0]) || !hello[1].matches("[0-9a-f]{32}")) throw new IOException("refused");
      String app = hello[0], theirs = hello[1];
      if (!same(hmac(secret, "pc|" + app + "|" + nonce + "|" + theirs), hello[2])) throw new IOException("refused");
      write(s, hmac(secret, "phone|" + app + "|" + nonce + "|" + theirs));
      s.setKeepAlive(true);
      seen.put(app, System.currentTimeMillis());
      idle.get(app).offer(s);
      log.accept("pc " + app + " proved, " + idle.get(app).size() + " waiting");
    } catch (IOException e) {
      log.accept("pc refused: " + e.getMessage());
      close(s);
    }
  }

  /** Every 10 s each waiting connection must answer, so a PC that left the hotspot drops out. */
  void pinger() {
    while (!stopped) {
      sleep(10_000);
      for (Map.Entry<String, LinkedBlockingDeque<Socket>> e : idle.entrySet()) {
        for (int n = e.getValue().size(); n > 0; n--) {
          Socket s = e.getValue().poll();
          if (s == null) break;
          try {
            s.setSoTimeout(3000);
            write(s, "P");
            if (!"P".equals(line(s))) throw new IOException("no answer");
            seen.put(e.getKey(), System.currentTimeMillis());
            e.getValue().offer(s);
          } catch (IOException x) {
            close(s);
          }
        }
      }
    }
  }

  /** Every 10 s, for each app whose PC is on this hotspot: does Tailscale still reach it? */
  void checker() {
    while (!stopped) {
      sleep(10_000);
      for (App a : apps) {
        if (a.tailnet == 0 || !onHotspot(a)) {
          tailnetDown.remove(a.name); // no other way to the PC: always try Tailscale
          continue;
        }
        Socket s = viaTailnet(a.tailnet, 3000);
        close(s);
        down(a, s == null);
      }
    }
  }

  /** Marks Tailscale up or down for an app. Down, its pages' Tailscale connections end, so they come back over the hotspot. */
  void down(App a, boolean isDown) {
    if (!(isDown ? tailnetDown.add(a.name) : tailnetDown.remove(a.name))) return;
    log.accept(a.name + ": Tailscale " + (isDown ? "down, over the hotspot" : "back"));
    if (isDown) for (Socket s : overTailnet.get(a.name)) close(s);
  }

  // ---- a page's side

  void local(App a, Socket page) {
    try {
      page.setTcpNoDelay(true);
      boolean hotspot = onHotspot(a), skipped = hotspot && tailnetDown.contains(a.name);
      // Tailscale first. With the PC on the hotspot too, only while its check passes, and with less patience.
      Socket pc = skipped ? null : viaTailnet(a.tailnet, hotspot ? 2500 : 6000);
      if (pc == null && !skipped && hotspot && a.tailnet != 0) down(a, true);
      boolean tailnet = pc != null;
      if (pc == null && hotspot) pc = viaHotspot(a.name);
      // Nothing on the hotspot after all: the PC has just left it, for a network where Tailscale may work again.
      if (pc == null && skipped && (pc = viaTailnet(a.tailnet, 2500)) != null) {
        tailnet = true;
        down(a, false);
      }
      log.accept(a.name + ": " + (pc == null ? "no way to the PC" : tailnet ? "over Tailscale" : "over the hotspot"));
      if (pc == null) {
        close(page);
        return;
      }
      if (!tailnet) {
        pipe(page, pc);
        return;
      }
      Set<Socket> live = overTailnet.get(a.name);
      live.add(pc);
      try {
        pipe(page, pc);
      } finally {
        live.remove(pc);
      }
    } catch (IOException e) {
      close(page);
    }
  }

  /** A waiting connection from the PC on this hotspot, or null. */
  Socket viaHotspot(String app) {
    LinkedBlockingDeque<Socket> q = idle.get(app);
    // The PC opens a new connection for each one used: a burst of the page's waits a moment for those.
    long until = System.currentTimeMillis() + 2000;
    while (true) {
      Socket s;
      try {
        s = q.poll(Math.max(0, until - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
      } catch (InterruptedException e) {
        return null;
      }
      if (s == null) return null;
      try {
        s.setSoTimeout(2000);
        write(s, "GO");
        if ("OK".equals(line(s))) {
          s.setSoTimeout(0);
          return s;
        }
      } catch (SocketTimeoutException e) {
        close(s);
        return null; // no answer in 2 s: the PC has left the hotspot, and the rest would keep the page as long each
      } catch (IOException e) {
        // gone since its last ping: the next one
      }
      close(s);
    }
  }

  /** TLS to the PC's tailnet name, as `tailscale serve` expects, or null. */
  Socket viaTailnet(int port, int patience) {
    if (port == 0 || host.isEmpty()) return null;
    Socket raw = new Socket();
    try {
      raw.connect(new InetSocketAddress(host, port), patience);
      SSLSocket s = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
      SSLParameters p = s.getSSLParameters();
      p.setEndpointIdentificationAlgorithm("HTTPS"); // SSLSocket checks the name only when asked
      s.setSSLParameters(p);
      s.setSoTimeout(patience);
      s.startHandshake();
      s.setSoTimeout(0);
      s.setTcpNoDelay(true);
      return s;
    } catch (IOException e) {
      close(raw);
      return null;
    }
  }

  /** Both ways until both ends are done; an end's EOF reaches the other as a half-close. */
  void pipe(Socket a, Socket b) {
    AtomicInteger left = new AtomicInteger(2);
    thread(() -> copy(a, b, left));
    copy(b, a, left);
  }

  void copy(Socket from, Socket to, AtomicInteger left) {
    byte[] buf = new byte[16 << 10];
    try {
      InputStream in = from.getInputStream();
      OutputStream out = to.getOutputStream();
      for (int n; (n = in.read(buf)) > 0;) {
        out.write(buf, 0, n);
        out.flush();
      }
      to.shutdownOutput();
    } catch (IOException | UnsupportedOperationException e) { // TLS has no half-close: the page hung up, so end it
      close(from);
      close(to);
    }
    if (left.decrementAndGet() == 0) {
      close(from);
      close(to);
    }
  }

  // ---- the secret, from the PC over Tailscale, from whichever of its apps answers

  void fetchSecret() {
    while (!stopped) {
      String got = null;
      for (App a : apps) {
        if (got == null && a.tailnet != 0 && !host.isEmpty()) got = secretFrom("https://" + host + (a.tailnet == 443 ? "" : ":" + a.tailnet) + "/api/link");
      }
      if (got != null) store.put("secret", got);
      sleep(got != null ? 600_000 : 30_000);
    }
  }

  String secretFrom(String url) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(8000);
      c.setReadTimeout(8000);
      try (InputStream in = c.getInputStream()) {
        Matcher m = SECRET.matcher(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        return c.getResponseCode() == 200 && m.find() ? m.group(1) : null;
      } finally {
        c.disconnect();
      }
    } catch (IOException e) {
      return null;
    }
  }

  // ---- small things

  static String hmac(String secret, String message) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return hex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Compares in time that doesn't depend on where they first differ. */
  static boolean same(String a, String b) {
    if (a.length() != b.length()) return false;
    int diff = 0;
    for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
    return diff == 0;
  }

  String hex(int n) {
    byte[] b = new byte[n];
    random.nextBytes(b);
    return hex(b);
  }

  static String hex(byte[] bytes) {
    StringBuilder s = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
    return s.toString();
  }

  static void write(Socket s, String line) throws IOException {
    OutputStream out = s.getOutputStream();
    out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
    out.flush();
  }

  /** One line, read a byte at a time so nothing past it is taken from the stream the pipe gets next. */
  static String line(Socket s) throws IOException {
    InputStream in = s.getInputStream();
    StringBuilder b = new StringBuilder();
    for (int c; (c = in.read()) != '\n';) {
      if (c < 0 || b.length() > 300) throw new IOException("no line");
      b.append((char) c);
    }
    return b.toString();
  }

  static void close(java.io.Closeable c) {
    try {
      if (c != null) c.close();
    } catch (IOException e) {
      // closing what's already gone
    }
  }

  static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  static void thread(Runnable r) {
    Thread t = new Thread(r, "link");
    t.setDaemon(true);
    t.start();
  }
}
