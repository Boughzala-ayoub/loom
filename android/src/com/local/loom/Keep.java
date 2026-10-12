package com.local.loom;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Keeps the phone link (Link.java) running while Loom's page may need it: a foreground service, so Android
 * leaves it be. Its notification says which way Loom goes, and a tap on it opens Loom.
 */
public class Keep extends Service {
  /** Loom's phone page, as the link serves it on this phone. */
  static final String URL = "http://localhost:7420/";
  /** Loom, and a debug build of it (no `tailscale serve` port), as the link carries them. */
  static final Link.App[] APPS = { new Link.App("loom", 7420, 443), new Link.App("loom-dev", 7421, 0) };
  /** Where the PC finds this link on the hotspot; the AI Usage bubble's has 7499. */
  static final int PC_PORT = 7498;

  final Handler ui = new Handler(Looper.getMainLooper());
  String shown = "";
  final Runnable refresh = new Runnable() {
    @Override public void run() {
      String text = text();
      if (!text.equals(shown)) {
        shown = text;
        getSystemService(NotificationManager.class).notify(1, note(text));
      }
      ui.postDelayed(this, 10_000);
    }
  };

  /** Starts the link for the PC baked in by build.mjs; its secret is kept with the app's settings. */
  static void link(Context c) {
    String host = "";
    try (InputStream in = c.getAssets().open("server.txt")) {
      host = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
    } catch (IOException e) {
      // a build without it reaches the PC over the hotspot only
    }
    SharedPreferences store = c.getSharedPreferences("link", MODE_PRIVATE);
    Link.start(host, new Link.Store() {
      @Override public String get(String key) { return store.getString(key, null); }

      @Override public void put(String key, String value) { store.edit().putString(key, value).apply(); }
    }, APPS, PC_PORT);
  }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int id) {
    if (intent != null && "stop".equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    link(this);
    getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("link", "Loom link", NotificationManager.IMPORTANCE_MIN));
    shown = text();
    startForeground(1, note(shown), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    ui.removeCallbacks(refresh);
    ui.postDelayed(refresh, 10_000);
    return START_STICKY;
  }

  /** Which way Loom's page reaches the PC now. */
  static String text() {
    Link l = Link.running;
    if (l == null) return "";
    if (l.store.get("secret") == null) return "Waiting for its key, which comes from the PC over Tailscale.";
    return l.onHotspot(APPS[0]) ? "Your PC is on this hotspot. Going over " + l.route(APPS[0]) + "." : "Going over Tailscale.";
  }

  Notification note(String text) {
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(Intent.ACTION_VIEW, Uri.parse(URL)), PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, Keep.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, "link")
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setContentTitle("Loom link")
        .setContentText(text)
        .setContentIntent(open)
        .setOngoing(true)
        .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
        .build();
  }

  @Override public void onDestroy() {
    ui.removeCallbacks(refresh);
    Link.end();
    super.onDestroy();
  }
}
