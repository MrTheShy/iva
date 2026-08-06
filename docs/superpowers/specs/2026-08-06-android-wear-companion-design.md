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
                                  │ send() sulla sessione della chat
                                  │   ↓ Iva pensa, usa vault/tool
                                  │ risposta (testo)               ┌→ 🎙 «...» (tuo)
                                  │ sendTelegramHtml ×2  ──────────┤
  ← 200 {reply}                   ┘                                └→ risposta di Iva
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
| `429` | oltre 30 richieste al minuto |
| `504` | nessuna risposta entro 120 secondi |

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

### Sessione

Il turno va inviato alla stessa sessione della chat Telegram, così una conversazione
iniziata dall'orologio prosegue su Telegram e viceversa.

Il continuation token della chat si ricostruisce dal `chatKey` `${chatId}:${threadId ?? ""}`
(`agent/lib/run-status.ts:9`). **Da verificare** contro i tipi di eve appena le dipendenze
sono installate: è l'unico punto del design con un rischio implementativo.

Ripiego, se eve non permette di indirizzare quella sessione dall'esterno: l'app apre una
sessione propria, come già fanno `scripts/heartbeat.ts` e `scripts/daily-digest.ts`. Il
terreno comune resta il vault più il mirror su Telegram. Va scelto in fase di piano, non
scoperto a metà implementazione.

### Mirror su Telegram

Due chiamate a `sendTelegramHtml` (`scripts/lib/telegram-send.ts:41`) sulla chat
dell'utente: prima il testo dettato con prefisso 🎙, poi la risposta. La funzione applica
già il gate `scanOutbound` e non lancia mai — un mirror fallito non deve far fallire il
turno, che all'app è già stato restituito.

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
- turno riuscito → `sendTelegramHtml` chiamato due volte, testo dettato e risposta
- mirror fallito → il turno risponde comunque 200

Lato Android nessun framework: un check a mano sui due dispositivi.

## Fuori scopo

Sfoglia-vault, promemoria e impostazioni nell'app; coda offline; hotword sempre in
ascolto; token per dispositivo; TTS con voce di qualità lato server; iOS e watchOS.
