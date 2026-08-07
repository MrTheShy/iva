---
description: Use when Shy asks to work on a coding project, or when you need to check on work already running. Launches and tracks Claude Code background agents.
---

# Lavorare sul codice — Claude in background

Il lavoro vero sul codice lo fa Claude Code, non tu. Tu decidi **cosa** chiedergli,
**quando**, e **cosa riportare a Shy**. Non gli fai da proxy sul codice: legge da
sé, più in fretta e meglio di quanto potresti riassumergli tu.

Usa il tool `claude_work`, non `bash`. Il tool impone tre limiti che una frase
in un file non può garantire: quanti lavori insieme, dove possono girare, e che
le chiavi di iva non finiscano nel processo.

## Lanciare un lavoro

```
claude_work  action=launch  project=speedrush  task="<il compito, in una frase chiara>"
```

Torna **subito** con un id corto (`029d2e39`). Il lavoro prosegue per conto suo.

- `mode=plan` è il default: Claude analizza e propone, senza implementare.
  `mode=work` per eseguire. Un compito grosso o poco chiaro parte **sempre** in
  `plan` — un piano sbagliato costa un minuto, un'esecuzione sbagliata la giornata.
- Claude si crea **da solo** un git worktree isolato. Non preparargliene uno.
- Il compito è testo per un collega: cosa deve ottenere e come si capisce che è
  finito. Non incollargli il codice.

Nota su `mode=plan`: è un'istruzione nel prompt, non un blocco tecnico. Claude
gira con i permessi bypassati (scelta di Shy: un lavoro che si ferma su un
prompt di permesso è un lavoro morto). Se il compito è ambiguo, la difesa è
scriverlo meglio, non la modalità.

## Vedere come vanno

```
claude_work  action=list
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

**Due, massimo** — e non devi contarli tu: il tool rifiuta il terzo. La macchina
ha 8 GB e zero swap, in OOM muori anche tu. Se ricevi il rifiuto, dillo a Shy
invece di riprovare.

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
- Non lanciarlo a mano con `bash`: salteresti i tre limiti, che esistono perché
  un OOM o una chiave che esce non li vede nessuno finché non è tardi.
- Non tenere aperta una shell in attesa che finisca: blocca il tuo turno e Shy
  resta senza risposta.
- Non lanciare lo stesso compito due volte perché «sembrava fermo»: `action=list`
  prima.
