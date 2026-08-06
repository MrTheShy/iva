package dev.iva.companion

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.tasks.await

/**
 * Carries the server address and token from the phone to the watch.
 *
 * The watch talks to Iva on its own — this is the one thing it cannot do alone, because
 * a 43-character token is not something anyone types on a watch. A data item rather
 * than a message: the watch may be off or out of range when the phone is set up, and a
 * data item is still there when it wakes.
 */
object ConfigSync {
    const val PATH = "/iva/config"
    private const val KEY_URL = "base_url"
    private const val KEY_TOKEN = "token"
    private const val TAG = "IvaConfigSync"

    /** Phone side: publish the current settings for the watch. */
    suspend fun push(context: Context, config: Config) {
        val request = PutDataMapRequest.create(PATH).apply {
            dataMap.putString(KEY_URL, config.baseUrl)
            dataMap.putString(KEY_TOKEN, config.token)
        }
        runCatching {
            Wearable.getDataClient(context).putDataItem(request.asPutDataRequest().setUrgent()).await()
        }.onFailure { Log.w(TAG, "config not sent to the watch", it) }
    }

    /**
     * Watch side: read whatever the phone published earlier. Called at startup, so a
     * watch that was out of range during setup catches up on its own.
     */
    suspend fun pull(context: Context): Config? = runCatching {
        Wearable.getDataClient(context)
            .dataItems
            .await()
            .use { buffer ->
                buffer.firstOrNull { it.uri.path == PATH }
                    ?.let { DataMapItem.fromDataItem(it).dataMap }
                    ?.let { Config(it.getString(KEY_URL, ""), it.getString(KEY_TOKEN, "")) }
            }
    }.onFailure { Log.w(TAG, "config not read from the phone", it) }.getOrNull()
}

/** Watch side: stores the settings the moment the phone changes them. */
class ConfigReceiverService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            if (event.dataItem.uri.path != ConfigSync.PATH) continue
            val map = DataMapItem.fromDataItem(event.dataItem).dataMap
            Settings.save(
                this,
                Config(map.getString("base_url", ""), map.getString("token", "")),
            )
        }
    }
}
