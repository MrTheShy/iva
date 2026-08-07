package dev.iva.companion

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One press-speak-hear cycle, as the screen sees it. */
sealed interface TurnState {
    data object Idle : TurnState

    data class Listening(val partial: String) : TurnState

    data class Thinking(val question: String) : TurnState

    data class Answered(val question: String, val reply: String) : TurnState

    /** [detail] is the technical line the screen offers to copy. */
    data class Failed(val message: String, val detail: String = "") : TurnState
}

/**
 * The whole app, minus the pixels: listen, ask, speak. Phone and watch draw it
 * differently but behave identically, so the behaviour lives here once and neither
 * screen owns a copy of it.
 *
 * [serverVoice] is false on the watch: waiting up to half a minute more for Iva's
 * nicer voice is worth it on a phone, but at the wrist hearing the answer now beats
 * hearing it pretty.
 */
class TurnController(
    context: Context,
    private val scope: CoroutineScope,
    private val serverVoice: Boolean = true,
    private val config: () -> Config,
) {
    private val appContext = context.applicationContext
    private val dictation = Dictation(appContext)
    private val speaker = Speaker(appContext)
    private val vibrator = appContext.getSystemService(Vibrator::class.java)

    private val _state = MutableStateFlow<TurnState>(TurnState.Idle)
    val state: StateFlow<TurnState> = _state.asStateFlow()

    private var turn: Job? = null

    /** True when the microphone may be used; the screen asks for it if not. */
    val hasMicPermission: Boolean
        get() = dictation.hasPermission

    /**
     * Set by the screen. Called when the recognition service refuses to serve the app —
     * which some vendor ROMs do to every third-party client. The screen answers by
     * opening the system dictation, then hands the text back to [acceptDictation].
     * Without it, the refusal is simply reported.
     */
    var onServiceRefused: ((String) -> Unit)? = null

    /** The text the system dictation came back with; null when nothing was understood. */
    fun acceptDictation(text: String?) {
        val spoken = text?.trim().orEmpty()
        if (spoken.isEmpty()) _state.value = TurnState.Idle else ask(spoken)
    }

    /** Begins dictation. Speaking over an answer stops it, which is the point. */
    fun startListening() {
        speaker.stop()
        turn?.cancel()
        _state.value = TurnState.Listening("")
        buzz(BUZZ_LISTENING)
        dictation.start(
            onPartial = { partial -> _state.value = TurnState.Listening(partial) },
            onResult = { text -> if (text == null) _state.value = TurnState.Idle else ask(text) },
            onError = ::fail,
            onServiceRefused = { detail ->
                val fallback = onServiceRefused
                if (fallback == null) {
                    fail("Il riconoscitore ha rifiutato la richiesta.", detail)
                } else {
                    _state.value = TurnState.Idle
                    fallback(detail)
                }
            },
        )
    }

    /** Ends dictation; the final text still arrives and starts the turn. */
    fun stopListening() {
        dictation.stopListening()
    }

    /** Puts a failure on screen that did not come from a turn, e.g. a refused permission. */
    fun fail(message: String, detail: String = "") {
        _state.value = TurnState.Failed(message, detail)
        buzz(BUZZ_FAILED)
    }

    /** Stops everything and goes quiet, without sending anything. */
    fun cancel() {
        turn?.cancel()
        dictation.stop()
        speaker.stop()
        _state.value = TurnState.Idle
    }

    /** Says the last answer again — the one thing you always want on a watch. */
    fun repeatLast() {
        val answered = _state.value as? TurnState.Answered ?: return
        speaker.speak(answered.reply)
    }

    fun dispose() {
        turn?.cancel()
        dictation.stop()
        speaker.shutdown()
    }

    private fun ask(text: String) {
        _state.value = TurnState.Thinking(text)
        turn = scope.launch {
            when (val answer = IvaClient.ask(config(), text)) {
                is Answer.Spoken -> {
                    _state.value = TurnState.Answered(text, answer.reply)
                    buzz(BUZZ_ANSWERED)
                    // Her voice when the server can make it, the phone's when it
                    // cannot. Either way the answer is heard.
                    val voice = if (serverVoice) IvaClient.speak(config(), answer.reply) else null
                    if (voice == null || !speaker.play(voice)) speaker.speak(answer.reply)
                }
                is Answer.Problem -> {
                    fail(answer.message, answer.detail)
                    // Failures are spoken too: on the watch the screen is often already
                    // dark by the time an answer comes back.
                    speaker.speak(answer.message)
                }
            }
        }
    }

    /**
     * The wrist is told, not shown: an answer that arrives with the arm down would
     * otherwise be an answer nobody notices.
     */
    private fun buzz(pattern: LongArray) {
        vibrator?.takeIf { it.hasVibrator() }
            ?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }

    private companion object {
        val BUZZ_LISTENING = longArrayOf(0, 30)
        val BUZZ_ANSWERED = longArrayOf(0, 40, 90, 40)
        val BUZZ_FAILED = longArrayOf(0, 250)
    }
}
