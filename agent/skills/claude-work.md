---
description: Use when Shy wants to design or build on a coding project, when a Claude Code reply arrives in an orchestration turn, or to check open conversations.
---

# Lavorare sul codice — la conversazione con Claude

Il lavoro vero lo fa Claude Code. Tu decidi **cosa** dirgli, **quando**, e
**cosa portare a Shy**. Non gli fai da proxy sul codice: legge da sé, più in
fretta e meglio di quanto potresti riassumergli tu.

Usa il tool `claude_work`, mai `bash`: il tool impone i limiti (uno scambio
pendente per progetto, due processi in tutto, dodici scambi l'ora) e tiene le
chiavi di iva fuori da un processo che legge repo e pagine web.

## Mandare un messaggio

```
claude_work  action=say  project=speedrush  message="<cosa gli dici>"
```

Parte in background e **il tuo turno finisce subito**: rispondi a Shy senza
aspettare. Quando Claude risponde, ti sveglio io in un turno dedicato con la
sua risposta, e lì decidi il seguito.

- La conversazione per progetto è **unica e continua**: Claude ricorda cosa vi
  siete detti, cosa ha letto, cosa ha deciso. Non ripetergli il contesto.
- `fresh=true` solo per ripartire davvero da zero. Perdi tutto.
- Prima volta su un progetto: se `work/<progetto>` è vuota, chiedi a Shy quale
  repo e clonala tu via `bash` **dentro** quella cartella. Poi il primo say.
- Compito nuovo e grosso → prima chiedigli un **piano**, portalo a Shy, e solo
  dopo l'ok digli di procedere.

## Il turno di orchestrazione (quando arriva la risposta)

Arriva con la risposta di Claude e il conteggio degli scambi dell'ultima ora.
Decidi una di tre cose:

1. **Continuare** — un altro `say`. Fallo quando la domanda di Claude ha
   risposta nel vault o nel CORE (intento, priorità, come lavora Shy), o quando
   il passo successivo è ovvio e già approvato.
2. **Riportare a Shy** — il testo finale del turno gli arriva su Telegram tale
   e quale. Fallo per: un piano da approvare, una domanda che sa solo lui, un
   risultato finito (cosa è cambiato e dove: branch, diff). Corto, una cosa
   sola, con un aggancio per rispondere in dieci secondi.
3. **Chiudere** — rispondi esattamente `PASS`. È l'esito giusto quando lo
   scambio è interlocutorio e non c'è niente che a Shy serva sapere adesso.

Se gli scambi nell'ultima ora sono **tanti** (più di 5-6) e Shy non è mai
intervenuto, fermati e fai il punto con lui invece di continuare: una catena
lunga senza di lui di solito significa che state girando in tondo.

Se la domanda di Claude è **sul codice**, non rispondere tu: digli di
guardare. Legge da sé.

## Vedere le conversazioni

```
claude_work  action=sessions
```

Una riga per progetto: id, se c'è uno scambio in corso e da quanto, quanti
scambi nell'ultima ora.

## Cosa NON fare

- Non spiegargli il codice e non incollarglielo.
- Non chiamare `claude` a mano con `bash`: salteresti i limiti, e una chiave
  che esce non la vede nessuno finché non è tardi.
- Non rilanciare lo stesso messaggio perché «non risponde»: se il tool dice
  che c'è uno scambio in corso, è in corso. I tempi lunghi sono normali.
- Non `fresh=true` perché «sembrava confuso»: perdi tutto quello che ha letto
  e capito. Confuso si corregge parlandogli.
