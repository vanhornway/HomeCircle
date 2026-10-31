package us.umair.homecircle.calls

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
      // addFlags, not `flags =`: inside onStartCommand `flags` is the service's own (read-only) parameter.
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
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
    // Android refused every kind of service: no call service, but no crash either.
    if (!startAsForeground(notification)) {
      stopSelf()
      return START_NOT_STICKY
    }
    acquireLocks()
    return START_NOT_STICKY
  }

  private fun smallIcon(): Int {
    val id = resources.getIdentifier("notification_icon", "drawable", packageName)
    return if (id != 0) id else applicationInfo.icon
  }

  /**
   * As a foreground service of the first type Android accepts: phoneCall and
   * microphone, then microphone, then phoneCall. The microphone types need
   * RECORD_AUDIO already granted (Android stops the app otherwise), so they're
   * only tried with it. False if every one is refused.
   */
  private fun startAsForeground(notification: Notification): Boolean {
    if (Build.VERSION.SDK_INT < 30) {
      return try {
        startForeground(ID, notification)
        true
      } catch (e: RuntimeException) {
        false
      }
    }
    val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val types = mutableListOf<Int>()
    if (mic) {
      types.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      types.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }
    types.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    for (type in types) {
      try {
        startForeground(ID, notification, type)
        return true
      } catch (e: RuntimeException) {
        // SecurityException, or ForegroundServiceStartNotAllowedException: try the next type.
      }
    }
    return false
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
