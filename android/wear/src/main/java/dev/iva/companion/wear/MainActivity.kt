package dev.iva.companion.wear

import android.Manifest
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import dev.iva.companion.Config
import dev.iva.companion.ConfigSync
import dev.iva.companion.Settings
import dev.iva.companion.TurnController
import dev.iva.companion.TurnState
import kotlinx.coroutines.launch

/**
 * The whole watch app: touch anywhere and talk, let go and listen. No keyboard, no
 * list, no history — the wrist is for the loop, the chat on the phone is for the rest.
 */
class MainActivity : ComponentActivity() {

    private lateinit var turns: TurnController
    private var config by mutableStateOf(Config("", ""))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Settings.load(this)
        turns = TurnController(this, lifecycleScope) { config }

        // A turn can run for a minute; the watch must not sleep in the middle of it and
        // drop the answer nobody heard.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Asked on the press, not at startup — same reason as the phone app: a request
        // made before the first screen is drawn can be missed, and then a perfectly
        // working microphone looks broken.
        val askForMicrophone = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (!granted) turns.fail("Senza microfono non posso ascoltarti.")
        }

        // The phone may have published the address and token while the watch was out of
        // range, so ask for them at every start until there is something to use.
        if (!config.isComplete) {
            lifecycleScope.launch {
                ConfigSync.pull(this@MainActivity)?.takeIf { it.isComplete }?.let { pulled ->
                    Settings.save(this@MainActivity, pulled)
                    config = pulled
                }
            }
        }

        setContent {
            MaterialTheme {
                val state by turns.state.collectAsState()
                if (config.isComplete) {
                    TalkFace(
                        state = state,
                        onPress = {
                            if (turns.hasMicPermission) turns.startListening()
                            else askForMicrophone.launch(Manifest.permission.RECORD_AUDIO)
                        },
                        onRelease = turns::stopListening,
                    )
                } else {
                    Centered("Apri Iva sul telefono e inserisci indirizzo e token.")
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        turns.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        turns.dispose()
    }
}

@Composable
private fun TalkFace(state: TurnState, onPress: () -> Unit, onRelease: () -> Unit) {
    // Colour is the only status indicator that survives a glance at arm's length.
    val backdrop = when (state) {
        is TurnState.Listening -> MaterialTheme.colors.primary
        is TurnState.Failed -> MaterialTheme.colors.error
        else -> MaterialTheme.colors.background
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(backdrop)
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = {
                        onPress()
                        tryAwaitRelease()
                        onRelease()
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = caption(state),
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.body1,
            modifier = Modifier
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        )
    }
}

@Composable
private fun Centered(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.body2,
            modifier = Modifier.padding(20.dp),
        )
    }
}

private fun caption(state: TurnState): String = when (state) {
    is TurnState.Idle -> "Tieni premuto\ne parla"
    is TurnState.Listening -> state.partial.ifBlank { "Ti ascolto" }
    is TurnState.Thinking -> "Sta pensando…"
    is TurnState.Answered -> state.reply
    is TurnState.Failed -> state.message
}
