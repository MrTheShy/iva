package dev.iva.companion

import android.content.Context

/**
 * Where the server is and how we prove we may talk to it.
 *
 * Two values, so this is SharedPreferences and not a database. The token is the one
 * from `IVA_APP_BEARER` on the server; it is typed once on the phone and travels to the
 * watch through [ConfigSync].
 */
data class Config(val baseUrl: String, val token: String) {
    val isComplete: Boolean
        get() = baseUrl.isNotBlank() && token.isNotBlank()

    /** Full URL of the turn route, tolerating a trailing slash in the typed host. */
    val endpoint: String
        get() = baseUrl.trimEnd('/') + "/eve/v1/app"

    /** Where the reply is turned into Iva's own voice. */
    val voiceEndpoint: String
        get() = endpoint + "/voice"
}

object Settings {
    private const val FILE = "iva-companion"
    private const val KEY_URL = "base_url"
    private const val KEY_TOKEN = "token"

    fun load(context: Context): Config {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return Config(
            baseUrl = prefs.getString(KEY_URL, "").orEmpty(),
            token = prefs.getString(KEY_TOKEN, "").orEmpty(),
        )
    }

    fun save(context: Context, config: Config) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_URL, config.baseUrl.trim())
            .putString(KEY_TOKEN, config.token.trim())
            .apply()
    }
}
