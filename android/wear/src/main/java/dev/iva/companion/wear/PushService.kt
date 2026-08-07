package dev.iva.companion.wear

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.iva.companion.IvaClient
import dev.iva.companion.R as SharedR
import dev.iva.companion.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * The wrist call. The push carries no content — only «ring». The full-screen
 * intent opens the app straight into answer mode: it fetches the parked message
 * from the server and speaks it in her voice.
 */
class PushService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        register(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] != "ring") return
        ring()
    }

    private fun ring() {
        val manager = NotificationManagerCompat.from(this)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(
                CHANNEL,
                NotificationManagerCompat.IMPORTANCE_HIGH,
            )
                .setName("Chiamate di Iva")
                .setVibrationPattern(RING_PATTERN)
                .build(),
        )
        val intent = Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_RING, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(SharedR.drawable.ic_iva)
            .setContentTitle("Iva")
            .setContentText("Ti sta chiamando")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVibrate(RING_PATTERN)
            // Schermo intero: sul polso la chiamata È l'app che si apre in faccia.
            .setFullScreenIntent(pending, true)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(RING_ID, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS negato: il messaggio è comunque su Telegram.
        }
    }

    companion object {
        const val CHANNEL = "iva-ring"
        const val RING_ID = 7
        private val RING_PATTERN = longArrayOf(0, 400, 250, 400, 250, 400)

        /** Best-effort: senza pairing non c'è nessuno da registrare. */
        fun register(context: Context, token: String) {
            val config = Settings.load(context.applicationContext)
            if (!config.isComplete) return
            CoroutineScope(Dispatchers.IO).launch {
                IvaClient.registerPushToken(config, token)
            }
        }
    }
}
