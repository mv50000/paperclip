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
  Kirjoitus on asynkroninen, jotta cgroup-siirto ei pysäytä event looppia.
- Jälkeläiset perivät cgroupin, joten yksi siirto per spawn riittää.

Kutsupaikat (kaikki merkitty `RK9 Custom (RK9-357)`):

| Tiedosto | Mitä siirretään |
|---|---|
| `packages/adapter-utils/src/server-utils.ts` `runChildProcess` | kaikki paikalliset adapterit, `process`-adapteri, execution target, local-process-sandbox, SSH-asiakas |
| `packages/adapter-utils/src/acpx-engine/execute.ts` `onAgentSpawn` | ACP-providerin lapsi (acpx spawnaa sen itse) |
| `server/src/services/native-runtime/native-codex-runner.ts` | native codex -runner |
| `server/src/services/workspace-runtime.ts` `spawnLocalRuntimeService` | workspace runtime -palvelut (dev-palvelimet, previewt) |
| `server/src/routes/board-chat.ts` | board-chatin `claude`-prosessi |

Muut spawnit (git, ssh-synkka, plugin-workerit, tool-gateway) jäävät `server/`-lehteen.
Ne ovat lyhytikäisiä tai osa palvelinta.

## Fail-open

- Muuttuja asettamatta: ei mitään, ei lokia. Upstream-käytös.
- Muuttuja asetettu, mutta alusta ei ole Linux, polku ei ole `/sys/fs/cgroup`in alla tai lehteä ei voi kirjoittaa:
  lapsi jää palvelimen cgroupiin, ja prosessi kirjoittaa yhden varoituksen (`[agent-cgroup] ...`).
- `ESRCH` (lapsi ehti jo päättyä) ei ole virhe eikä tuota varoitusta.
- Apufunktio ei heitä eikä hylkää lupausta. Testit: `packages/adapter-utils/src/agent-cgroup.test.ts`.

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
