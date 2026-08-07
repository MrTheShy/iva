---
description: Use when Shy wants to design or work on a coding project. Holds a running conversation with Claude Code, one per project.
---

# Lavorare sul codice — la conversazione con Claude

Il lavoro vero sul codice lo fa Claude Code, non tu. Tu decidi **cosa** chiedergli,
**quando**, e **cosa riportare a Shy**. Non gli fai da proxy sul codice: legge da
sé, più in fretta e meglio di quanto potresti riassumergli tu.

Usa il tool `claude_work`, non `bash`. Il tool impone le due cose che una frase
in un file non può garantire: dove una conversazione può girare, e che le chiavi
di iva non finiscano dentro un processo che legge repo e pagine web.

## Parlare con Claude

```
claude_work  action=say  project=speedrush  message="<cosa gli dici>"
```

La prima volta apre la conversazione; **tutte le volte dopo la riprende con
tutto il contesto di prima**. Per Claude è un unico discorso continuo: ricorda
cosa vi eravate detti, cosa ha già letto, cosa aveva deciso. Non ripetergli il
contesto.

- Torna la sua risposta. Se ti fa una domanda, **rispondi tu** se la risposta è
  nel vault o nel CORE — intento, priorità, come lavora Shy. Chiedi a Shy solo
  ciò che sa solo lui.
- Se la domanda è sul codice, non rispondere: digli di guardare. Legge da sé.
- `fresh=true` solo per ricominciare davvero da capo. Perdi tutto il contesto.
- Un compito nuovo e grosso: chiedigli **prima un piano**, poi lo porti a Shy,
  poi gli dici di procedere. Puoi anche mandargli `/plan` come messaggio.

**Un turno alla volta.** Mentre aspetti la risposta di Claude il tuo turno è
occupato e Shy non riceve nulla. Va bene per uno scambio di progettazione; per
un lavoro lungo digli cosa fare, lascialo andare e riprendi la conversazione
più tardi con un altro `say`.

Due progetti insieme: due conversazioni separate, una per turno. Ogni progetto
tiene la sua.

## Vedere quali sono aperte

```
claude_work  action=sessions
```

Un id per progetto. Una conversazione resta viva finché non usi `fresh=true`.

## Quante alla volta

**Una per volta**, per costruzione: uno scambio occupa il tuo turno finché non
torna. Due progetti si alternano fra un turno e l'altro, non nello stesso.

## Cosa riportare a Shy

- **Un piano** → glielo passi e aspetti che approvi. È il vero checkpoint.
- **Una domanda che sa solo lui** → gliela giri, con il contesto minimo per
  rispondere in dieci secondi.
- **Un risultato** → cosa è cambiato e dove guardarlo (worktree, branch, diff).
- **Niente di tutto questo** → non scrivere. Uno scambio interlocutorio con
  Claude non è una notizia.

## Cosa NON fare

- Non spiegargli il codice: lo legge lui. Se ti chiede dov'è una funzione, la
  risposta è «guardala», non incollargliela.
- Non chiamarlo a mano con `bash`: salteresti i limiti, e una chiave che esce
  non la vede nessuno finché non è tardi.
- Non ripetergli il contesto a ogni messaggio: la conversazione ce l'ha già.
- Non aprire una conversazione nuova (`fresh=true`) perché «sembrava confuso»:
  perdi tutto quello che ha già letto e capito.
