package dev.iva.companion.wear

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject

/**
 * Firebase initialised by hand from `assets/google-services.json` — the raw file
 * as downloaded from the console, dropped in and gitignored. No google-services
 * gradle plugin: the public repo carries the mechanism, never anyone's config.
 * Without the file there is simply no push, and everything else lives on.
 */
class IvaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        runCatching {
            val raw = assets.open("google-services.json").bufferedReader().use { it.readText() }
            val root = JSONObject(raw)
            val project = root.getJSONObject("project_info")
            // Il file può elencare più app registrate: vale solo quella il cui
            // package coincide con questo APK, o FCM rifiuta l'autenticazione.
            val clients = root.getJSONArray("client")
            val client = (0 until clients.length())
                .map { clients.getJSONObject(it) }
                .firstOrNull {
                    it.getJSONObject("client_info")
                        .getJSONObject("android_client_info")
                        .getString("package_name") == packageName
                } ?: return@runCatching
            val options = FirebaseOptions.Builder()
                .setProjectId(project.getString("project_id"))
                .setApplicationId(client.getJSONObject("client_info").getString("mobilesdk_app_id"))
                .setApiKey(client.getJSONArray("api_key").getJSONObject(0).getString("current_key"))
                .build()
            FirebaseApp.initializeApp(this, options)
        }
    }
}
