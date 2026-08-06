package dev.iva.companion.mobile

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import dev.iva.companion.Config
import dev.iva.companion.ConfigSync
import dev.iva.companion.Settings
import dev.iva.companion.TurnController
import dev.iva.companion.TurnState
import kotlinx.coroutines.launch

/**
 * One screen: a button you hold while you talk. Settings appear instead of it until
 * there is somewhere to talk to, and behind a link afterwards.
 *
 * There is deliberately no history, no vault browser and no reminder list — Telegram
 * already has all of that, and every turn made here shows up in that chat.
 */
class MainActivity : ComponentActivity() {

    private lateinit var turns: TurnController
    private var config by mutableStateOf(Config("", ""))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Settings.load(this)
        turns = TurnController(this, lifecycleScope) { config }

        val askForMicrophone = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { }
        askForMicrophone.launch(Manifest.permission.RECORD_AUDIO)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val state by turns.state.collectAsState()
                    var editing by remember { mutableStateOf(false) }
                    if (editing || !config.isComplete) {
                        SettingsScreen(
                            config = config,
                            onSave = { updated ->
                                config = updated
                                Settings.save(this, updated)
                                lifecycleScope.launch { ConfigSync.push(this@MainActivity, updated) }
                                editing = false
                            },
                        )
                    } else {
                        TalkScreen(
                            state = state,
                            onPress = turns::startListening,
                            onRelease = turns::stopListening,
                            onRepeat = turns::repeatLast,
                            onSettings = { editing = true },
                        )
                    }
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        // Leaving the app must not leave the microphone open or a voice talking on.
        turns.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        turns.dispose()
    }
}

@Composable
private fun SettingsScreen(config: Config, onSave: (Config) -> Unit) {
    var url by remember { mutableStateOf(config.baseUrl) }
    var token by remember { mutableStateOf(config.token) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Iva", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Indirizzo del server e token dell'app. Il token è quello di IVA_APP_BEARER; " +
                "l'orologio lo riceve da qui.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Indirizzo") },
            placeholder = { Text("https://iva.example.com") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Token") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onSave(Config(url, token)) },
            enabled = Config(url, token).isComplete,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Salva")
        }
    }
}

@Composable
private fun TalkScreen(
    state: TurnState,
    onPress: () -> Unit,
    onRelease: () -> Unit,
    onRepeat: () -> Unit,
    onSettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = headline(state),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            Text(
                text = detail(state),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 12.dp),
            )
        }

        Box(
            modifier = Modifier
                .size(180.dp)
                .clip(CircleShape)
                .pointerInput(Unit) {
                    // Hold to talk: pressing starts the microphone and letting go sends.
                    // A toggle would leave it recording in a pocket.
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
            Surface(
                color = if (state is TurnState.Listening) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.secondaryContainer
                },
                shape = CircleShape,
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        text = if (state is TurnState.Listening) "Parla" else "Tieni premuto",
                        color = if (state is TurnState.Listening) Color.White else Color.Unspecified,
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (state is TurnState.Answered) {
                TextButton(onClick = onRepeat) { Text("Ripeti") }
            }
            TextButton(onClick = onSettings) { Text("Impostazioni") }
        }
    }
}

private fun headline(state: TurnState): String = when (state) {
    is TurnState.Idle -> "Pronta"
    is TurnState.Listening -> "Ti ascolto"
    is TurnState.Thinking -> "Sta pensando…"
    is TurnState.Answered -> "Iva"
    is TurnState.Failed -> "Problema"
}

private fun detail(state: TurnState): String = when (state) {
    is TurnState.Idle -> ""
    is TurnState.Listening -> state.partial
    is TurnState.Thinking -> state.question
    is TurnState.Answered -> state.reply
    is TurnState.Failed -> state.message
}
