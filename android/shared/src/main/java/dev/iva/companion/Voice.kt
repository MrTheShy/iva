package dev.iva.companion

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
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
     * Starts listening. [onPartial] fires while the user speaks so the screen can show
     * the words landing; [onResult] fires once with the final text, or with null when
     * nothing was understood. Must be called from the main thread — `SpeechRecognizer`
     * refuses to work anywhere else.
     */
    fun start(
        onPartial: (String) -> Unit,
        onResult: (String?) -> Unit,
        onError: (String) -> Unit,
    ) {
        stop()
        if (!isAvailable) {
            onError("Questo dispositivo non sa trascrivere.")
            return
        }
        val recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { this.recognizer = it }
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
                onError(describe(error))
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

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    private fun describe(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Problema col microfono."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Manca il permesso microfono."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            "La trascrizione non ha rete."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Il riconoscitore è occupato."
        else -> "Non sono riuscito a trascrivere."
    }

    companion object {
        const val LANGUAGE = "it-IT"
    }
}

/** Reads Iva's answers out loud. */
class Speaker(context: Context, private val onDone: () -> Unit = {}) {

    private var ready = false
    private val engine = TextToSpeech(context) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) engineLanguage()
    }

    init {
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                if (utteranceId == LAST_UTTERANCE) onDone()
            }

            @Deprecated("Required by the base class", ReplaceWith(""))
            override fun onError(utteranceId: String?) = onDone()
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
        chunks.forEachIndexed { index, chunk ->
            val id = if (index == chunks.lastIndex) LAST_UTTERANCE else "part-$index"
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            engine.speak(chunk, mode, null, id)
        }
        if (chunks.isEmpty()) onDone()
    }

    fun stop() {
        engine.stop()
    }

    fun shutdown() {
        engine.stop()
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
