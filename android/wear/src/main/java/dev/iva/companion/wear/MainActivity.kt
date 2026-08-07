package dev.iva.companion.wear

import android.Manifest
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.wear.ambient.AmbientLifecycleObserver
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.input.RemoteInputIntentHelper
import dev.iva.companion.Config
import dev.iva.companion.ConfigSync
import dev.iva.companion.Dictation
import dev.iva.companion.IvaClient
import dev.iva.companion.Pairing
import dev.iva.companion.Settings
import dev.iva.companion.TurnController
import dev.iva.companion.TurnState
import kotlinx.coroutines.launch

/**
 * The whole watch app: tap and talk, the microphone stops by itself when you do. No
 * keyboard, no list, no history — the wrist is for the loop, the chat on the phone is
 * for the rest.
 */
class MainActivity : ComponentActivity() {

    private lateinit var turns: TurnController
    private lateinit var askForMicrophone: ActivityResultLauncher<String>
    private var config by mutableStateOf(Config("", ""))
    private var listenOnResume = false
    private var pairStatus by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Settings.load(this)
        turns = TurnController(this, lifecycleScope) { config }

        // With ambient support the watch face does not replace the app when the wrist
        // drops: the screen only dims, the turn in flight survives, and the answer is
        // spoken into a dark room instead of being cancelled by onStop.
        lifecycle.addObserver(
            AmbientLifecycleObserver(
                this,
                object : AmbientLifecycleObserver.AmbientLifecycleCallback {
                    override fun onEnterAmbient(
                        ambientDetails: AmbientLifecycleObserver.AmbientDetails,
                    ) = Unit

                    override fun onExitAmbient() = Unit
                    override fun onUpdateAmbient() = Unit
                },
            ),
        )

        // Same safety net as the phone: if the watch's recognition service refuses the
        // app, the system dictation takes the turn. On Wear OS this is the ordinary way
        // to dictate anyway.
        val systemDictation = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) { result -> turns.acceptDictation(Dictation.textFrom(result.data)) }
        turns.onServiceRefused = {
            runCatching { systemDictation.launch(Dictation.systemDictationIntent()) }
                .onFailure { turns.fail("Nessuna dettatura disponibile.") }
        }

        // Asked on the tap, not at startup — same reason as the phone app: a request
        // made before the first screen is drawn can be missed, and then a perfectly
        // working microphone looks broken. Once granted, listening starts right away:
        // whoever tapped wanted to talk, not to tap again.
        askForMicrophone = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) turns.startListening()
            else turns.fail("Senza microfono non posso ascoltarti.")
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

        // Standalone pairing, no phone app needed: type the address, a six-digit code
        // lands in Telegram, type it back — the watch trades it for the token.
        val urlInput = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            val typed = result.data?.let { RemoteInput.getResultsFromIntent(it) }
                ?.getCharSequence(KEY_INPUT)?.toString()
                ?.replace(" ", "").orEmpty()
            if (typed.isNotEmpty()) {
                // Nobody types a scheme on a watch keyboard.
                val address = if (typed.startsWith("http")) typed else "https://$typed"
                config = Config(address, "")
                Settings.save(this, config)
                // Asking for the address means pairing: the code goes out right away.
                requestPairCode()
            }
        }
        val codeInput = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            val typed = result.data?.let { RemoteInput.getResultsFromIntent(it) }
                ?.getCharSequence(KEY_INPUT)?.toString()
                ?.filter { it.isDigit() }.orEmpty()
            if (typed.isNotEmpty()) claimPairCode(typed)
        }

        listenOnResume = intent.getBooleanExtra(EXTRA_LISTEN, false)

        setContent {
            MaterialTheme {
                val state by turns.state.collectAsState()
                // The screen stays lit only while a turn needs eyes on it; ambient
                // mode carries the answer through a dropped wrist.
                val active = state is TurnState.Listening || state is TurnState.Thinking
                LaunchedEffect(active) {
                    if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                if (config.isComplete) {
                    TalkFace(state = state, onTap = ::tapped)
                } else {
                    PairFace(
                        address = config.baseUrl,
                        status = pairStatus,
                        onAddress = { keyboard(urlInput, "Indirizzo del server") },
                        onRequestCode = ::requestPairCode,
                        onCode = { keyboard(codeInput, "Codice a 6 cifre") },
                    )
                }
            }
        }
    }

    /** One gesture for the whole loop: tap to talk, tap again to stop early. */
    private fun tapped() {
        when {
            turns.state.value is TurnState.Listening -> turns.stopListening()
            turns.hasMicPermission -> turns.startListening()
            else -> askForMicrophone.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /** The system remote-input screen: the watch keyboard for one string. */
    private fun keyboard(into: ActivityResultLauncher<Intent>, label: String) {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(
            intent,
            listOf(RemoteInput.Builder(KEY_INPUT).setLabel(label).build()),
        )
        runCatching { into.launch(intent) }
            .onFailure { pairStatus = "Nessuna tastiera disponibile su questo orologio." }
    }

    private fun requestPairCode() {
        val address = config.baseUrl
        if (address.isBlank()) return
        pairStatus = "Chiedo il codice…"
        lifecycleScope.launch {
            pairStatus = when (val outcome = IvaClient.requestPairCode(address)) {
                is Pairing.CodeSent ->
                    "Codice inviato su Telegram: leggilo e poi tocca «Ho il codice»."
                is Pairing.Refused -> outcome.message
                is Pairing.Paired -> ""
            }
        }
    }

    private fun claimPairCode(code: String) {
        pairStatus = "Controllo il codice…"
        lifecycleScope.launch {
            when (val outcome = IvaClient.claimPairCode(config.baseUrl, code)) {
                is Pairing.Paired -> {
                    config = Config(config.baseUrl, outcome.token)
                    Settings.save(this@MainActivity, config)
                    pairStatus = ""
                }
                is Pairing.Refused -> pairStatus = outcome.message
                is Pairing.CodeSent -> Unit
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        listenOnResume = intent.getBooleanExtra(EXTRA_LISTEN, false)
    }

    override fun onResume() {
        super.onResume()
        // Coming from the tile the app opens already listening: one gesture, not two.
        if (listenOnResume) {
            listenOnResume = false
            if (config.isComplete) tapped()
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

    companion object {
        const val EXTRA_LISTEN = "listen"
        private const val KEY_INPUT = "input"
    }
}

@Composable
private fun TalkFace(state: TurnState, onTap: () -> Unit) {
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
                detectTapGestures(onTap = { onTap() })
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

/**
 * The pairing screen: address first, then the six digits from Telegram. The phone can
 * still do all of this for the watch through the Data Layer; this face is for a watch
 * that lives on its own.
 */
@Composable
private fun PairFace(
    address: String,
    status: String,
    onAddress: () -> Unit,
    onRequestCode: () -> Unit,
    onCode: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    ) {
        if (address.isBlank()) {
            Text(
                text = "Dove abita Iva?",
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.body2,
            )
            Action("Scrivi indirizzo", onAddress)
            Text(
                text = "Oppure apri Iva sul telefono: l'orologio si collega da solo.",
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.caption2,
            )
        } else {
            Text(
                text = address.removePrefix("https://"),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.caption2,
            )
            Action("Codice su Telegram", onRequestCode)
            Action("Ho il codice", onCode)
            Action("Cambia indirizzo", onAddress)
        }
        if (status.isNotBlank()) {
            Text(
                text = status,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.body2,
            )
        }
    }
}

@Composable
private fun Action(text: String, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        label = { Text(text) },
        colors = ChipDefaults.secondaryChipColors(),
        modifier = Modifier.fillMaxWidth(),
    )
}

private fun caption(state: TurnState): String = when (state) {
    is TurnState.Idle -> "Tocca\ne parla"
    is TurnState.Listening -> state.partial.ifBlank { "Ti ascolto" }
    is TurnState.Thinking -> "Sta pensando…"
    is TurnState.Answered -> state.reply
    is TurnState.Failed -> state.message
}
