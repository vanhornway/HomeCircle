package us.umair.homecircle.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What voice calls need from Android that Expo and react-native-webrtc don't
 * offer (docs/CALLS-PLAN.md): the call audio mode and focus, earpiece /
 * speaker / Bluetooth routing, a foreground service with wake and Wi-Fi locks,
 * ringing (in the app and as a full-screen notification over the lock screen),
 * and reading which button of that notification was pressed.
 */
@Suppress("DEPRECATION")
class HcCallsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No Android context")

  private val audio: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val notifications: NotificationManager
    get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private var focusRequest: AudioFocusRequest? = null
  private var savedMode: Int? = null
  private var deviceCallback: AudioDeviceCallback? = null
  private var ringtone: MediaPlayer? = null
  private var vibrator: Vibrator? = null

  override fun definition() = ModuleDefinition {
    Name("HcCalls")

    Events("onRoutesChanged", "onCallAction")

    // --- keeping the call alive ---------------------------------------------

    Function("startService") { title: String, text: String ->
      val intent = Intent(context, CallService::class.java).putExtra("title", title).putExtra("text", text)
      try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("stopService") {
      context.stopService(Intent(context, CallService::class.java))
    }

    // --- audio ---------------------------------------------------------------

    // The call audio mode and focus: echo cancellation and routing work as in a phone call.
    Function("setCallAudio") { active: Boolean ->
      if (active) {
        if (savedMode == null) savedMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        requestFocus()
        watchDevices()
      } else {
        unwatchDevices()
        abandonFocus()
        try {
          if (Build.VERSION.SDK_INT >= 31) {
            audio.clearCommunicationDevice()
          } else {
            audio.isSpeakerphoneOn = false
            audio.stopBluetoothSco()
            audio.isBluetoothScoOn = false
          }
        } catch (_: Exception) {
        }
        savedMode?.let { audio.mode = it }
        savedMode = null
      }
    }

    // 'earpiece' | 'speaker' | 'bluetooth'. False if that route isn't there.
    Function("setRoute") { route: String -> setRoute(route) }

    Function("getRoutes") { routesMap() }

    // --- ringing -------------------------------------------------------------

    // Ring inside the app (it is open): the ringtone and a vibration, until stopRinging.
    Function("startRinging") { startRinging() }
    Function("stopRinging") { stopRinging() }

    // A call from someone, as a full-screen notification (over the lock screen)
    // that rings until answered, declined, or 45 seconds.
    Function("showIncoming") { callId: String, name: String, circleId: String, peerId: String ->
      showIncoming(callId, name, circleId, peerId)
    }
    Function("cancelIncoming") { notifications.cancel(INCOMING_ID) }
    Function("showMissed") { name: String ->
      notifications.cancel(INCOMING_ID)
      showMissed(name)
    }

    // The answer / decline / open button pressed on that notification, once.
    Function("consumeLaunchAction") {
      val intent = appContext.currentActivity?.intent
      val action = intent?.getStringExtra(EXTRA_ACTION)
      if (intent == null || action == null) null else actionMap(intent).also { clearAction(intent) }
    }

    OnNewIntent { intent ->
      if (intent.getStringExtra(EXTRA_ACTION) != null) {
        sendEvent("onCallAction", actionMap(intent))
        clearAction(intent)
      }
    }

    // Show the call screen above the lock screen and wake the display, while a call is ringing or on.
    Function("showOverLockScreen") { on: Boolean ->
      val activity = appContext.currentActivity
      if (activity != null && Build.VERSION.SDK_INT >= 27) {
        activity.runOnUiThread {
          activity.setShowWhenLocked(on)
          activity.setTurnScreenOn(on)
        }
      }
    }

    // Whether Android lets this app ring over the lock screen (Android 14 takes it back from some apps).
    Function("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT >= 34) notifications.canUseFullScreenIntent() else true
    }

    Function("openFullScreenSettings") {
      if (Build.VERSION.SDK_INT >= 34) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          context.startActivity(intent)
          true
        } catch (e: Exception) {
          false
        }
      } else {
        false
      }
    }

    OnDestroy {
      stopRinging()
      unwatchDevices()
    }
  }

  // --- audio helpers -----------------------------------------------------------

  private fun requestFocus() {
    val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    if (Build.VERSION.SDK_INT >= 26) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).setOnAudioFocusChangeListener { }.build()
      audio.requestAudioFocus(req)
      focusRequest = req
    } else {
      audio.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= 26) {
      focusRequest?.let { audio.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      audio.abandonAudioFocus(null)
    }
  }

  private fun bluetoothDevice(): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT >= 31) {
      return audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
    }
    if (Build.VERSION.SDK_INT >= 23) {
      return audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
    }
    return null
  }

  private fun communicationDevice(type: Int): AudioDeviceInfo? =
    if (Build.VERSION.SDK_INT >= 31) audio.availableCommunicationDevices.firstOrNull { it.type == type } else null

  private fun setRoute(route: String): Boolean {
    try {
      when (route) {
        "speaker" -> {
          if (Build.VERSION.SDK_INT >= 31) {
            val d = communicationDevice(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) ?: return false
            return audio.setCommunicationDevice(d)
          }
          audio.stopBluetoothSco()
          audio.isBluetoothScoOn = false
          audio.isSpeakerphoneOn = true
          return true
        }
        "earpiece" -> {
          if (Build.VERSION.SDK_INT >= 31) {
            val d = communicationDevice(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
            if (d != null) return audio.setCommunicationDevice(d)
            audio.clearCommunicationDevice()
            return true
          }
          audio.stopBluetoothSco()
          audio.isBluetoothScoOn = false
          audio.isSpeakerphoneOn = false
          return true
        }
        "bluetooth" -> {
          val d = bluetoothDevice() ?: return false
          if (Build.VERSION.SDK_INT >= 31) return audio.setCommunicationDevice(d)
          audio.isSpeakerphoneOn = false
          audio.startBluetoothSco()
          audio.isBluetoothScoOn = true
          return true
        }
      }
    } catch (e: Exception) {
      return false
    }
    return false
  }

  private fun currentRoute(): String {
    if (Build.VERSION.SDK_INT >= 31) {
      return when (audio.communicationDevice?.type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
        else -> "earpiece"
      }
    }
    return when {
      audio.isBluetoothScoOn -> "bluetooth"
      audio.isSpeakerphoneOn -> "speaker"
      else -> "earpiece"
    }
  }

  private fun routesMap(): Map<String, Any> {
    val available = mutableListOf("earpiece", "speaker")
    if (bluetoothDevice() != null) available.add("bluetooth")
    return mapOf("available" to available, "current" to currentRoute())
  }

  // A headset connecting or going away changes what's available: the app falls back to the earpiece itself.
  private fun watchDevices() {
    if (deviceCallback != null || Build.VERSION.SDK_INT < 23) return
    val cb = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = sendEvent("onRoutesChanged", routesMap())
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = sendEvent("onRoutesChanged", routesMap())
    }
    audio.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
    deviceCallback = cb
  }

  private fun unwatchDevices() {
    val cb = deviceCallback ?: return
    if (Build.VERSION.SDK_INT >= 23) audio.unregisterAudioDeviceCallback(cb)
    deviceCallback = null
  }

  // --- ringing helpers -----------------------------------------------------------

  private fun startRinging() {
    stopRinging()
    val mode = audio.ringerMode
    if (mode == AudioManager.RINGER_MODE_NORMAL) {
      try {
        val player = MediaPlayer()
        player.setDataSource(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        player.isLooping = true
        player.prepare()
        player.start()
        ringtone = player
      } catch (_: Exception) {
        ringtone = null
      }
    }
    if (mode != AudioManager.RINGER_MODE_SILENT) {
      val v = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      if (v != null && v.hasVibrator()) {
        val pattern = longArrayOf(0, 800, 800)
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, 0)) else v.vibrate(pattern, 0)
        vibrator = v
      }
    }
  }

  private fun stopRinging() {
    ringtone?.let {
      try {
        it.stop()
      } catch (_: Exception) {
      }
      it.release()
    }
    ringtone = null
    vibrator?.cancel()
    vibrator = null
  }

  // --- notifications ---------------------------------------------------------------

  private fun launchIntent(action: String, callId: String, circleId: String, peerId: String): Intent? =
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(EXTRA_ACTION, action)
      putExtra(EXTRA_CALL, callId)
      putExtra(EXTRA_CIRCLE, circleId)
      putExtra(EXTRA_PEER, peerId)
    }

  private fun pending(code: Int, action: String, callId: String, circleId: String, peerId: String): PendingIntent? {
    val intent = launchIntent(action, callId, circleId, peerId) ?: return null
    return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun smallIcon(): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  /** Android fixes a channel's sound and Do Not Disturb setting when it's made, hence one id per setting. */
  private fun incomingChannel(): String {
    val bypass = notifications.isNotificationPolicyAccessGranted
    val id = if (bypass) "calls-incoming-bypass" else "calls-incoming"
    if (Build.VERSION.SDK_INT >= 26 && notifications.getNotificationChannel(id) == null) {
      val ch = NotificationChannel(id, if (bypass) "Incoming calls (through Do Not Disturb)" else "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
      ch.description = "When someone in your circle calls you"
      ch.setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
      )
      ch.enableVibration(true)
      ch.vibrationPattern = longArrayOf(0, 800, 800)
      ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      if (bypass) ch.setBypassDnd(true)
      notifications.createNotificationChannel(ch)
    }
    return id
  }

  private fun showIncoming(callId: String, name: String, circleId: String, peerId: String) {
    val answer = pending(1, "answer", callId, circleId, peerId)
    val decline = pending(2, "decline", callId, circleId, peerId)
    val open = pending(3, "open", callId, circleId, peerId)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, incomingChannel()) else Notification.Builder(context)
    builder
      .setSmallIcon(smallIcon())
      .setContentTitle(name)
      .setContentText("Incoming HomeCircle call")
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setAutoCancel(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setWhen(System.currentTimeMillis())
    if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(45_000)
    if (open != null) {
      builder.setContentIntent(open)
      builder.setFullScreenIntent(open, true)
    }
    if (Build.VERSION.SDK_INT >= 31 && answer != null && decline != null) {
      val person = android.app.Person.Builder().setName(name).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(person, decline, answer))
    } else {
      if (decline != null) builder.addAction(Notification.Action.Builder(null, "Decline", decline).build())
      if (answer != null) builder.addAction(Notification.Action.Builder(null, "Answer", answer).build())
      if (Build.VERSION.SDK_INT < 26) {
        builder.setPriority(Notification.PRIORITY_MAX)
        builder.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
      }
    }
    val notification = builder.build()
    // Keeps the ringtone going until the notification goes.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    notifications.notify(INCOMING_ID, notification)
  }

  private fun showMissed(name: String) {
    val id = "calls-missed"
    if (Build.VERSION.SDK_INT >= 26 && notifications.getNotificationChannel(id) == null) {
      notifications.createNotificationChannel(NotificationChannel(id, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val open = pending(4, "open", "", "", "")
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, id) else Notification.Builder(context)
    builder.setSmallIcon(smallIcon()).setContentTitle("Missed call").setContentText(name).setCategory(Notification.CATEGORY_MISSED_CALL).setAutoCancel(true)
    if (open != null) builder.setContentIntent(open)
    notifications.notify(MISSED_ID, builder.build())
  }

  private fun actionMap(intent: Intent): Map<String, String> =
    mapOf(
      "action" to (intent.getStringExtra(EXTRA_ACTION) ?: ""),
      "callId" to (intent.getStringExtra(EXTRA_CALL) ?: ""),
      "circleId" to (intent.getStringExtra(EXTRA_CIRCLE) ?: ""),
      "peerId" to (intent.getStringExtra(EXTRA_PEER) ?: ""),
    )

  private fun clearAction(intent: Intent) {
    intent.removeExtra(EXTRA_ACTION)
    intent.removeExtra(EXTRA_CALL)
    intent.removeExtra(EXTRA_CIRCLE)
    intent.removeExtra(EXTRA_PEER)
  }

  companion object {
    const val INCOMING_ID = 4101
    const val MISSED_ID = 4102
    const val EXTRA_ACTION = "hc_call_action"
    const val EXTRA_CALL = "hc_call_id"
    const val EXTRA_CIRCLE = "hc_call_circle"
    const val EXTRA_PEER = "hc_call_peer"
  }
}
