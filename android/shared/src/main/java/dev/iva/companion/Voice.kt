package dev.iva.companion

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.util.Log
import java.io.File
import androidx.core.content.ContextCompat
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Speech in and speech out, both from the platform: `SpeechRecognizer` and
 * `TextToSpeech` ship with Android, cost nothing per turn, and work without a network
 * on any recent device. Sending audio to a server would buy a nicer voice at the price
 * of latency, money and an upload — not worth it before the loop itself is proven.
 */
class Dictation(private val context: Context) {

    private var recognizer: SpeechRecognizer? = null

    val isAvailable: Boolean
        get() = SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * Whether the microphone may be used at all. Checked before every dictation, not
     * once at startup: a permission can be refused, revoked from Settings, or reset by
     * Android when the app goes unused, and each of those must ask again rather than
     * fail with a recognizer error nobody can interpret.
     */
    val hasPermission: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Starts listening. [onPartial] fires while the user speaks so the screen can show
     * the words landing; [onResult] fires once with the final text, or with null when
     * nothing was understood. Must be called from the main thread — `SpeechRecognizer`
     * refuses to work anywhere else.
     */
    fun start(
        onPartial: (String) -> Unit,
        onResult: (String?) -> Unit,
        onError: (String, String) -> Unit,
        onServiceRefused: (String) -> Unit,
    ) {
        stop()
        if (!isAvailable) {
            onError("Questo dispositivo non sa trascrivere.", diagnostics("nessun servizio di riconoscimento"))
            return
        }
        // Bind to a named service rather than the device default. Vendor ROMs ship
        // their own assistant as the default recognizer, and several refuse
        // third-party clients outright with ERROR_CLIENT; Google's service, when the
        // phone has one, takes them.
        val chosen = preferredService()
        val recognizer = (
            if (chosen != null) SpeechRecognizer.createSpeechRecognizer(context, chosen)
            else SpeechRecognizer.createSpeechRecognizer(context)
            ).also { this.recognizer = it }
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit

            override fun onPartialResults(partialResults: Bundle?) {
                firstResult(partialResults)?.let(onPartial)
            }

            override fun onResults(results: Bundle?) {
                onResult(firstResult(results))
            }

            override fun onError(error: Int) {
                // NO_MATCH and SPEECH_TIMEOUT mean "you said nothing", which is not a
                // failure worth announcing: the caller just goes back to idle.
                if (error == SpeechRecognizer.ERROR_NO_MATCH ||
                    error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                ) {
                    onResult(null)
                    return
                }
                val detail = diagnostics("${codeName(error)} ($error)")
                // The service exists but will not serve us. Nothing the user can fix,
                // and nothing a retry changes: hand the turn to the system dictation
                // screen instead, which every phone has.
                if (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_SERVER) {
                    onServiceRefused(detail)
                    return
                }
                onError(describe(error), detail)
            }
        })
        recognizer.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANGUAGE)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            },
        )
    }

    /** Ends the dictation; the final result still arrives through `onResult`. */
    fun stopListening() {
        recognizer?.stopListening()
    }

    fun stop() {
        recognizer?.destroy()
        recognizer = null
    }

    /**
     * The recognition service to bind to: Google's when the phone has it, otherwise the
     * device default. Returns null when nothing is installed, in which case the caller
     * has already given up on availability.
     */
    private fun preferredService(): ComponentName? {
        val services = context.packageManager
            .queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
            .mapNotNull { it.serviceInfo }
        val pick = services.firstOrNull { it.packageName.startsWith("com.google.android") }
            ?: return null
        return ComponentName(pick.packageName, pick.name)
    }

    /** Every recognition service on the phone — the answer to "which one refused us". */
    private fun installedServices(): String = context.packageManager
        .queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
        .mapNotNull { it.serviceInfo?.packageName }
        .distinct()
        .joinToString(",")
        .ifEmpty { "nessuno" }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    private fun describe(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Problema col microfono."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Manca il permesso microfono."
        // Several phones report a missing microphone permission as a plain client
        // error, so this says the likely cause instead of a shrug.
        SpeechRecognizer.ERROR_CLIENT ->
            if (hasPermission) "Il riconoscitore ha rifiutato la richiesta." else "Manca il permesso microfono."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            "La trascrizione non ha rete."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Il riconoscitore è occupato."
        SpeechRecognizer.ERROR_SERVER, SERVER_DISCONNECTED -> "Il servizio vocale non risponde."
        LANGUAGE_NOT_SUPPORTED, LANGUAGE_UNAVAILABLE ->
            "L'italiano non è disponibile per la dettatura."
        else -> "Non sono riuscito a trascrivere."
    }

    /** Names the error the way the platform does, so a report can be looked up. */
    private fun codeName(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ERROR_NETWORK_TIMEOUT"
        SpeechRecognizer.ERROR_NETWORK -> "ERROR_NETWORK"
        SpeechRecognizer.ERROR_AUDIO -> "ERROR_AUDIO"
        SpeechRecognizer.ERROR_SERVER -> "ERROR_SERVER"
        SpeechRecognizer.ERROR_CLIENT -> "ERROR_CLIENT"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "ERROR_SPEECH_TIMEOUT"
        SpeechRecognizer.ERROR_NO_MATCH -> "ERROR_NO_MATCH"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "ERROR_RECOGNIZER_BUSY"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "ERROR_INSUFFICIENT_PERMISSIONS"
        TOO_MANY_REQUESTS -> "ERROR_TOO_MANY_REQUESTS"
        SERVER_DISCONNECTED -> "ERROR_SERVER_DISCONNECTED"
        LANGUAGE_NOT_SUPPORTED -> "ERROR_LANGUAGE_NOT_SUPPORTED"
        LANGUAGE_UNAVAILABLE -> "ERROR_LANGUAGE_UNAVAILABLE"
        CANNOT_CHECK_SUPPORT -> "ERROR_CANNOT_CHECK_SUPPORT"
        else -> "ERROR_$error"
    }

    /**
     * The line the user copies out of the app when something fails. It carries what a
     * reader would otherwise have to ask for: which phone, which Android, whether the
     * permission and the recognizer are actually there.
     */
    private fun diagnostics(cause: String): String = listOf(
        "dettatura: $cause",
        "lingua=$LANGUAGE",
        "permesso=${if (hasPermission) "concesso" else "NEGATO"}",
        "riconoscitore=${if (isAvailable) "presente" else "ASSENTE"}",
        "usato=${preferredService()?.packageName ?: "predefinito di sistema"}",
        "installati=${installedServices()}",
        "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
    ).joinToString(" · ")

    companion object {
        const val LANGUAGE = "it-IT"

        /**
         * The system dictation screen, used when the recognition service refuses to
         * serve the app directly. Every phone answers this intent; it listens, stops on
         * its own, and hands back the text.
         */
        fun systemDictationIntent(): Intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANGUAGE)
                putExtra(RecognizerIntent.EXTRA_PROMPT, "Parla con Iva")
            }

        /** The text the system dictation returned, or null when nothing came back. */
        fun textFrom(data: Intent?): String? =
            data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                ?.firstOrNull()
                ?.takeIf { it.isNotBlank() }

        // Added after minSdk 30, so they are named here rather than pulled from a
        // newer SpeechRecognizer constant the app cannot compile against.
        private const val TOO_MANY_REQUESTS = 10
        private const val SERVER_DISCONNECTED = 11
        private const val LANGUAGE_NOT_SUPPORTED = 12
        private const val LANGUAGE_UNAVAILABLE = 13
        private const val CANNOT_CHECK_SUPPORT = 14
    }
}

/**
 * Reads Iva's answers out loud — with her own voice when the server sends one, and
 * with the phone's otherwise. The fallback is the point: a companion that goes silent
 * because a model is down is worse than one that sounds generic.
 */
class Speaker(private val context: Context, private val onDone: () -> Unit = {}) {

    private var player: MediaPlayer? = null
    private var ready = false
    private val engine = TextToSpeech(context) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) engineLanguage()
    }

    // Whatever else the device is playing pauses while Iva talks and resumes after.
    // Without asking for focus she would speak over the podcast on the headphones.
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes)
        .build()

    init {
        engine.setAudioAttributes(attributes)
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                if (utteranceId == LAST_UTTERANCE) {
                    dropFocus()
                    onDone()
                }
            }

            @Deprecated("Required by the base class", ReplaceWith(""))
            override fun onError(utteranceId: String?) {
                dropFocus()
                onDone()
            }
        })
    }

    private fun engineLanguage() {
        val result = engine.setLanguage(Locale.ITALIAN)
        // A missing Italian voice is not fatal: the default voice reads the text with a
        // foreign accent, which is worth more than silence.
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            engine.setLanguage(Locale.getDefault())
        }
    }

    fun speak(text: String) {
        if (!ready) return
        val chunks = chunk(text, TextToSpeech.getMaxSpeechInputLength())
        if (chunks.isEmpty()) {
            onDone()
            return
        }
        audioManager?.requestAudioFocus(focus)
        chunks.forEachIndexed { index, chunk ->
            val id = if (index == chunks.lastIndex) LAST_UTTERANCE else "part-$index"
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            engine.speak(chunk, mode, null, id)
        }
    }

    /**
     * Plays audio the server synthesised. Returns false when the phone cannot play it,
     * so the caller can read the same words with [speak] instead of leaving silence.
     */
    fun play(wav: ByteArray): Boolean {
        stop()
        return try {
            val file = File(context.cacheDir, "reply.wav")
            file.writeBytes(wav)
            audioManager?.requestAudioFocus(focus)
            player = MediaPlayer().apply {
                setAudioAttributes(attributes)
                setDataSource(file.path)
                setOnCompletionListener { dropFocus(); onDone() }
                setOnErrorListener { _, _, _ -> dropFocus(); onDone(); true }
                prepare()
                start()
            }
            true
        } catch (failure: Exception) {
            Log.w("IvaSpeaker", "audio del server non riproducibile", failure)
            dropFocus()
            player = null
            false
        }
    }

    fun stop() {
        engine.stop()
        player?.runCatching { stop() }
        player?.release()
        player = null
        dropFocus()
    }

    private fun dropFocus() {
        audioManager?.abandonAudioFocusRequest(focus)
    }

    fun shutdown() {
        stop()
        engine.shutdown()
    }

    companion object {
        private const val LAST_UTTERANCE = "iva-last"

        /**
         * `TextToSpeech.speak` silently drops anything past its input cap, so a long
         * answer has to arrive in pieces. Splitting on sentence ends keeps the pauses
         * where a listener expects them; a sentence longer than the cap is cut hard,
         * because there is nothing better to break on.
         */
        fun chunk(text: String, limit: Int): List<String> {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return emptyList()
            if (trimmed.length <= limit) return listOf(trimmed)
            val out = mutableListOf<String>()
            val current = StringBuilder()
            for (sentence in trimmed.split(SENTENCE_END)) {
                if (sentence.isBlank()) continue
                if (current.isNotEmpty() && current.length + sentence.length + 1 > limit) {
                    out += current.toString().trim()
                    current.clear()
                }
                if (sentence.length > limit) {
                    if (current.isNotEmpty()) {
                        out += current.toString().trim()
                        current.clear()
                    }
                    sentence.chunked(limit).forEach { out += it.trim() }
                    continue
                }
                if (current.isNotEmpty()) current.append(' ')
                current.append(sentence.trim())
            }
            if (current.isNotEmpty()) out += current.toString().trim()
            return out.filter { it.isNotEmpty() }
        }

        private val SENTENCE_END = Regex("(?<=[.!?…])\\s+")
    }
}
