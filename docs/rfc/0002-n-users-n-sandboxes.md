# RFC 0002 — N utenti = N sandbox: evizione RAM con lifecycle manager (pattern doma-bot + checkpoint gVisor)

| Field | Value |
|---|---|
| Status | Draft |
| Author | pi-durable containers maintainers |
| Date | 2026-10-16 |
| Target | `pi-durable-containers` (stack compose, `agent/`, nuovo `sandbox-manager`) |
| Related | RFC 0001; `RESEARCH/doma-bot/server/sandbox_manager/manager.py`; `RESEARCH/doma-bot/deploy/docker-compose.yml` |

## 1. Summary

Oggi il mapping route→agente è statico: tre service fissi (`agent-a/b/c`) dietro Caddy,
uno per route. Ogni container resta vivo anche quando l'utente non lo usa: la pausa
in-process (`DurableHarness`, `IDLE_MS`) chiude SQLite ma **tiene su il processo Node**,
quindi la RAM non torna mai al sistema. Scalare a N utenti = N container sempre accesi.

Proposta: prendere in prestito il **sandbox manager di doma-bot** (coda di azioni su DB
+ esecutore con docker socket + watchdog) e aggiungere due livelli di evizione che
rilasciano *totalmente* la RAM:

| Livello | Meccanismo | RAM rilasciata | Resume misurato | Requisito |
|---|---|---|---|---|
| L0 — pause in-process | `IDLE_MS` / `POST /pause` (già esiste) | no | **2–3 ms** | nessuno |
| L1 — `docker stop` (default) | processo ucciso, stato in SQLite WAL (pi-durable è già il checkpoint) | **sì, 100%** | **~440 ms** | immutabilità del volume `/data` |
| L2 — checkpoint gVisor (opzionale) | `runsc checkpoint` → container rimosso, immagine su disco | **sì, 100%** | ~2,4 s (processo vivo, FD inclusi) | runtime `runsc`, spec di restore, rete da riagganciare |

Con L1 come evizione di default, **N utenti = N sandbox** con RAM consumata solo dagli
utenti attivi: 50 utenti simultanei = **~3,1 GiB totali** (misurati), evizione di 40 in
~5 s, ripartenza di 40 in ~7 s.

> Nota di rettifica: in doma-bot **non esiste** gVisor né checkpoint. Il suo manager
> usa `docker stop/pause/restart/unpause` via coda Postgres. Il percorso gVisor qui
> sotto è stato misurato appositamente per questa RFC sul runtime `runsc` installato
> sulla macchina (release-20260216.0).

## 2. Stato attuale e perché non scala

```
caddy :18080 ── /a1 /a2 /a3 ──> agent-a/b/c (sempre up, ~63–116 MiB cad.)
```

- La pausa chiude harness + SQLite (`wal_checkpoint(TRUNCATE)`) ma il processo resta in
  ascolto: è il proxy ad avere bisogno di un endpoint vivo (nota già nel README).
- Il README stesso lo dice: *"Scaling a container to zero would work only with the
  proxy resolving a live address (for example a service mesh or an on-demand starter)"*.
  Questa RFC costruisce esattamente quell'on-demand starter.

## 3. Il meccanismo doma-bot (cosa prendiamo in prestito)

`doma-bot/server/sandbox_manager/manager.py` — cronjob Python **dentro** il server a2a,
con docker socket montato:

1. **Coda `sandbox_actions` su Postgres** (`stop|pause|restart|resume`) — canale di
   controllo unico, usato anche dai test e2e; claim FIFO, esito scritto sulla riga.
2. **Esecutore via docker CLI** (`docker stop/pause/restart/unpause`), timeout 120 s.
3. **Watchdog**: container running ma unhealthy da N cicli → enqueue `restart`
   (azione `auto`). Uno stop esplicito resta tale (mai resurrezione).
4. Zero dipendenze pip: `psql` + subprocess + stdlib.

Prendiamo: **coda di azioni persistente + esecutore con docker socket + watchdog +
invarianti** ("uno stop esplicito resta fermo"). Cambiamo: la coda non serve su
Postgres (questo stack non ha un DB condiviso) — la sostituiamo con SQLite nel
servizio attivatore (stessa tecnologia già in uso, stessa semantica FIFO).

## 4. Percorso gVisor (runsc) checkpoint/restore — misurazioni e verità

Ambiente: Docker nativo WSL2, runsc `release-20260216.0`, kernel 6.6, 20 core, 15,5 GiB.
Il daemon ha `experimental=false` e non c'è `criu` → `docker checkpoint` **non è
disponibile**; il checkpoint è stato eseguito con la CLI `runsc` contro il root di
stato di Docker (`--root /var/run/docker/runtime-runc/moby`), che è il modo in cui un
manager produttivo lo farebbe. Cosa è emerso (tutti dati verificati):

1. **Checkpoint di un container Docker runsc: funziona ed è veloce.**
   `runsc checkpoint --image-path … <cid>` su un agente reale con conversazione aperta
   (conv 1, 5 entries): **243–254 ms**, immagine **12–14,4 MB** su disco, sentry+gofer
   terminati, RAM completamente rilasciata, `runsc list` vuoto.
2. **Restore: il processo torna vivo identico.** Dopo il restore, dentro il sandbox
   PID 1 è di nuovo `node server.ts` con **22 FD aperti** (inclusi quelli di SQLite):
   lo stato in-memory — conversazione, harness, listener — è quello del freeze.
3. **Il restore richiede lo spec originale, ricostruito con precisione.** gVisor
   valida campo per campo il bundle di restore contro lo spec checkpoint-ato:
   `ociVersion`, mounts (incluso l'ordine), env, args (con l'entrypoint dell'immagine
   node), user+additionalGids, capabilities, sysctl, namespaces (cgroup incluso),
   seccomp, e la **root path assoluta di Docker**
   (`/var/lib/docker/rootfs/overlayfs/<cid>`). La soluzione funzionante: **catturare
   il `config.json` dal task dir di containerd mentre il container è vivo**
   (`/run/containerd/io.containerd.runtime.v2.task/moby/<cid>/config.json`) e
   ri-servire lo stesso rootfs (bind mount) allo stesso path. Un manager deve fare
   esattamente questo.
4. **La rete non si ripristina da sola.** Docker distrugge netns/endpoint quando il
   task muore; il netstack ripristinato ha i device ma nessun collegamento esterno
   (loopback interno incluso: `os.networkInterfaces()` vuota dal restore in poi).
   In pratica il manager deve ricreare l'endpoint (veth/netns pre-creati o
   `runsc` standalone con port-forward gestito). È il costo principale del L2 ed è
   il motivo per cui L2 resta opzionale.
5. **Vincoli scoperti**: `--network=host` incompatibile col checkpoint
   ("checkpoint not supported when using hostinet"); rootless vieta netstack;
   senza privilegi il checkpoint dei container Docker è inaccessibile
   (`/var/run/docker` è root-only) — l'esecutore deve girare in un contesto
   privilegiato (container col socket docker, come doma-bot).

## 5. Dati misurati (ambiente della RFC)

### 5.1 Peso per sandbox

| Configurazione | RAM | Note |
|---|---|---|
| 1 sandbox runc, boot freddo | 112,5 MiB | include page cache |
| 1 sandbox runc, conversazione aperta | 115–116 MiB | dopo `/prompt` |
| 1 sandbox **runsc (gVisor)** | 87–89 MiB | sentry ~54 MiB + gofer ~23 MiB (host) |
| Fleet 50 sandbox runc idle (harness chiuso) | **62,8 MiB mediana** | reclaim delle pagine fredce |
| Disco: immagine `pi-durable-agent` | 501 MB **condivisa** | una sola, per tutti gli N |
| Disco: stato per utente (conv 1, 5 entries) | **< 1 MB** | `session.sqlite` 4 KB + WAL 750 KB |
| Disco: checkpoint gVisor per sandbox (L2) | 12–14,4 MB | compressione `flate-best-speed` |

### 5.2 Throughput — 50 utenti in contemporanea

50 container `pi-durable-agent` (runc, rete `bench-rfc`, faux provider), load da host
con 50 worker concorrenti:

| Carico | Risultato |
|---|---|
| `GET /status` ×50 concorrenti, round freddo | 50 req in 735 ms (68 req/s) — attiva 50 harness da fermo |
| `GET /status` ×50 concorrenti, steady (round 2–5) | **24–25 ms/round → ~2.000 req/s** |
| `POST /prompt` ×50 concorrenti (turno completo con tool call `bash ls -la`) | **wall 263 ms, p50 209 ms → 190 turni/s** |
| RAM totale con 50 attivi | **3.141 MiB** (media 62,8) |
| Avvio fleet: 50 `docker run` (parallelo) → tutti healthy | **7 s** |

Con provider reale il collo di bottiglia diventa la latenza LLM, non la sandbox: il
turno locale (harness+tools+SQLite) è la parte sub-300 ms.

### 5.3 Latenza di resume a seguito di pausa

| Path di pausa → resume | Latenza misurata | RAM durante la pausa | Stato conservato in |
|---|---|---|---|
| L0 in-process (`POST /pause` → `GET /session`) | **2–3 ms** | trattenuta (~63–116 MiB) | SQLite chiusa correttamente |
| `docker pause` → `unpause` → health → `/session` | **57–61 ms** | trattenuta (~63 MiB) | RAM del processo (freezer) |
| L1 `docker stop` → `start` → healthy → `/session` | **430–450 ms** | **0 (rilasciata)** | SQLite WAL su volume |
| L1 evizione di massa: 40 `docker stop` paralleli | 4,8 s (≈120 ms/container) | −2,6 GiB restituiti | 〃 |
| L1 resume storm: 40 `docker start` → 50/50 healthy | **7 s** | — | conv 1, entries 5 verificati |
| L2 `runsc restore` → processo exec-ready | **2.310–2.480 ms** | **0 (rilasciata)** | immagine checkpoint (14 MB) |
| L2 `runsc checkpoint` (fase di pausa) | **243–254 ms** | — | 〃 |

Lettura onesta: con un agente **già durevole** (pi-durable, WAL per-entry), **L1 batte
L2 sul resume** (440 ms vs 2,4 s) e non ha i vincoli di spec/rete. L2 vince solo dove
serve congelare **stato di processo non persistito** (turni in-flight di workload
generici) o come tecnologiaInsurance per agenti non-durable.

## 6. Architettura proposta

```
                 host :18080
                     |
                +---------+
                |  caddy  |            strip /u/<id>, proxy_pass attivatore
                +----+----+
                     |
              +------+---------+        SQLite: code azioni + registro sandbox
              | sandbox-gw     |        (pattern doma-bot: claim FIFO, esiti)
              | (Node, attivo) |
              +------+---------+
                 |  docker socket (montato, come doma-bot)
     +-----------+---------------------------+
     | start/stop/inspect via docker CLI    |
     +-----------+---------------------------+
        |            |            |
    u<id> attiva  u<id> evicta  checkpoint L2 (runsc, opzionale)
    (RAM ~63MiB)  (RAM 0)       (RAM 0, immagine 14MB su disco)
```

### 6.1 Componenti

1. **`sandbox-gw`** (nuovo servizio, immagine node:24-slim + docker CLI): espone
   `/u/<id>/*` e per ogni richiesta: se il container `u<id>` è healthy → proxy;
   altrimenti enqueue `start` e attende healthy (timeout). È l'"on-demand starter"
   di cui al README. Caddy resta l'unico endpoint pubblicato.
2. **Registro/queue** in SQLite nel gateway (tabella `sandbox_actions` con
   `status pending/done/failed`, stessa semantica doma-bot). FIFO per idempotenza:
   due richieste concorrenti per lo stesso utente producono un solo `start`.
3. **Eviction policy per utente** (stati: `active → idle-paused (L0) → stopped (L1) →
   checkpointed (L2 opzionale)`):
   - `active`: richiesta in-flight o ultima attività < `IDLE_MS` (già gestito in-process);
   - dopo `STOP_AFTER_MS` da idle (default: 10 min) → enqueue `stop`;
   - dopo `CKPT_AFTER_MS` da stopped (default: 24 h, opzionale) → `runsc checkpoint`
     + `docker rm` (libera anche l'oggetto container; immagine su disco);
   - watchdog doma-bot: running ma unhealthy da N cicli → `restart` (mai su
     container esplicitamente fermati).
4. **On-demand resume**: `start` L1 (`docker start`, ~440 ms) di default;
   L2 restore se l'utente è checkpointato (ricrea l'endpoint di rete — vedi §6.3).

### 6.2 Cosa NON cambia

- L'agente (`agent/`) resta esattamente com'è: la sua durabilità SQLite è il
  fondamento di L1. Nessuna modifica a `server.ts`/`harness.ts`.
- I volumi `/workspace` e `/data` per utente restano named volume (L1 li preserva).
- `verify.sh` esteso, non riscritto.

### 6.3 Requisiti L2 (solo se abilitato)

- Container creati con `--runtime=runsc` e `--security-opt seccomp=unconfined`
  (il default seccomp di Docker rende lo spec di restore irriproducibile; gVisor è
  già il confinamento).
- `/workspace` e `/data` come **bind mount** con path stabili (entrambi finiscono
  nello spec di restore e devono ri-esistere identici).
- Il gateway cattura e conserva il `config.json` di containerd alla creazione
  (snapshot dello spec) e ri-servisce il rootfs allo stesso path assoluto.
- Rete: netns/veth gestiti dal gateway (container `--net=none` + veth manuale) oppure
  accettata la ri-creazione dell'endpoint al restore. **Da validare in un
  esperimento dedicato prima di abilitare L2 in produzione.**
- Esecutore con accesso al root di stato di Docker (privileged o socket + gid).

## 7. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Stop durante un turno in-flight | L0 resta la prima barriera: si evince solo dopo `IDLE_MS` con `inFlight=0` (invariante già garantita da `DurableHarness`); anche un kill -9 è sicuro per il WAL (verify.sh copre già il restart da hard stop) |
| Restart storm al risveglio mattutino di molti utenti | Start parallelo misurato: 40 container → 7 s; il gateway serializza per utente ma parallelizza tra utenti (limite configurabile) |
| RAM stimata per capacity planning | 63 MiB/utente attivo idle + ~52 MiB extra a caldo per conversazione aperta; budget: `utenti_attivi × 120 MiB` con margine |
| L2: spec/rete fragili tra versioni runsc | L2 dietro feature flag; test e2e dedicato come `e2e/tests/sandbox-manager.spec.ts` in doma-bot |
| Docker socket nel gateway = privilegi | Come doma-bot: servizio isolato nella rete interna, nessuna porta pubblicata, solo Caddy espone |

## 8. Milestone e verifica

1. **M1 — gateway + L1**: `sandbox-gw` con proxy + queue SQLite + `stop` dopo idle.
   Verify: 3 agenti creati a richiesta via `/u/<id>/prompt`, stop dopo idle, RAM a 0,
   ripresa con conversazione intatta (`entries` conservati), `requestId` idempotente.
2. **M2 — watchdog + osservabilità**: restart auto su unhealthy, stato per sandbox
   (`active/idle/stopped`), metriche RAM aggregate in `/status` del gateway.
3. **M3 (opzionale) — L2 gVisor**: flag `SANDBOX_RUNTIME=runsc`, snapshot spec,
   checkpoint dopo `CKPT_AFTER_MS`, restore con riaggancio rete. Verify: kill del
   container, RAM 0, immagine su disco, restore con PID 1 = `node server.ts` e FD
   aperti, `/session` con la stessa conversationId.

## 9. Appendice — riproduzione delle misure

Macchina: WSL2, 20 vCPU, 15,47 GiB RAM, kernel 6.6.87.2, dockerd nativo con runsc.
Agente: `pi-durable-agent:latest` (node:24-bookworm-slim, ~501 MB), faux provider.
Gli script del banco di prova sono nel repo in **`bench/`** (ordine d'uso e mapping
alle tabelle in `bench/README.md`): container lanciati su rete bridge `bench-rfc`, load
da host con 50 worker concorrenti; checkpoint via `runsc --root
/var/run/docker/runtime-runc/moby checkpoint` da container privilegiato di supporto
(`bench/gvisor-checkpoint-restore.sh`).
