# RK9 Ads: dev instance for acceptance runs (RK9-849)

The rk9-motion acceptance run of [RK9-831] needs an RK9 Ads plugin that stages a
creative without a Meta upload. `localhost:3100` is prod, so the run uses a
separate dev Paperclip with its own embedded Postgres. The plugin runs with
`meta.stagingMode: "dry_run"` (README, "Dry-run staging").

## Isolation rules

- Port 3149, embedded Postgres 54349. Never use port 3100, `paperclip.service`
  or the shared Postgres on 5432.
- All state lives under `<worktree>/data/dev-rk9-849/` (gitignored): config,
  database, logs, storage, secrets key and `.env` (agent JWT secret).
- Write every path into `config.json` explicitly. The config schema defaults
  point at `~/.paperclip/instances/default/`, which is the prod instance home.
- Start the server with `env -i`. The operator shell carries prod
  `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`, and the dev server would pass
  them on to its agents.
- Pause every plugin job in the dev database after the install. The jobs
  (insights, spend guard, rules, smoke) would call Meta for an enabled brand.
  Dry-run staging covers only the creative ingress.
- No `telegram` block in the dev brand config: no bot polls and no message is
  sent. The Meta token is a fake company secret.
- The producer agent gets `RK9_MOTION_STATE` pointing to a dev state dir, so
  the run does not use up the prod ledger (daily cap, statement bank).
- Tool access is deny by default. An `allow` policy names the producer agent
  and `rk9-ads:rk9ads_stage_creative` only.

## Start

```sh
H=/tmp/paperclip-worktrees/RK9/RK9-849/data/dev-rk9-849
I=$H/instances/rk9-849
setsid nohup $H/start-dev.sh > $I/logs/dev-server.out 2>&1 < /dev/null &
curl -s http://127.0.0.1:3149/api/health | jq .status
```

`start-dev.sh` runs `pnpm dev:once` with `env -i`, `PAPERCLIP_HOME=$H`,
`PAPERCLIP_INSTANCE_ID=rk9-849`, `PAPERCLIP_CONFIG=$I/config.json`,
`PORT=3149`, `PAPERCLIP_TELEMETRY_DISABLED=1` and
`PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`. A fresh setup also needs these steps:

1. Install the plugin from the worktree build:
   `POST /api/plugins/install {"packageName": "<abs path>/packages/plugins/plugin-rk9-ads", "isLocalPath": true}`.
2. Pause its jobs: `UPDATE plugin_jobs SET status = 'paused'` (psql on
   `127.0.0.1:54349`, user and password `paperclip`; check `SHOW data_directory`
   first).
3. Create the company, a project, the fake secret, the brand config
   (`POST /api/plugins/<id>/config`), the agent, the tool policy and an agent
   key for `routine.sh`.

## Stop

Stop only this server's process group. Find the group id of `start-dev.sh`,
then send TERM to the group:

```sh
ps -eo pid,pgid,args | grep 'dev-rk9-849' | grep -v grep
kill -TERM -- -<pgid>
```

The data stays in `$H`. A restart with the same command keeps the company,
agent, routine and staged creative.

## Traps

- `onboard --yes` starts the server in the foreground and writes port 3100.
  Write the config by hand instead.
- A new company gets the prefix from its name (`SUN`), not from the
  `issuePrefix` field of the create call.
- `heartbeat.enabled: false` on the agent still lets the assignment wake start
  the run.
