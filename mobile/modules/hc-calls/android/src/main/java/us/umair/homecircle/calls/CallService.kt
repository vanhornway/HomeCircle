package us.umair.homecircle.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps a call alive while the phone is locked or the app is in the background:
 * a foreground service of type phoneCall|microphone (so Android keeps the
 * microphone and the process), a partial wake lock (the CPU keeps running) and
 * a Wi-Fi lock (the radio doesn't doze). Started from the visible call screen,
 * never from the background (Android 14 refuses a microphone service then).
 */
@Suppress("DEPRECATION")
class CallService : Service() {
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra("title") ?: "HomeCircle call"
    val text = intent?.getStringExtra("text") ?: "Tap to return to the call"
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Call in progress", NotificationManager.IMPORTANCE_LOW))
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pi = open?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    val notification = builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(smallIcon())
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_CALL)
      .apply { if (pi != null) setContentIntent(pi) }
      .build()
    startAsForeground(notification)
    acquireLocks()
    return START_NOT_STICKY
  }

  private fun smallIcon(): Int {
    val id = resources.getIdentifier("notification_icon", "drawable", packageName)
    return if (id != 0) id else applicationInfo.icon
  }

  private fun startAsForeground(notification: Notification) {
    if (Build.VERSION.SDK_INT >= 30) {
      // phoneCall needs MANAGE_OWN_CALLS (declared); if Android still refuses it, the microphone type alone keeps the call.
      try {
        startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } catch (e: SecurityException) {
        startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      }
    } else {
      startForeground(ID, notification)
    }
  }

  private fun acquireLocks() {
    if (wake == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "homecircle:call").apply {
        setReferenceCounted(false)
        acquire(MAX_CALL_MS)
      }
    }
    if (wifi == null) {
      val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifi = wm.createWifiLock(mode, "homecircle:call").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  override fun onDestroy() {
    try {
      wake?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
    }
    try {
      wifi?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
    }
    wake = null
    wifi = null
    super.onDestroy()
  }

  companion object {
    const val ID = 4107
    const val CHANNEL = "call-ongoing"
    const val ACTION_STOP = "us.umair.homecircle.calls.STOP"
    // A call longer than this loses the lock (a forgotten call must not hold the phone awake all night).
    const val MAX_CALL_MS = 4 * 60 * 60 * 1000L
  }
}
