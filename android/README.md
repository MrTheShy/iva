# Iva companion — Android + Wear OS

Press, talk, listen. The apps do speech-to-text and text-to-speech on the device and
send only text to your own Iva server; the reply comes back in the same response and is
read aloud. Everything you say from the wrist also lands in your Telegram chat, so that
chat stays the archive.

| Module   | What it is                                                           |
| -------- | -------------------------------------------------------------------- |
| `shared` | HTTP client, settings, dictation, speech, and the turn state machine |
| `mobile` | phone app: hold-to-talk, plus the settings screen                    |
| `wear`   | watch app: tap-to-talk and a tile, standalone over WiFi/LTE          |

On the watch a tap starts the microphone and it stops by itself at the end of speech;
the tile opens the app already listening. The wrist vibrates when listening starts,
when the answer lands, and on failure — and the watch answers with its own voice
immediately instead of waiting for the server to synthesise Iva's.

## Server side

The apps talk to `POST /eve/v1/app`, added by `scripts/lib/app-route.ts`. Before they
work:

1. Put a secret in the server's `.env`:

   ```
   IVA_APP_BEARER=<43 random base64url characters>
   ```

   Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
   An empty value locks the route: nobody gets in, by design. The apps never ask you
   to type it: they trade a 6-digit code from Telegram for it (see below).

2. Publish **only** that route over HTTPS. Everything else stays on `127.0.0.1:8723`.
   With Caddy:

   ```
   iva.example.com {
       @app path /eve/v1/app /eve/v1/app/*
       handle @app {
           reverse_proxy 127.0.0.1:8723
       }
       respond 404
   }
   ```

   The `/*` matters: voice (`/eve/v1/app/voice`) and pairing (`/eve/v1/app/pair`)
   live under the base path, and an exact matcher would 404 them.

3. `TELEGRAM_DIGEST_CHAT_ID` and `TELEGRAM_ALLOWED_USER_IDS` must already be set — the
   route speaks into that chat as that user. Both are set up by `npm run setup`.

## Building

Needs JDK 17 (AGP does not run on newer ones yet) and the Android SDK with platform 36.

```bash
cd android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew assembleDebug
```

APKs land in `mobile/build/outputs/apk/debug/` and `wear/build/outputs/apk/debug/`.
Install each on its device with `adb install -r <apk>`; the watch needs
`adb connect <watch-ip>:5555` first, with wireless debugging on.

Unit tests, no device needed:

```bash
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew :shared:testDebugUnitTest
```

## Pairing

Nobody types the token. On the phone: enter the address, tap «Mandami un codice su
Telegram», read the six digits in your chat, type them, done — the app trades the code
for the token (`POST /eve/v1/app/pair` → code in Telegram, `/pair/claim` → token).
The phone then publishes address and token on the Wearable Data Layer; the watch
stores them the moment it sees them.

A watch without the phone app pairs by itself the same way: type only the address on
the watch keyboard, ask for the code, type the six digits. Codes die after five wrong
guesses or five minutes, one is active at a time, and issuing is rate-limited.

## What these apps deliberately do not do

No history, no vault browser, no reminder list, no offline queue, no always-on hotword.
Telegram already has all of that, and every turn made here shows up in that chat.
