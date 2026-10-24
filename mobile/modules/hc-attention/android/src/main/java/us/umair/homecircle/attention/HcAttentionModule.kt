package us.umair.homecircle.attention

import android.app.NotificationManager
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What chirps need from Android that Expo doesn't offer: whether Do Not
 * Disturb is on, blinking the camera light (no camera permission needed), and
 * previewing a chirp sound from the app's bundled sounds (res/raw).
 */
class HcAttentionModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No Android context")

  private var player: MediaPlayer? = null

  override fun definition() = ModuleDefinition {
    Name("HcAttention")

    // True while Do Not Disturb (any interruption filter) is limiting alerts.
    Function("isDoNotDisturbOn") {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val filter = nm.currentInterruptionFilter
      filter != NotificationManager.INTERRUPTION_FILTER_ALL && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
    }

    // Blink the camera light. Runs off the main thread; false if there's no
    // light or another app is using the camera.
    AsyncFunction("blink") { times: Int, onMs: Int, offMs: Int ->
      val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val id = cm.cameraIdList.firstOrNull {
        cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      } ?: return@AsyncFunction false
      try {
        repeat(times.coerceIn(1, 6)) {
          cm.setTorchMode(id, true)
          Thread.sleep(onMs.coerceIn(50, 1000).toLong())
          cm.setTorchMode(id, false)
          Thread.sleep(offMs.coerceIn(50, 1000).toLong())
        }
        true
      } catch (e: Exception) {
        try {
          cm.setTorchMode(id, false)
        } catch (_: Exception) {
        }
        false
      }
    }

    // Play a bundled sound (e.g. "chirp_robin") once, for previews.
    Function("preview") { name: String ->
      val res = context.resources.getIdentifier(name, "raw", context.packageName)
      if (res == 0) return@Function false
      player?.release()
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      player = MediaPlayer.create(context, res, attrs, 0)?.apply {
        setOnCompletionListener {
          it.release()
          if (player === it) player = null
        }
        start()
      }
      player != null
    }
  }
}
