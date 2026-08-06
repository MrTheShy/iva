# Iva's voice

A resident [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) process that turns a
reply into Italian speech, so the companion apps answer in one voice instead of whatever
the phone shipped with. Optional: without it the apps read the text with the device's
own engine.

Loading the model costs a few seconds, so `server.py` keeps it in memory and answers
over loopback. It listens on `127.0.0.1:8730` and is unauthenticated on purpose — the
only caller is the Iva route on the same machine, which does check the app's bearer.

## Install

Needs Python 3.11 and a couple of hundred megabytes of model, downloaded on first run.
The CPU build of torch matters: the default wheel pulls ~5 GB of CUDA libraries onto a
machine that has no GPU.

```bash
sudo apt install espeak-ng          # Kokoro phonemises Italian through it
mkdir -p ~/voice && cd ~/voice
uv venv --python 3.11 .venv && . .venv/bin/activate
uv pip install torch --index-url https://download.pytorch.org/whl/cpu
uv pip install kokoro soundfile
```

Then a user service, so it comes back after a reboot:

```ini
# ~/.config/systemd/user/iva-voice.service
[Unit]
Description=Italian voice for the Iva companion apps (Kokoro)
After=network.target

[Service]
WorkingDirectory=%h/iva/scripts/voice
ExecStart=%h/voice/.venv/bin/python %h/iva/scripts/voice/server.py
Restart=on-failure
RestartSec=5
CPUWeight=40
MemoryMax=2G

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now iva-voice
curl -s localhost:8730/health          # {"ready": true, "voice": "if_sara"}
```

## Settings

| Variable              | Default     | What it does                                    |
| --------------------- | ----------- | ----------------------------------------------- |
| `IVA_VOICE`           | `if_sara`   | Kokoro voice; `im_nicola` is the male one       |
| `IVA_VOICE_PORT`      | `8730`      | Loopback port                                   |
| `IVA_VOICE_MAX_CHARS` | `1200`      | Longer replies are read to the cap, not refused |
| `IVA_VOICE_URL`       | `http://127.0.0.1:8730/say` | Where the Iva route looks for it |

## What it costs

On four cores with no GPU: about a gigabyte resident, and roughly a fifth of a second
of work per second of speech — a normal reply is spoken back within a second or two of
the text arriving.

## What was tried and dropped

Converting the output to a specific character's voice with RVC on top of this. On a CPU
it cost about a second per second of speech, took 3 GB on a box with 8 GB and no swap,
and did not sound enough like the target to be worth either. The pipeline lives on in
git history if a GPU ever shows up.
