# Iva companion — Android + Wear OS

Press, talk, listen. The apps do speech-to-text and text-to-speech on the device and
send only text to your own Iva server; the reply comes back in the same response and is
read aloud. Everything you say from the wrist also lands in your Telegram chat, so that
chat stays the archive.

| Module    | What it is                                                     |
| --------- | -------------------------------------------------------------- |
| `shared`  | HTTP client, settings, dictation, speech, and the turn state machine |
| `mobile`  | phone app: hold-to-talk, plus the settings screen                |
| `wear`    | watch app: hold-to-talk and a tile, standalone over WiFi/LTE     |

## Server side

The apps talk to `POST /eve/v1/app`, added by `scripts/lib/app-route.ts`. Before they
work:

1. Put a secret in the server's `.env`:

   ```
   IVA_APP_BEARER=<43 random base64url characters>
   ```

   Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
   An empty value locks the route: nobody gets in, by design.

2. Publish **only** that route over HTTPS. Everything else stays on `127.0.0.1:8723`.
   With Caddy:

   ```
   iva.example.com {
       handle /eve/v1/app {
           reverse_proxy 127.0.0.1:8723
       }
       respond 404
   }
   ```

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

## Pairing the watch

Type the address and token once on the phone and save. The phone publishes them on the
Wearable Data Layer; the watch stores them the moment it sees them, and asks for them
again at every start until it has a pair. That is the only thing the watch needs the
phone for — after that it reaches the server on its own.

## What these apps deliberately do not do

No history, no vault browser, no reminder list, no offline queue, no always-on hotword.
Telegram already has all of that, and every turn made here shows up in that chat.
