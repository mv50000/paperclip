#!/bin/bash
# io-watch.sh — continuously sample nvme0n1 IO-pressure and post Slack alerts to
# #all-rk9 ONLY on SUSTAINED latency pressure (confirmed edge + hysteresis recovery),
# plus a throttled reminder while sustained.
#
# Tuning history:
#  - 2026-05-23 disk fill (85%) drove nvme0n1 w_await to 5690ms / util 87%, queueing
#    every Claude instance's file IO. This alarm watches that the pressure stays gone.
#  - 2026-06-17 RECALIBRATED: the original `await>5ms OR util>85%` single-sample edge
#    trigger produced ~1235 flap-pairs (firing at util 2-17% on 5-7ms write blips;
#    peak-ever await 147ms = 38x below the real incident). Now: LATENCY-ONLY trigger
#    (r_await/w_await > WARN_AWAIT, default 200ms), require WARN_CONSEC consecutive
#    pressure samples before alerting, and OK_CONSEC consecutive OK samples before
#    declaring recovery (hysteresis). util + aqu are kept in the message text as
#    context, NOT as triggers (util~100% on NVMe is normal throughput, not latency).
#
# Run by the paperclip-io-watch.service systemd unit (User=paperclip), which supplies
# DATABASE_URL + PAPERCLIP_SECRETS_MASTER_KEY_FILE for the Slack helper. Every sample
# is logged to $LOG; only confirmed edge events hit Slack.
set -u
DEV=nvme0n1
LOG=${IO_WATCH_LOG:-/var/lib/paperclip/io-watch.log}
SERVER_DIR=${PAPERCLIP_SERVER_DIR:-/opt/paperclip/server}
WARN_AWAIT=${IO_WATCH_WARN_AWAIT:-200}   # ms — r_await OR w_await above this = pressure
SAMPLE=${IO_WATCH_SAMPLE:-15}            # s between samples
WARN_CONSEC=${IO_WATCH_WARN_CONSEC:-4}   # consecutive pressure samples before alerting (~60s)
OK_CONSEC=${IO_WATCH_OK_CONSEC:-3}       # consecutive OK samples before recovery (~45s)
REMIND=${IO_WATCH_REMIND:-1800}          # s between reminders while sustained WARN
HOST=$(hostname -s 2>/dev/null || echo paperclip-01)

post_slack() {  # $1 = message text — fire-and-forget so sampling never blocks
  ( cd "$SERVER_DIR" && pnpm tsx scripts/io-watch-alert.ts "$1" \
      >>"$LOG.slack" 2>&1 ) &
}

echo "# io-watch alkoi $(date -Is) — kynnys await>${WARN_AWAIT}ms, vahvistus ${WARN_CONSEC} näytettä, recovery ${OK_CONSEC} näytettä, näyte ${SAMPLE}s (PID $$)" >>"$LOG"

state=OK
last_alert=0
warn_streak=0
ok_streak=0
while true; do
  # iostat -x SAMPLE 2 -> second row is the live SAMPLE-second average
  line=$(iostat -x "$SAMPLE" 2 "$DEV" 2>/dev/null | awk -v d="$DEV" '$1==d{l=$0} END{print l}')
  if [ -z "$line" ]; then
    echo "$(date '+%F %T')  (ei iostat-dataa)" >>"$LOG"; sleep "$SAMPLE"; continue
  fi
  r_await=$(echo "$line" | awk '{print $6}')
  w_await=$(echo "$line" | awk '{print $12}')
  aqu=$(echo "$line" | awk '{print $(NF-1)}')
  util=$(echo "$line" | awk '{print $NF}')
  now=$(date +%s)

  # Pressure = disk LATENCY above threshold. util/aqu are context only, never triggers.
  if awk "BEGIN{exit !(${r_await:-0}+0>$WARN_AWAIT || ${w_await:-0}+0>$WARN_AWAIT)}"; then
    pressure=1; warn_streak=$((warn_streak+1)); ok_streak=0
  else
    pressure=0; ok_streak=$((ok_streak+1))
    [ "$state" = OK ] && warn_streak=0   # building counter resets on any OK while not yet WARN
  fi

  flag=""
  msg="🔴 $HOST levy-IO-paine: $DEV w_await=${w_await}ms r_await=${r_await}ms aqu=${aqu} util=${util}% (kynnys await>${WARN_AWAIT}ms × ${WARN_CONSEC} näytettä)"
  if [ "$state" = OK ]; then
    if [ "$pressure" = 1 ] && [ "$warn_streak" -ge "$WARN_CONSEC" ]; then
      state=WARN; last_alert=$now; flag="  <<< WARN (vahvistettu)"
      post_slack "$msg"
      echo "$(date '+%F %T')  -> SLACK (uusi WARN, ${warn_streak} näytettä)" >>"$LOG"
    elif [ "$pressure" = 1 ]; then
      flag="  <<< paine (${warn_streak}/${WARN_CONSEC}, ei vielä hälytystä)"
    fi
  else  # state=WARN
    if [ "$pressure" = 0 ] && [ "$ok_streak" -ge "$OK_CONSEC" ]; then
      state=OK; warn_streak=0
      post_slack "🟢 $HOST levy-IO palautui normaaliksi: $DEV w_await=${w_await}ms r_await=${r_await}ms util=${util}%"
      echo "$(date '+%F %T')  -> SLACK (palautui, ${ok_streak} OK-näytettä)" >>"$LOG"
    elif [ "$pressure" = 1 ] && [ $((now - last_alert)) -ge "$REMIND" ]; then
      last_alert=$now; flag="  <<< WARN (jatkuu)"
      post_slack "⏳ (jatkuu) $msg"
      echo "$(date '+%F %T')  -> SLACK (muistutus)" >>"$LOG"
    elif [ "$pressure" = 1 ]; then
      flag="  <<< WARN (jatkuu)"
    else
      flag="  <<< toipuu (${ok_streak}/${OK_CONSEC})"
    fi
  fi

  printf '%s  r_await=%sms w_await=%sms aqu=%s util=%s%%%s\n' \
    "$(date '+%F %T')" "$r_await" "$w_await" "$aqu" "$util" "$flag" >>"$LOG"
done
