# Iva sente — stato affettivo, salienza in memoria, presenza

Data: 2026-08-07 · Stato: approvato dal proprietario · Origine: analisi del progetto
Amadeus-AI-Fan-Project (prompt-ensemble + memoria a salienza), ridotto a ciò che paga.

## 1. Obiettivo

1. **Efficienza dell'assistente** — ricorda meglio, richiama la cosa giusta al momento
   giusto, non perde i fili aperti, non spreca l'attenzione del proprietario.
2. **Fun of using** — usarla è un piacere: una presenza che si sente viva, non un form
   con la voce.

Ogni componente paga su almeno uno dei due assi, o non entra:

| Componente                                    | Efficienza                             | Fun                |
| --------------------------------------------- | -------------------------------------- | ------------------ |
| Salienza + relevance nel recupero + rinforzo  | richiamo preciso, il rumore decade     | —                  |
| Mood → tono (energia bassa = risposte sobrie) | meno fronzoli quando serve concretezza | la senti «vera»    |
| Chiusura-consapevole nel heartbeat            | follow-up calibrati, niente spam       | presenza           |
| Curiosità + reminiscenza                      | i fili aperti non muoiono              | «si ricorda di me» |
| Digest per salienza                           | il focus del giorno è quello giusto    | —                  |
| «Come stai?» onesto                           | —                                      | gratis dallo stato |
| Avatar-umore sul watch                        | —                                      | fase 2, solo fun   |

**Principio guida** (del proprietario): l'iniziativa di Iva serve il suo benessere, mai
il bisogno della macchina. Premurosa sì, «mi manchi» mai. Umore dichiarabile se
richiesto, non teatrale.

## 2. Cosa NON si prende da Amadeus (deliberato)

- I 12 «moduli cerebrali» paralleli: 13 chiamate a messaggio, rumore di classificatori
  piccoli, zero test. Collassati a **una** chiamata di appraisal per turno.
- Il doppio spazio di stato emozioni ↔ neurotrasmettitori: un solo spazio, 3 scalari.
- La rete «hebbiana» (keyword hardcoded): FTS5 + grafo + embeddings esistenti sono
  superiori.
- Il rifiuto delle chiamate / teatro tsundere: antifeature per un'assistente.

## 3. Stato affettivo persistente — `data/mood.json`

Tre scalari 0–100, baseline 50. Vivono **fuori dalla finestra di contesto**: il dialogo
non può convincerli a parole, li muovono solo le regole.

| Scalare     | Sale con                                   | Scende con                       | Guida                                     |
| ----------- | ------------------------------------------ | -------------------------------- | ----------------------------------------- |
| `calore`    | chiusure calde, risposte ai follow-up      | chiusure pesanti, ghosting lungo | tono generale, quanta iniziativa          |
| `energia`   | scambi leggeri/entusiasti del proprietario | giorni di scambi stanchi         | bassa → sobria e concreta, niente battute |
| `curiosita` | assenza + temi aperti non chiusi           | quando se ne riparla             | reminiscenza, «poi com'è andata?»         |

Forma del file:

```json
{
  "calore": 50,
  "energia": 50,
  "curiosita": 50,
  "updatedAt": 1754600000000,
  "ultimaChiusura": {
    "tono": "calda",
    "at": 1754600000000,
    "temaAperto": "trasloco"
  }
}
```

- Accesso col pattern `withState()` di `scripts/heartbeat.ts:52-62` (`agent/lib/json-store.ts`:
  lock + `loadJsonStrict` + `saveJsonAtomic`). Due scrittori previsti: hook di fine turno
  e tick heartbeat.
- Le **regole sono funzioni pure** in `scripts/lib/mood.ts`, testate senza filesystem:
  - `applyAppraisal(mood, {valenza, intensita, chiusura, temaAperto})`:
    `calore += 8·valenza·intensita`; `energia += 10·valenza·intensita`;
    parlare scarica la curiosità (−15, floor 30); `temaAperto` la alza (`max(curiosita, 60)`);
    tutto clampato 0–100.
  - `applyDecay(mood, ore)`: ritorno a baseline 50 con emivita 48 h
    (`x = 50 + (x−50)·0.5^(ore/48)`).
  - `applyAbsence(mood, oreDiSilenzio)`: oltre 12 h di silenzio la curiosità sale
    (+2/h, cap 85) **solo se** `calore ≥ 40` — una relazione fredda non accumula ansia.
- Kill-switch: `settings.mood.enabled` (default **true**), letto al momento dell'uso.

## 4. Appraisal — `agent/hooks/appraisal.ts`

L'ensemble di Amadeus collassato a una chiamata. Hook eve su `turn.completed`
(pattern `agent/hooks/transcript.ts`: side-effect su file, mai fatale per il turno),
**solo per i turni di chat** (non heartbeat, non digest, non rollup).

- Una chiamata piccola sullo stesso provider configurato (pattern `agent/vision.ts`,
  degrada in silenzio a no-op se il modello non c'è), JSON stretto:

  ```json
  { "valenza": -1..1, "intensita": 0..1, "chiusura": "calda|neutra|pesante", "temaAperto": "string|null" }
  ```

- Applica `applyAppraisal` e salva `ultimaChiusura` in `data/mood.json`.
- Costo: +1 mini-chiamata per turno di chat. Nessun'altra chiamata in tutto il design.

## 5. Iniezione nel prompt — `agent/instructions/30-mood.ts`

Strato dinamico su `turn.started`, forma di `now.ts` (path relativi a cwd, poche righe
di fs inline). Produce due righe:

1. lo stato: `calore 62/100 · energia percepita 38/100 (bassa: tono sobrio e concreto) ·
curiosità 71/100 — tema aperto: «trasloco»`;
2. la regola d'uso: colora il tono senza dichiararlo, un accenno spontaneo solo se
   naturale; se il proprietario chiede «come stai?» rispondi da questo stato con onestà.

File mancante, corrotto o `mood.enabled=false` → stringa vuota, zero iniezione.
Lo stato sta sul server: Telegram, telefono e watch mostrano la stessa Iva, gratis.

## 6. Salienza in memoria — tre diff chirurgici

Il decadimento Ebbinghaus esiste già (autograph: `relevance`, `tier`, `access_count`,
decay notturno dal doctor). Oggi però **non tocca il richiamo** (`memory_search` ignora
`relevance`/`tier`) e **il richiamo non rinforza** (`engine.py touch` non è chiamato da
nessuno). Si chiudono i buchi e si aggiunge la salienza:

1. **Scrittura** — frontmatter `salience: 0..1` sulle carte (assente = 0.3). Lo assegna
   il dbrain-processor notturno: ~0.8 eventi emotivamente forti e decisioni che pesano,
   ~0.5 fatti medi, ~0.2 routine. `salience` va dichiarato nei system fields dello
   schema perché `enforce` non lo tocchi.
2. **Decadimento** — in `calc_relevance` (`scripts/autograph/common.py:627`) la salienza
   rallenta il decay: `rate_effettivo = rate / (1 + 2·salience)`. La «soglia di
   recupero» emerge da sola: relevance bassa = punteggio soppresso finché i richiami
   non la risollevano (`touch` già graduato: un tier per volta).
3. **Recupero** — `agent/tools/memory_search.ts`: caricare `relevance` e `salience` nel
   `Doc` e pesare lo score finale `× (0.6 + 0.4·relevance) × (1 + 0.3·salience)`
   (accanto all'attuale malus `stale ×0.3`). Inoltre i path dei top-3 risultati vanno
   accodati a `data/memory-touch.jsonl` (append, fire-and-forget); il doctor notturno li
   consuma deduplicati con `engine.py touch` e tronca il file — **il richiamo rinforza**.

## 7. Heartbeat che sente — `scripts/heartbeat.ts`

- Al claim del tick: `applyDecay` sul tempo dall'ultimo aggiornamento e `applyAbsence`
  sul silenzio della chat (entrambi già misurabili lì), poi salvataggio.
- Il prompt del tick riceve tre righe nuove: umore attuale; **come si è chiusa l'ultima
  conversazione** (`ultimaChiusura` — il dato che oggi manca del tutto); un eventuale
  **ricordo riaffiorato** da `engine.py creative` esteso con `--min-salience 0.6`.
- La reminiscenza è libera (decide il modello, tick per tick) col criterio scritto nel
  prompt: _riapri un filo se riaprirlo è utile a lui, non per riempire il silenzio_.
  La scala anti-assillo esistente di `agent/skills/heartbeat.md:56-68` resta l'arbitro.
- `agent/skills/heartbeat.md` guadagna: il principio del benessere (premurosa sì,
  bisognosa mai), l'uso della chiusura per calibrare il tono del follow-up.

## 8. Digest per salienza

Una riga in `agent/skills/morning-digest.md`: se esiste un ricordo non risolto ad alta
salienza, può diventare la frase di focus del giorno. L'ordinamento dei task non cambia.

## 9. Fase 2 (fuori da questa spec)

Espressione dell'avatar sul watch pilotata dall'umore: `GET /eve/v1/app/mood` (bearer),
il watch sceglie il frame idle (worried/pleasant/angry estraibili dal modello Live2D
come già fatto per i sei frame attuali). Solo fun: si fa quando la spina dorsale è viva.

## 10. Verifiche

- `scripts/lib/mood.test.ts`: regole pure — applicazione appraisal, decadimento,
  accumulo da assenza (con e senza calore ≥ 40), clamp, curiosità che si scarica.
- Test di `memory_search`: a parità di BM25, salience alta vince; relevance bassa
  sopprime; il file di touch riceve i top-3.
- Heartbeat: `--dry` stampa umore, chiusura e ricordo riaffiorato senza inviare.
- Appraisal: turno senza modello configurato → mood.json intatto, turno normale →
  aggiornato (test sul modulo di parsing/applicazione, la chiamata è il pattern vision).

## 11. Coordinamento e vincoli

- `scripts/memory/doctor.ts` e le istruzioni dbrain hanno modifiche concorrenti non
  committate di un'altra sessione: l'implementazione si rebasa su quelle, non le
  sovrascrive.
- Tutto ciò che tocca `agent/` richiede `npm run build` (`AGENTS.md`): eve non
  ricompila da solo.
- Nessuna nuova dipendenza. Nessun nuovo processo. Un solo nuovo file di stato
  (`data/mood.json`), un solo nuovo log (`data/memory-touch.jsonl`).
