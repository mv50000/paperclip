# Agenttiajot omaan cgroup-lehteen (RK9-357)

RK9 Custom. Upstreamissa ei ole vastinetta. Upgrade-portaassa säilytä `agent-cgroup.ts` ja sen kutsut.

## Miksi

`paperclip.service` ajaa board-API:n ja kaikki agenttiajot samassa cgroupissa.
Palvelun `CPUWeight=50` hillitsee agenttilaivuetta, mutta se hidastaa myös boardia.
28.9.2026 issue-lista vei CPU-ruuhkassa noin 6 s.

Ratkaisu: palvelin ajaa lehdessä `server/` ja agenttiajot lehdessä `agents/`.
Lehtien painot ja muistirajat asetetaan erikseen.

## Miten

- Systemd-yksikkö (claude-config, `hosts/paperclip/paperclip-service`) asettaa `Delegate=yes` ja `DelegateSubgroup=server`.
  Käynnistysskripti luo `agents/`-lehden, kytkee `cpu memory pids` -ohjaimet ja asettaa `PAPERCLIP_AGENT_CGROUP`in.
- `packages/adapter-utils/src/agent-cgroup.ts`: `moveProcessToAgentCgroup(pid)` kirjoittaa PID:n tiedostoon `$PAPERCLIP_AGENT_CGROUP/cgroup.procs`.
  Sen jälkeen se nostaa lapsen `oom_score_adj`:n 500:aan, jotta palvelutason OOM valitsee agentin eikä palvelinta.
- Kirjoitus on synkroninen heti `spawn()`in jälkeen. `spawn()` palaa vasta, kun lapsi on exec'annut, joten siirto ehtii ennen lapsen ensimmäistä forkkia.
  Asynkroninen kirjoitus vaatisi event loop -kierroksia, ja kuormassa varhaiset jälkeläiset (MCP-palvelimet, bwrap-lapsi) jäisivät `server/`-lehteen.
- Synkroninenkin kirjoitus häviää kilpailun lapselle, joka forkkaa heti (`sh -c "a & b"`): forkki ehtii siirron odottaessa.
  Siksi siirron jälkeen helper haravoi palvelimen oman cgroupin ja siirtää prosessit, joiden vanhempiketju johtaa lapseen (enintään 3 kierrosta).
  Se ei koskaan siirrä palvelinprosessia eikä mitään lapsen alipuun ulkopuolelta. Todennettu CT 354:ssä: 5/5 ajossa heti forkatut lapsenlapset päätyivät `agents/`:iin.
- Hinta: cgroup-siirto odottaa RCU-jaksoa. CT 354:ssä 28.9.2026 (CPU-paine 92 %) p50 5 ms, p95 12 ms per kirjoitus; haravan kanssa 9–22 ms per spawn, samaa luokkaa kuin itse fork.
- Jälkeläiset perivät cgroupin ja `oom_score_adj`:n, joten yksi siirto per spawn riittää.
- `withoutAgentCgroupEnv(env)` poistaa muuttujan lapsilta, jotka saavat `process.env`:n suoraan. `runChildProcess` poistaa kaikki `PAPERCLIP_*`-muuttujat jo itse.

Kutsupaikat (kaikki merkitty `RK9 Custom (RK9-357)`):

| Tiedosto | Mitä siirretään |
|---|---|
| `packages/adapter-utils/src/server-utils.ts` `runChildProcess` | kaikki paikalliset adapterit, `process`-adapteri, execution target, local-process-sandbox, SSH-asiakas |
| `packages/adapter-utils/src/acpx-engine/execute.ts` `onAgentSpawn` | ACP-providerin lapsi (acpx spawnaa sen itse) |
| `server/src/services/native-runtime/native-codex-runner.ts` | native codex -runner |
| `server/src/services/workspace-runtime.ts` `spawnLocalRuntimeService` | workspace runtime -palvelut (dev-palvelimet, previewt) |
| `server/src/services/workspace-runtime.ts` `executeProcess` (`agentLoad: true`) | workspace-provision- ja seed-komennot (`pnpm install`, buildit) |
| `server/src/routes/board-chat.ts` | board-chatin `claude`-prosessi |

Muut spawnit (git, ssh-synkka, plugin-workerit, tool-gateway) jäävät `server/`-lehteen.
Ne ovat lyhytikäisiä tai osa palvelinta.

## Fail-open

- Muuttuja asettamatta: ei mitään, ei lokia. Upstream-käytös.
- Muuttuja asetettu, mutta alusta ei ole Linux, polku ei ole `/sys/fs/cgroup`in alla tai lehteä ei voi kirjoittaa:
  lapsi jää palvelimen cgroupiin, ja prosessi kirjoittaa yhden varoituksen per syy (`[agent-cgroup] ...`).
- Jos `oom_score_adj`:ia ei voi nostaa, siirto pätee silti; varoitus kerran. Arvo nostetaan ennen siirtoa (jälkeläiset perivät sen), mutta vasta kun lehden `cgroup.procs` on todettu kirjoitettavaksi. Asettamaton muuttuja, muu alusta tai kirjoitussuojattu lehti ei muuta lasta mitenkään. Jos kernel hylkää siirron vasta kirjoituksessa (EBUSY, EOPNOTSUPP), lapsi jää palvelimen cgroupiin arvolla 500: vain sen OOM-etusija muuttuu.
- `ESRCH` (lapsi ehti jo päättyä) ei ole virhe eikä tuota varoitusta.
- Apufunktio ei heitä. Testit: `packages/adapter-utils/src/agent-cgroup.test.ts`.

## Kill-polku ei riipu cgroupista

Peruutus ja timeout signaloivat prosessiryhmää (`process.kill(-pgid)`, `signalRunningProcess`).
Cgroup-siirto ei muuta prosessiryhmää. ACPX-lapsi tapetaan edelleen `child.kill("SIGKILL")`illa.
Palvelun stop ja restart tappavat koko delegoidun puun, koska `KillMode=control-group` (oletus) kattaa alicgroupit.
Todennettu CT 354:ssä ohimenevällä yksiköllä 28.9.2026: lehden prosessit kuolivat yksikön mukana, eikä orpoja jäänyt.

## Todennus deployn jälkeen

```sh
PID=$(systemctl show -p MainPID --value paperclip.service)
cat /proc/$PID/cgroup                     # 0::/system.slice/paperclip.service/server
cat /sys/fs/cgroup/system.slice/paperclip.service/agents/cgroup.procs   # agenttiajojen PID:t
grep agent-cgroup /var/log/paperclip.log  # tyhjä = ei fail-open-varoitusta
```
