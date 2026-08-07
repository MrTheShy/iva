# Voice companion apps

Iva reaches you on Telegram. These apps let you reach her without a screen: press, talk,
and hear the answer read back. One is a phone app, one runs on a Wear OS watch by
itself. The source is in [`android/`](../android/README.md).

Everything said from the wrist also arrives in your Telegram chat, so nothing you do
from the apps is lost to the archive.

## What it is not

Not a second chat client. No history, no vault browser, no reminder list, no offline
queue, no always-on hotword. Telegram has all of that already. The apps exist for the
one thing a chat cannot do: a hands-free voice loop while you drive, cook or walk.

## The route

The apps speak to one endpoint on your own server:

```
POST /eve/v1/app
Authorization: Bearer <IVA_APP_BEARER>

{ "text": "ricordami di chiamare il commercialista" }
→ { "reply": "Fatto, promemoria per domani alle 9." }
```

| Status | Meaning                                     |
| ------ | ------------------------------------------- |
| `200`  | the turn finished, `reply` is what she said |
| `400`  | no usable `text` in the body                |
| `401`  | wrong, missing or unconfigured bearer       |
| `409`  | a turn is already running on that chat      |
| `429`  | more than 30 requests in a rolling minute   |
| `502`  | the turn failed                             |
| `504`  | no answer within 120 seconds                |

The request stays open for the whole turn on purpose: without a synchronous reply there
is no voice loop.

The turn goes into the **same session as your Telegram chat**, so a conversation started
on the watch continues in Telegram and back. The reply is posted to the chat by the
Telegram channel itself; only your dictated text is echoed there, marked 🎙.

## Her own voice

The apps recognise speech on the device, but they do not have to answer with the voice
the phone shipped with. A resident [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
process on the server synthesises the reply in Italian, and the apps play it:

```
POST /eve/v1/app/voice
Authorization: Bearer <IVA_APP_BEARER>

{ "text": "Fatto, promemoria per domani alle 9." }
→ audio/wav
```

A separate request from the turn on purpose: the answer reaches the app as soon as it
exists, and the audio follows a second or two later. When the synthesiser is down,
unreachable, or slow, the route says so plainly and the app reads the same words with
the voice built into the device — a companion that goes silent because a model is down
is worse than one that sounds generic.

Setting it up: [scripts/voice/README.md](../scripts/voice/README.md). It is optional;
without it the apps simply use the phone's voice. The watch never asks for it: at the
wrist an answer now, in the watch's own voice, beats an answer half a minute later in
hers.

## Pairing with a code

Nobody types 43 characters on a watch. A device without a token asks for a code, the
code lands in your Telegram, and typing the six digits back trades them for the bearer:

```
POST /eve/v1/app/pair            → sends a 6-digit code to your Telegram chat
POST /eve/v1/app/pair/claim
{ "code": "123456" }             → { "token": "<IVA_APP_BEARER>" }
```

Both endpoints are unauthenticated by design — the device has no credentials yet.
What keeps them safe: the code only ever appears in your own chat, one code is active
at a time, it dies after five wrong guesses or five minutes, and issuing is
rate-limited to one code per 30 seconds so nobody can spam your chat or farm guesses.

## Turning it on

1. Add a secret to `.env`:

   ```
   IVA_APP_BEARER=<43 random base64url characters>
   ```

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   Leave it empty and the route rejects everyone — that is the default and it is
   deliberate.

2. Restart Iva: `systemctl --user restart iva`.

3. Publish **only** that route over HTTPS. This is the one part of Iva that faces the
   internet; `/eve/v1/telegram` and the rest of the API stay on `127.0.0.1:8723`
   ([deploy](./deploy.md)). With Caddy:

   ```
   iva.example.com {
       @app path /eve/v1/app /eve/v1/app/*
       handle @app {
           reverse_proxy 127.0.0.1:8723
       }
       respond 404
   }
   ```

   The `/*` matters: the voice and pairing endpoints live under `/eve/v1/app/…`, and
   an exact-path matcher would 404 them.

4. Build and install the apps: [android/README.md](../android/README.md).

5. On the phone, type the address and ask for a code on Telegram — the token arrives
   by itself. The watch receives both over the Wearable Data Layer; a watch without
   the phone app can pair on its own the same way, typing only the address.

## What guards it

- **Fail-closed bearer.** An unset `IVA_APP_BEARER` locks the route rather than opening
  it. The comparison is timing-safe.
- **Rate limit.** 30 requests per rolling minute, so a stolen token cannot quietly burn
  model credits.
- **One turn at a time.** While the chat is busy the route answers `409` instead of
  interleaving with what Telegram is doing.
- **The chat is fixed.** Turns always go to `TELEGRAM_DIGEST_CHAT_ID` as the first user
  in `TELEGRAM_ALLOWED_USER_IDS`. The apps cannot address anybody else.

Speech recognition and speech synthesis run on the phone and the watch, so no audio ever
leaves the device — only the transcribed text does.
