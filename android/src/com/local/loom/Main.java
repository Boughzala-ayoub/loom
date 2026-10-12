package com.local.loom;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;

/**
 * The launcher icon: starts the link and opens Loom's page in the browser, at http://localhost:7420. The link
 * listens before the browser asks, so the page never meets a closed port.
 */
public class Main extends Activity {
  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    Keep.link(this);
    startForegroundService(new Intent(this, Keep.class));
    // The link's notification says which way Loom goes. Android asks once; either answer opens Loom.
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        && !getSharedPreferences("link", MODE_PRIVATE).getBoolean("asked", false)) {
      getSharedPreferences("link", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
      return;
    }
    open();
  }

  @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
    open();
  }

  void open() {
    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Keep.URL)));
    finish();
  }
}
