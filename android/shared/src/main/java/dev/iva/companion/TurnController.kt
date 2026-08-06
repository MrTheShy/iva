package dev.iva.companion

import android.content.Context
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

    data class Failed(val message: String) : TurnState
}

/**
 * The whole app, minus the pixels: listen, ask, speak. Phone and watch draw it
 * differently but behave identically, so the behaviour lives here once and neither
 * screen owns a copy of it.
 */
class TurnController(
    context: Context,
    private val scope: CoroutineScope,
    private val config: () -> Config,
) {
    private val appContext = context.applicationContext
    private val dictation = Dictation(appContext)
    private val speaker = Speaker(appContext)

    private val _state = MutableStateFlow<TurnState>(TurnState.Idle)
    val state: StateFlow<TurnState> = _state.asStateFlow()

    private var turn: Job? = null

    /** Begins dictation. Speaking over an answer stops it, which is the point. */
    fun startListening() {
        speaker.stop()
        turn?.cancel()
        _state.value = TurnState.Listening("")
        dictation.start(
            onPartial = { partial -> _state.value = TurnState.Listening(partial) },
            onResult = { text -> if (text == null) _state.value = TurnState.Idle else ask(text) },
            onError = { message -> _state.value = TurnState.Failed(message) },
        )
    }

    /** Ends dictation; the final text still arrives and starts the turn. */
    fun stopListening() {
        dictation.stopListening()
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
                    speaker.speak(answer.reply)
                }
                is Answer.Problem -> {
                    _state.value = TurnState.Failed(answer.message)
                    // Failures are spoken too: on the watch the screen is often already
                    // dark by the time an answer comes back.
                    speaker.speak(answer.message)
                }
            }
        }
    }
}
