---
description: Use when Shy asks to work on a coding project, or when you need to check on work already running. Launches and tracks Claude Code background agents.
---

# Lavorare sul codice — Claude in background

Il lavoro vero sul codice lo fa Claude Code, non tu. Tu decidi **cosa** chiedergli,
**quando**, e **cosa riportare a Shy**. Non gli fai da proxy sul codice: legge da
sé, più in fretta e meglio di quanto potresti riassumergli tu.

Tutto passa da `bash`. Non serve nessun tool dedicato.

## Lanciare un lavoro

```bash
cd ~/iva/work/<progetto> && claude --bg "<il compito, in una frase chiara>"
```

Torna **subito** con un id corto (`backgrounded · 029d2e39`). Non aspettare, non
mettere `&`, non usare `nohup`. Il processo sopravvive per conto suo.

- **Mai `-p` insieme a `--bg`**: la CLI rifiuta, il lavoro sarebbe inattaccabile.
- Claude si crea **da solo** un git worktree isolato sotto `.claude/worktrees/`.
  Non preparargliene uno: lavora lì, il repo principale non lo tocca.
- Il compito è il posizionale. Scrivilo come lo diresti a un collega: cosa deve
  ottenere e come si capisce che è finito. Non incollargli il codice.

**Modalità permessi.** Senza indicazioni si blocca alla prima richiesta e resta lì.
Scegli in base a quanto è reversibile il lavoro:

| | |
|---|---|
| `--permission-mode plan` | solo legge e propone un piano. **Default per un compito nuovo.** |
| `--permission-mode acceptEdits` | scrive file nel suo worktree senza chiedere |

Un compito grosso o poco chiaro parte **sempre** in `plan`: il piano torna a Shy,
lui approva, e solo allora rilanci in `acceptEdits`. Un piano sbagliato costa un
minuto; un'esecuzione sbagliata costa la sua giornata.

## Vedere come vanno

```bash
claude agents --json
```

Array JSON, uno per sessione. I campi che contano:

- `id` — l'id corto, quello che nomini a Shy
- `name` — il compito con cui è partito
- `cwd` — il worktree in cui sta lavorando
- `state` / `status` / `waitingFor` — **dove guardare per prima cosa**

`"state": "blocked"` con `"waitingFor": "permission prompt"` significa che è fermo
e aspetta un permesso. Non riparte da solo: o lo rilanci con una modalità permessi
adeguata, o lo dici a Shy. Un lavoro bloccato che nessuno guarda è tempo perso e
basta.

Una sessione sparita dall'elenco è finita. `claude agents --all --json` include
anche quelle concluse.

## Quante alla volta

**Due, massimo.** La macchina ha 8 GB e zero swap: tre Claude più il server di iva
la mandano in OOM, e in OOM muore anche tu. Prima di lanciarne uno nuovo conta
quelli attivi con `agents --json`.

## Cosa riportare a Shy

- **Piano pronto** → glielo passi e aspetti che approvi. È l'unico vero
  checkpoint: dopo, il lavoro va da sé.
- **Bloccato** → glielo dici subito con l'id e il motivo. È l'unico stato che non
  si risolve da solo.
- **Finito** → il risultato, e dove guardarlo (worktree, branch, diff).
- **In corso** → **niente.** Non aggiornare su un lavoro che sta semplicemente
  lavorando. Se te lo chiede, `agents --json` e rispondi.

## Cosa NON fare

- Non spiegargli il codice: lo legge lui.
- Non lanciarlo dal repo principale — il worktree è il punto.
- Non tenere aperta una shell in attesa che finisca: blocca il tuo turno e Shy
  resta senza risposta.
- Non lanciare lo stesso compito due volte perché «sembrava fermo»: guarda
  `agents --json` prima.
