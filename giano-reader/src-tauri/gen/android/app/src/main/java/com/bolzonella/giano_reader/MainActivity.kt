package com.bolzonella.giano_reader

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

import android.view.View
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()

    super.onCreate(savedInstanceState)

    /* Note re: following code padding top & bottom of screen-
     * Known but in Webview https://github.com/tauri-apps/tauri/issues/14240
     * where it does not pass/apply safe area insets for edge to edge; as of recent
     * Android API, edge to edge is required, but the app overlaps with the status bar
     * and navigation menu if no safe area inset padding is applied.
     * Attempts to apply safe area inset failed:
     * - in style.css #app
     * - using tauri cargo crate plugins for applying safe inset
     * - retrieving insets in this MainActivity.kt and applying to overlying Javascript
     *
     * At this time, the easiest solution is to pad the rootView. It is possible to hold the padding
     * values in Kotlin, request them from the overlying Javascript, then apply them to CSS, but
     * that could upset cross-platform builds. Handling padding in this file only affects Android.
     */

    // Find the root view content frame
    val rootView: View = findViewById(android.R.id.content)

    // Bind an insets listener to dynamically inject padding equal to the status & navigation bar heights
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
    val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())

    // This manually adds a physical margin/padding to your webview container layout
    view.setPadding(
        systemBars.left,
        systemBars.top,     // Pushes the top of the webview down below the status bar
        systemBars.right,
        systemBars.bottom   // Keeps the bottom above the navigation bar/gesture pill
    )
    insets
    }
  }
}
