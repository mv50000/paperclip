# ACPX, native runner ja claude_local — päätös ja portti

Päivitetty 2026-09-26 ([RK9-305](/RK9/issues/RK9-305), epic [RK9-303](/RK9/issues/RK9-303)).
Tämä dokumentti on `doc/UPSTREAM-UPGRADE.md`:n ACPX-osion sisältö. Linkitä se
sinne, kun RK9-304 on luonut osiorungon.

## Päätös

1. **`claude_local` pinnataan CLI-moottoriin** (forkin nykyinen `execute.ts`-polku)
   jokaisessa merge-portaassa, kunnes RK9-228-suoja on todistettu ACP-polulla.
   Pinnaus tehdään koodissa, ei datassa: forkin `resolveClaudeExecutionEngine`
   palauttaa `cli`, kun `engine` puuttuu. Agenttikohtainen `engine: "acp"` jää
   eksplisiittiseksi valinnaksi.
2. **`enableNativeRunner` pois** (`false`) forkin instanssiasetuksissa, kun
   asetus tulee mukaan (v2026.831.0). Upstreamin oletus kääntyy päälle
   v2026.916.0:ssa. Asetus koskee vain `paperclip_runner`-adapteria, joten se ei
   yksin käännä `claude_local`-laskutusta. Pidämme sen silti pois, koska emme
   aja Rust-runneria emmekä halua uutta spawn-polkua ennen kuin sen env on
   katselmoitu.
3. **Ei upstream-mergeä tässä tiketissä.** Tämä tiketti lukitsee nykyforkin
   käytöksen testeillä. Samat testit ajetaan jokaisessa merge-portaassa.

Perustelu: upstreamissa ei ole missään tagissa vastinetta forkin
`doNotInheritEnvKeys`-suojalle. ACP-polku päästää palvelimen
`ANTHROPIC_API_KEY`:n agentille tarkoituksella. Ilman pinnausta ensimmäinen
porras, joka tuo v2026.720.0:n, kääntäisi koko laivueen metered-laskutukselle
heti, kun palvelimen envissä on avain (sama vika kuin RK9-228: $19.72 / 38 ajoa
/ 31 h ja 1,5 vuorokauden katko).

## Spike: mitä upstream tekee (tagit v2026.427.0–v2026.916.1)

Todennettu paikallisista upstream-tageista komennoilla `git show <tag>:<polku>`.

| Tagi | Muutos | Vaikutus `claude_local`-ajoon |
|---|---|---|
| v2026.512.0 | Uusi erillinen adapteri `packages/adapters/acpx-local/` | Ei vaikutusta: `claude_local` ajaa yhä CLI:llä |
| v2026.609.0, v2026.707.0 | `acpx-local` jatkuu | Ei vaikutusta |
| **v2026.720.0** | ACP-moottori siirtyy `packages/adapter-utils/src/acpx-engine/`:iin. `claude_local` saa `engine`-kentän, oletus `acp`. Migraatio `0136_acpx_default_engine_migration.sql` kääntää `acpx_local`-rivit `claude_local`/`codex_local` + `engine: 'acp'`. | **Kriittinen porras.** Asettamaton `engine` ajaa ACP:llä. Jos ACP ei ole saatavilla, ajo putoaa hiljaa CLI:lle. |
| v2026.831.0 | `enableNativeRunner` tulee instanssiasetuksiin, oletus `false` | Ei vaikutusta `claude_local`-ajoon |
| v2026.916.0 | `enableNativeRunner` oletus `true`. `DEFAULT_CLAUDE_LOCAL_MODEL = "claude-opus-5"`. ACP-env muuttuu allowlistiksi. | Asettamaton malli ajaa Opus 5:llä. |
| v2026.916.1 | CLI-fallback poistuu: ilman ACP:tä ajo epäonnistuu (`adapter_engine_unavailable`) | Ilman pinnausta agentit pysähtyvät, jos `claude-agent-acp` puuttuu |

### Ohittaako ACPX host-env-suodattimen?

**Kyllä, kaikissa tageissa.**

- ACP-polku ei kutsu `runChildProcess`ia. Se käynnistää `claude-agent-acp`-binäärin
  ACP SDK:lla (`createAcpRuntime`, `acpx/runtime`).
- v2026.512.0–v2026.831.0: env on koko host-env
  (`acpx-local/src/server/execute.ts:787`
  `const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });`).
- v2026.916.0 alkaen env on allowlist (`projectAcpxInheritedHostEnvironment`),
  mutta `ACPX_INHERITED_PROVIDER_ENV_KEYS.claude` sisältää `ANTHROPIC_API_KEY`:n,
  `ANTHROPIC_AUTH_TOKEN`in ja `CLAUDE_CODE_OAUTH_TOKEN`in
  (`acpx-engine/execute.ts:578-581`).
- v2026.916.1:n `acp.ts` `resolveClaudeAcpBillingIdentity` lukee host-envin
  `ANTHROPIC_API_KEY`:n ja merkitsee ajon laskutustyypiksi `api`.
- Upstreamin CLI-polku (`runChildProcess`) ei myöskään suodata avainta: se
  poistaa vain `PAPERCLIP_*`- ja Claude Code -sisäkkäisyysmuuttujat.
  `doNotInheritEnvKeys` on vain forkissa.

Todentamatta: v2026.831.1:n ACP-env, tarkka tagi jossa CLI-fallback poistui
(v2026.817.0:n ja v2026.916.1:n välissä) ja CLI:n oma oletusmalli ennen
v2026.916.0:aa.

### Native runner

`enableNativeRunner` ohjaa Rust-pohjaista Paperclip Runneria. v2026.916.1:n
`server/src/services/native-runtime/runtime-mode.ts:106-116` palauttaa
`legacy` / `direct_adapter` jokaiselle adapterille paitsi `paperclip_runner`.
`claude_local` ei siis kulje native runnerin kautta.

## Mitä forkin pitää säilyttää merge-portaissa

Kaikki kohdat on merkitty koodiin kommentilla `// --- RK9 Custom (RK9-228) ...`.

- `packages/adapters/claude-local/src/server/host-env.ts` (koko tiedosto).
- `packages/adapter-utils/src/server-utils.ts`: `runChildProcess`in
  `doNotInheritEnvKeys`-optio ja sen suodatussilmukka.
- `packages/adapter-utils/src/execution-target.ts`: option läpivienti.
- `packages/adapters/claude-local/src/server/execute.ts` ja `test.ts`:
  `doNotInheritEnvKeys: hostEnvKeysNotInherited()` jokaisessa spawnissa.

Porraskohtaiset toimet:

- **Porras, joka tuo v2026.720.0:n:** muuta forkin `acp.ts`:n
  `normalizeEngine`-oletus arvoon `{ engine: "cli", explicit: false }` ja merkitse
  se RK9 Custom -kommentilla. Ilman tätä portin testit kaatuvat (ks. alla).
- **Porras, joka tuo v2026.831.0:n:** aseta `enableNativeRunner: false`
  instanssiasetuksiin ennen deployta.
- **Porras, joka tuo v2026.916.0:n:** päätä `DEFAULT_CLAUDE_LOCAL_MODEL`.
  Forkin nykyinen käytös on, ettei `--model`-lippua anneta, kun malli puuttuu.
  Testi `passes no --model when the agent has no model configured` kaatuu
  tarkoituksella, jos upstreamin oletus tulee voimaan. Jos oletus hyväksytään,
  sen on oltava `DEFAULT_ALLOWED_MODELS`-listalla (`risk-monitors.ts`).
- **ACP:n käyttöönotto myöhemmin:** poista `ANTHROPIC_API_KEY` (ja harkitse
  `ANTHROPIC_AUTH_TOKEN`) `ACPX_INHERITED_PROVIDER_ENV_KEYS.claude`-listalta, ellei
  `PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY` ole asetettu. Korjaa myös
  `resolveClaudeAcpBillingIdentity` käyttämään `inheritableHostEnv()`iä. Käytä
  `host-env.ts`:n funktioita, älä kirjoita toista suodatinta. Lisää silloin
  ACP-polulle vastaavat testit ennen pinnauksen poistoa.

## Portti: testit jokaisessa merge-portaassa

Aja worktreen juuressa ennen jokaisen portaan mergeä:

```sh
cd server && npx vitest run \
  src/__tests__/claude-local-execute.test.ts \
  src/__tests__/claude-local-adapter-environment.test.ts \
  src/__tests__/claude-local-adapter-billing-inheritance.test.ts \
  src/__tests__/risk-monitors.test.ts
```

Mitä testit lukitsevat:

- `claude-local-execute.test.ts`, describe
  `host ANTHROPIC_API_KEY is not inherited (RK9-228)`: oikea `execute()` spawnaa
  valeclauden, joka tallentaa saamansa envin. Palvelimen avain ei päädy
  lapselle, ja ajon `billingType` on `subscription`. Agentin oma avain ja
  opt-in toimivat. Jos `claude_local` alkaa ajaa ACP:llä, valeclaudea ei
  käynnistetä, capture-tiedosto puuttuu ja testit kaatuvat. Tämä on
  pinnauksen portti.
- `claude-local-adapter-environment.test.ts`, describe
  `claude_local hello probe environment`: sama sääntö hello-proben spawnille.
- `claude-local-adapter-billing-inheritance.test.ts`: env-apufunktioiden
  yksikkötestit (olemassa jo RK9-228:sta).
- `risk-monitors.test.ts`, describe `default model allow-list`: jokainen
  `DEFAULT_ALLOWED_MODELS`-malli löytyy `claude_local`-mallilistalta, ja lista
  sisältää `claude-opus-5-5`:n.

## Hyväksyntäehtojen täsmennykset

- **Opus 5.5 -malli:** `claude-opus-5-5` lisättiin mallilistaan
  (`packages/adapters/claude-local/src/index.ts`) ja drift allow-listiin jo
  PR #106:ssa. Tämä tiketti lisää niiden väliin testin, joka kaatuu, jos listat
  eriytyvät.
- **`CLAUDE_CODE_OAUTH_TOKEN`:** forkissa ei ole viittauksia tähän muuttujaan.
  Agentin Paperclip-auth kulkee näin: palvelin antaa ajon JWT:n `authToken`ina,
  ja `execute.ts` asettaa sen lapsen `PAPERCLIP_API_KEY`:ksi, ellei adapter
  config aseta omaa. `PAPERCLIP_API_URL` tulee `buildPaperclipEnv`istä
  (`PAPERCLIP_RUNTIME_API_URL` → `PAPERCLIP_API_URL` → `http://<listen host>:<port>`,
  oletus 3100). Clauden oma kirjautuminen on CLI:n tilaussessio
  (`CLAUDE_CONFIG_DIR`/`HOME`). `CLAUDE_CODE_OAUTH_TOKEN` tulee upstreamissa
  vasta ACP-polulle (v2026.916.1 `acp.ts:781-853`, auth-probe), joten se on uutta
  työtä ACP:n käyttöönoton yhteydessä. Testi
  `hands the agent the run JWT and the server's API URL` lukitsee nykyisen
  polun.
- **ACP-polun vastaava testi:** ACP-koodia ei ole forkissa. Testi kirjoitetaan
  samassa portaassa, jossa pinnaus puretaan (ks. yllä).
