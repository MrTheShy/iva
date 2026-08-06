# App companion Android + Wear OS con voce

Data: 2026-08-06 · Stato: approvata, pronta per il piano

## Problema

Iva oggi si raggiunge solo da Telegram. Mandare un vocale funziona, ma il ciclo non si
chiude: la risposta va letta sullo schermo. Manca il giro completo voce→voce, e serve
soprattutto quando le mani sono occupate — in auto, in cucina, camminando.

L'obiettivo non è un secondo client di chat. È un pulsante: premi, parli, ti risponde a
voce. Tutto il resto — cronologia, ricerca, vault — resta su Telegram, che continua a
essere l'archivio.

## Cosa costruiamo

1. Una route HTTP nuova sul server Iva, `POST /eve/v1/app`, che accetta testo e
   restituisce la risposta di Iva in modo sincrono.
2. Un'app Android per telefono e una per Wear OS, che fanno voce→testo e testo→voce
   in locale e parlano a quella route.
3. Il mirror: ogni turno fatto dall'app compare anche nella chat Telegram.

## Decisioni prese

| Decisione | Scelta | Perché |
|---|---|---|
| Piattaforma | Android + Wear OS | Apple Watch richiede iPhone: watchOS non è accoppiabile ad Android |
| Trasporto | Dominio pubblico + HTTPS | Scelta del proprietario; esposta **solo** la route dell'app |
| Orologio | Standalone via WiFi/LTE | Stesso codice di rete del telefono, funziona senza telefono; il Data Layer serve solo a passare il token al primo avvio |
| STT / TTS | Nativi Android, sul dispositivo | Gratis, offline, latenza minima, zero codice server |
| Canale server | Route dentro il canale `telegram` | I continuation token sono namespaced per canale: un canale nuovo avrebbe una sessione separata |
| Codice Android | `android/` dentro questo repo | Tutto in un posto solo |

## Flusso di un turno

```
polso/telefono                    server Iva                      Telegram
─────────────                     ──────────                      ────────
premi, parli
  ↓ SpeechRecognizer (locale)
  testo
  ↓ POST /eve/v1/app  {text}      ┐
    Bearer <token>                │ verifica bearer
                                  │ eco del dettato ───────────────→ 🎙 «...» (tuo)
                                  │ send() sulla sessione della chat
                                  │   ↓ Iva pensa, usa vault/tool
                                  │ message.completed ─────────────→ risposta di Iva
  ← 200 {reply}                   ┘   (il canale la posta da sé)
  ↓ TextToSpeech (locale)
la senti
```

La richiesta resta aperta finché Iva non risponde. È il punto centrale del design: senza
risposta sincrona non si chiude il ciclo voce→voce, che è la ragione dell'app.

## Server

### File toccati

- **nuovo** `scripts/lib/app-route.ts` — tutta la logica: auth, validazione, invio alla
  sessione, mirror. Isolato per essere testabile senza rete.
- **nuovo** `scripts/lib/app-route.test.ts` — test `node:test`, come i file vicini.
- **modificato** `agent/channels/telegram.ts` — una `POST("/eve/v1/app", …)` nell'array
  `routes` del default export, accanto a quella di `/eve/v1/telegram/reset`.

La route deve stare dentro il canale `telegram` autorato, non in un canale nuovo: il
commento a `agent/channels/telegram.ts:1602-1605` documenta che eve antepone il nome del
canale al continuation token. Un canale `app` separato aprirebbe una sessione diversa da
quella della chat.

### Contratto

```
POST /eve/v1/app
Authorization: Bearer <IVA_APP_BEARER>
Content-Type: application/json

{ "text": "ricordami di chiamare il commercialista" }
```

| Stato | Quando |
|---|---|
| `200 { "reply": "…" }` | turno completato |
| `400` | body non JSON, campo `text` assente o vuoto dopo trim |
| `401` | header assente, malformato, o token diverso |
| `409` | un turno è già in corso su quella chat |
| `429` | oltre 30 richieste al minuto |
| `502` | il turno è fallito (`turn.failed`) |
| `504` | nessuna risposta entro 120 secondi |

Il `409` evita di infilare un turno dentro uno già in volo: il ponte Telegram
(`scripts/poller/`) per questo bufferizza, e l'app non passa dal ponte. Lo stato si legge
da `getChatStatus(chatKey)` (`agent/lib/run-status.ts`), che il canale tiene aggiornato a
ogni turno. L'app lo dice a voce: «sta ancora rispondendo».

### Autenticazione

Un token unico in `.env`, `IVA_APP_BEARER`, generato con `generateAssistantBearer()`
(`scripts/lib/assistant-auth.ts:5`). Confronto timing-safe con lo stesso `equalSecret`
di `agent/lib/eve-auth.ts:22`.

Fail-closed: se `IVA_APP_BEARER` è vuoto o assente la route risponde 401 a chiunque,
come fa già l'allowlist Telegram con la lista vuota.

Non usiamo `ASSISTANT_BEARER`: quello è il segreto dei client interni del server e non
deve finire dentro un APK.

Token per dispositivo (`data/app-devices.json` con hash per device) è la via di crescita
se un giorno i dispositivi diventano molti — con due, revocare significa rigenerare il
token e reincollarlo. Va annotato come commento `ponytail:` nel codice, non costruito ora.

### Sessione — verificato sui tipi di eve

Il turno va inviato alla stessa sessione della chat Telegram, così una conversazione
iniziata dall'orologio prosegue su Telegram e viceversa. eve lo supporta apertamente: non
serve nessun trucco.

Ogni route handler riceve `send` come secondo argomento —
«starts or continues a session on this channel»
(`node_modules/eve/dist/src/channel/routes.d.ts`, `RouteHandlerArgs`). Il token si
costruisce con `telegramContinuationToken({ chatId })`, esportato da
`eve/channels/telegram`: per le chat private usa il solo `chatId`. Niente stringhe
indovinate a mano.

```ts
const session = await send(text, {
  auth,                                              // vedi sotto
  continuationToken: telegramContinuationToken({ chatId }),
  state: { chatId, chatType: "private", conversationId: null, messageThreadId: null },
});
```

Lo `state` serve solo alla firma: `POST<TelegramChannelState>` è un canale stateful, e il
seed viene ignorato quando la sessione esiste già — che è il caso normale.

`auth` è un `SessionAuthContext` della stessa forma che `buildAuth`
(`agent/channels/telegram.ts:218`) costruisce per i messaggi Telegram, con
`authenticator: "iva-app"` per distinguere in log e attributi chi ha parlato dall'app.

Chat e utente non aggiungono configurazione: `TELEGRAM_DIGEST_CHAT_ID`, che heartbeat e
digest già usano, più l'id da `TELEGRAM_ALLOWED_USER_IDS`.

### Come torna la risposta all'app

`send` risolve appena la sessione accetta il messaggio, non a fine turno. Il testo si
raccoglie dallo stream durevole degli eventi:

1. `resolveActiveSession({ continuationToken })` → `sessionId`, se la sessione esiste
2. `getSession(sessionId).getStreamTailIndex()` → indice da cui leggere, preso **prima**
   del send, altrimenti i primi eventi si perdono
3. `send(...)` come sopra
4. `session.getEventStream({ startIndex })` → si legge fino al terminale
5. si accumulano i `message.completed` del turno, saltando quelli con
   `finishReason === "tool-calls"` o `message` nullo, e ci si ferma al primo
   `turn.completed`, `turn.failed` o `turn.cancelled`

È lo stesso filtro che il canale applica per decidere cosa postare su Telegram
(`agent/channels/telegram.ts:1132`): l'app sente esattamente quello che compare in chat.

### Mirror su Telegram

Una sola chiamata: l'eco del dettato, `sendTelegramHtml` (`scripts/lib/telegram-send.ts:41`)
con prefisso 🎙, prima del send. Non lancia mai, quindi un eco fallito non affonda il turno.

**La risposta non va rispecchiata a mano.** Inviando nella sessione della chat, l'handler
`message.completed` del canale (`agent/channels/telegram.ts:1131`) la posta già lui, con
gate `scanOutbound`, rich message e chunking a 4096 inclusi. Rispecchiarla di nuovo
significherebbe mandarla due volte.

### Esposizione

Il reverse proxy pubblica **solo** `/eve/v1/app`. `/eve/v1/telegram`, il canale `eve` e
tutto il resto dell'API restano su `127.0.0.1:8723` come oggi (`docs/deploy.md:7`).

Rate limit in memoria, 30 richieste al minuto: l'endpoint è pubblico e senza tetto un
token rubato brucia crediti del modello. I 401 vanno a log.

## App Android

### Struttura

```
android/
  shared/   client HTTP (una POST), wrapper STT, wrapper TTS
  mobile/   telefono, Compose
  wear/     orologio, Compose for Wear OS, standalone=true
```

`minSdk 30` per entrambe — è il minimo di Wear OS 3.

Nessuna dipendenza di rete: un endpoint solo, quindi `HttpURLConnection` e `org.json`,
già nel sistema. Niente OkHttp, Retrofit o Ktor.

### Voce

- **Ingresso**: `SpeechRecognizer`, `EXTRA_LANGUAGE_MODEL_FREE_FORM`, lingua `it-IT`,
  risultati parziali mostrati mentre parli.
- **Uscita**: `TextToSpeech`, `Locale.ITALIAN`, risposta spezzata in frasi così
  l'ascolto si può interrompere a metà.

### Telefono

Una schermata. Pulsante grande premi-e-parla, la trascrizione compare durante il parlato,
la risposta si legge a schermo e si ascolta, un tasto la fa ripetere. Impostazioni: URL
del server e token.

### Orologio

Un tile sul quadrante: un tap apre e registra, al rilascio parte la richiesta. Wake lock
mentre aspetta, poi TTS. Nessuna tastiera, nessuna lista, nessuna cronologia — solo il
ciclo.

Il token arriva dal telefono via Data Layer al primo avvio, una volta sola. È l'unica
dipendenza dal telefono: dopo, l'orologio lavora da solo.

### Errori

- Rete assente: errore a schermo, ritenti tu. Nessuna coda offline finché non serve.
- Trascrizione vuota: nessuna richiesta parte.
- Timeout: l'app lo dice, e la risposta si trova comunque su Telegram perché il mirror
  parte dal server, non dall'app.

## Test

`scripts/lib/app-route.test.ts`, con `node:test` e stub al posto della rete:

- token corretto → 200 con la risposta
- token errato, assente, malformato → 401
- `IVA_APP_BEARER` vuoto → 401 anche con un token plausibile
- `text` assente, vuoto, solo spazi → 400
- chat con turno in corso → 409, e `send` non viene chiamato
- turno riuscito → `sendTelegramHtml` chiamato **una** volta sola, con il testo dettato
- più `message.completed` nello stesso turno → concatenati nell'ordine di arrivo
- `message.completed` con `finishReason: "tool-calls"` → escluso dalla risposta
- `turn.failed` → 502, non attesa fino al timeout
- eco fallito → il turno risponde comunque 200

Lato Android nessun framework: un check a mano sui due dispositivi.

## Fuori scopo

Sfoglia-vault, promemoria e impostazioni nell'app; coda offline; hotword sempre in
ascolto; token per dispositivo; TTS con voce di qualità lato server; iOS e watchOS.
