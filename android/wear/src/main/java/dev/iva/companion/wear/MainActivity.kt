package dev.iva.companion.wear

import android.Manifest
import android.app.RemoteInput
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.wear.ambient.AmbientLifecycleObserver
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
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
import dev.iva.companion.Speaker
import dev.iva.companion.TurnController
import dev.iva.companion.TurnState
import kotlin.random.Random
import kotlinx.coroutines.delay
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
    private var ringOnResume = false
    private var pairStatus by mutableStateOf("")
    private var showSettings by mutableStateOf(false)
    private var tapBurst = 0
    private var lastTapAt = 0L

    // SCREEN_BRIGHT è deprecato ma è l'unico attrezzo che tiene lo schermo pieno
    // CONTRO il gesto del polso: FLAG_KEEP_SCREEN_ON ferma solo il timeout, e una
    // rotazione a metà dettatura manda in ambient e rovina il turno. Tenuto solo
    // mentre un turno è vivo, mai in idle: la batteria paga il turno, non l'app.
    @Suppress("DEPRECATION")
    private val turnWakeLock by lazy {
        (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "iva:turn",
            )
            .apply { setReferenceCounted(false) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Settings.load(this)
        turns = TurnController(
            this,
            lifecycleScope,
            localVoice = { Settings.localVoice(this) },
        ) { config }

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

        listenOnResume = intent.getBooleanExtra(EXTRA_LISTEN, false) || isAssist(intent)
        ringOnResume = intent.getBooleanExtra(EXTRA_RING, false)

        // La chiamata dal polso vive di notifiche: chiesto una volta, quando c'è
        // già un pairing (prima non c'è niente che possa squillare).
        val askForNotifications = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { }
        if (config.isComplete) {
            if (
                Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            registerPush()
        }

        setContent {
            MaterialTheme {
                val state by turns.state.collectAsState()
                val speakingNow by turns.speaking.collectAsState()
                // Un turno vivo = schermo pieno e immune al polso, dall'ascolto fino
                // all'ultima parola detta. In idle tutto torna normale.
                val active = speakingNow ||
                    state is TurnState.Listening ||
                    state is TurnState.Thinking
                LaunchedEffect(active) {
                    if (active) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        // Guardia da 10 minuti: nessun turno legittimo dura di più.
                        turnWakeLock.acquire(10 * 60_000L)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        if (turnWakeLock.isHeld) turnWakeLock.release()
                    }
                }
                if (showSettings) {
                    SettingsFace(
                        localVoice = Settings.localVoice(this),
                        onLocalVoice = { value -> Settings.saveLocalVoice(this, value) },
                        onClose = { showSettings = false },
                    )
                } else if (config.isComplete) {
                    val speaking by turns.speaking.collectAsState()
                    val avatar = rememberAvatar()
                    if (avatar != null) {
                        AvatarFace(
                            state = state,
                            speaking = speaking,
                            frames = avatar,
                            onTap = ::tapped,
                            onSettings = { showSettings = true },
                        )
                    } else {
                        TalkFace(
                            state = state,
                            onTap = ::tapped,
                            onSettings = { showSettings = true },
                        )
                    }
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
        // Dieci tocchi rapidi aprono le impostazioni (c'è anche la pressione
        // lunga). Durante la raffica il microfono sfarfalla: pazienza — il tocco
        // singolo deve restare istantaneo, niente debounce sul gesto principale.
        val now = SystemClock.uptimeMillis()
        tapBurst = if (now - lastTapAt < 400) tapBurst + 1 else 1
        lastTapAt = now
        if (tapBurst >= 10) {
            tapBurst = 0
            turns.cancel()
            showSettings = true
            return
        }
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
                    // Appena c'è un pairing, il polso diventa raggiungibile.
                    registerPush()
                }
                is Pairing.Refused -> pairStatus = outcome.message
                is Pairing.CodeSent -> Unit
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        listenOnResume = intent.getBooleanExtra(EXTRA_LISTEN, false) || isAssist(intent)
        ringOnResume = intent.getBooleanExtra(EXTRA_RING, false)
    }

    /** Aperta come assistente (tasto dedicato): si parte già in ascolto. */
    private fun isAssist(intent: Intent): Boolean =
        intent.action == Intent.ACTION_ASSIST || intent.action == Intent.ACTION_VOICE_COMMAND

    override fun onResume() {
        super.onResume()
        // Answering the wrist call: fetch the parked message and let her say it.
        if (ringOnResume) {
            ringOnResume = false
            if (config.isComplete) answerRing()
            return
        }
        // Coming from the tile the app opens already listening: one gesture, not two.
        if (listenOnResume) {
            listenOnResume = false
            if (config.isComplete) tapped()
        }
    }

    /** The push said only «ring»; the content lives behind the bearer, and gets spoken. */
    private fun answerRing() {
        NotificationManagerCompat.from(this).cancel(PushService.RING_ID)
        lifecycleScope.launch {
            IvaClient.fetchInbox(config)?.let(turns::deliver)
        }
    }

    /** Hands the FCM token to the server so the heartbeat can ring this wrist. */
    private fun registerPush() {
        if (FirebaseApp.getApps(this).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            PushService.register(this, token)
        }
    }

    override fun onStop() {
        super.onStop()
        turns.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (turnWakeLock.isHeld) turnWakeLock.release()
        turns.dispose()
    }

    companion object {
        const val EXTRA_LISTEN = "listen"
        const val EXTRA_RING = "ring"
        private const val KEY_INPUT = "input"
    }
}

/**
 * The frames of a LivePNG-style avatar, when the build ships them. The folder is
 * gitignored on purpose: character art has owners, the mechanism does not. Drop six
 * PNGs into `wear/src/main/assets/avatar/` — idle, blink, talk1, talk2, smile, think —
 * and the watch face becomes the character; leave it empty and the text face stays.
 */
@Composable
private fun rememberAvatar(): Map<String, ImageBitmap>? {
    val context = LocalContext.current
    return remember {
        runCatching {
            listOf("idle", "blink", "talk1", "talk2", "smile", "think").associateWith { name ->
                context.assets.open("avatar/$name.png").use { stream ->
                    checkNotNull(BitmapFactory.decodeStream(stream)).asImageBitmap()
                }
            }
        }.getOrNull()
    }
}

/**
 * The character does what the turn does: blinks while idle, looks up while the server
 * thinks, moves her lips while the voice is out, smiles when the answer lands. The
 * same two-frame lip flap the desktop LivePNG models use — on a watch nobody wants
 * more, and the battery agrees.
 */
@Composable
private fun AvatarFace(
    state: TurnState,
    speaking: Boolean,
    frames: Map<String, ImageBitmap>,
    onTap: () -> Unit,
    onSettings: () -> Unit,
) {
    var blink by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(Random.nextLong(2500, 5500))
            blink = true
            delay(120)
            blink = false
        }
    }
    var flap by remember { mutableStateOf(false) }
    LaunchedEffect(speaking) {
        if (!speaking) {
            flap = false
            return@LaunchedEffect
        }
        while (true) {
            flap = !flap
            delay(140)
        }
    }
    val frame = when {
        speaking -> if (flap) "talk2" else "talk1"
        state is TurnState.Thinking -> "think"
        state is TurnState.Answered -> "smile"
        blink -> "blink"
        else -> "idle"
    }
    // The avatar is transparent, so the state colour still reads behind her.
    val backdrop = when (state) {
        is TurnState.Listening -> MaterialTheme.colors.primary
        is TurnState.Failed -> MaterialTheme.colors.error
        else -> MaterialTheme.colors.background
    }
    // Sottotitoli col ritmo del parlato: mentre parla, una frase per volta
    // (avanza a velocità di lettura); a voce finita, il testo intero scorribile.
    // Mai più tre righe con i puntini che si mangiavano la risposta.
    val reply = (state as? TurnState.Answered)?.reply.orEmpty()
    val sentences = remember(reply) { Speaker.chunk(reply, 80) }
    var sentence by remember(reply) { mutableStateOf(0) }
    LaunchedEffect(reply, speaking) {
        if (speaking && sentences.isNotEmpty()) {
            for (i in sentences.indices) {
                sentence = i
                // ~65 ms a carattere ≈ il passo del sintetizzatore in italiano.
                delay((sentences[i].length * 65L).coerceIn(1400L, 7000L))
            }
        }
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(backdrop)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onTap() },
                    onLongPress = { onSettings() },
                )
            },
    ) {
        Image(
            bitmap = frames.getValue(frame),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        val caption = when (state) {
            is TurnState.Idle -> ""
            is TurnState.Listening -> state.partial.ifBlank { "Ti ascolto…" }
            is TurnState.Thinking -> "…"
            is TurnState.Answered ->
                if (speaking) sentences.getOrElse(sentence) { "" } else reply
            is TurnState.Failed -> state.message
        }
        val scrollable =
            !speaking && (state is TurnState.Answered || state is TurnState.Failed)
        if (caption.isNotBlank()) {
            val bubble = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 24.dp)
                .padding(bottom = 12.dp)
                .background(
                    MaterialTheme.colors.background.copy(alpha = 0.72f),
                    RoundedCornerShape(12.dp),
                )
                .padding(horizontal = 10.dp, vertical = 6.dp)
            if (scrollable) {
                Box(
                    modifier = bubble
                        .heightIn(max = 120.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(
                        text = caption,
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.caption1,
                    )
                }
            } else {
                Text(
                    text = caption,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.caption1,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                    modifier = bubble,
                )
            }
        }
    }
}

/** Dieci tocchi rapidi o una pressione lunga: qui. Voce di Iva o del dispositivo. */
@Composable
private fun SettingsFace(
    localVoice: Boolean,
    onLocalVoice: (Boolean) -> Unit,
    onClose: () -> Unit,
) {
    var local by remember { mutableStateOf(localVoice) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    ) {
        Text(
            text = "Impostazioni",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.body2,
        )
        Action(if (local) "Voce: orologio" else "Voce: Iva (server)") {
            local = !local
            onLocalVoice(local)
        }
        Text(
            text = if (local) "Risposta immediata, voce di sistema."
            else "La sua voce vera, un attimo di attesa.",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.caption2,
        )
        Action("Chiudi", onClose)
    }
}

@Composable
private fun TalkFace(state: TurnState, onTap: () -> Unit, onSettings: () -> Unit) {
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
                    onTap = { onTap() },
                    onLongPress = { onSettings() },
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
