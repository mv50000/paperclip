#!/usr/bin/env bash
# Deploys the rk9-ses-forwarder Lambda's code: index.mjs, routing.mjs and the
# routing table routes.json. No node_modules are bundled: the nodejs20.x Lambda
# runtime already provides @aws-sdk/client-s3 and @aws-sdk/client-ses
# (confirmed by inspecting the deployed zip). Requires an authenticated AWS
# session (aws sts get-caller-identity), e.g. AWS_PROFILE=rk9-admin.
#
# Before uploading, the script
#   1. validates routes.json (an invalid table would make every routed message fail),
#   2. saves the currently deployed code and configuration to $BACKUP_DIR
#      (default ~/rk9-mail-backup/<UTC timestamp>/) for rollback.
# It never changes the function's environment variables: see README.md for the
# domain-at-a-time rollout (ROUTED_DOMAINS) and rollback.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FUNCTION_NAME="rk9-ses-forwarder"
FILES=(index.mjs routing.mjs routes.json)
BACKUP_DIR="${BACKUP_DIR:-$HOME/rk9-mail-backup/$(date -u +%Y-%m-%dT%H%M%SZ)}"

node --input-type=module -e '
  import fs from "node:fs";
  import { parseRoutes } from "./routing.mjs";
  const c = parseRoutes(JSON.parse(fs.readFileSync("routes.json", "utf8")));
  const dests = [...new Set([...c.targets.values()].flat())];
  console.log(`routes.json OK: ${c.exact.size} exact + ${c.prefixes.length} prefix routes, default=${c.defaultTarget}, destinations=${dests.join(",")}`);
'

mkdir -p "$BACKUP_DIR"
aws lambda get-function-configuration --function-name "$FUNCTION_NAME" > "$BACKUP_DIR/lambda-config-BEFORE.json"
aws lambda get-function --function-name "$FUNCTION_NAME" --query Code.Location --output text \
  | xargs curl -sf -o "$BACKUP_DIR/lambda-code-BEFORE.zip"
echo "Backup: $BACKUP_DIR (lambda-code-BEFORE.zip, lambda-config-BEFORE.json)"

ZIP="$(mktemp -d)/function.zip"
zip -qj "$ZIP" "${FILES[@]}"
echo "Uploading $ZIP (${FILES[*]}) to $FUNCTION_NAME ..."
aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://$ZIP" > /dev/null
rm -f "$ZIP"
echo "Done. Verify: aws lambda get-function --function-name $FUNCTION_NAME --query Configuration.LastModified"
echo "Rollback:     aws lambda update-function-code --function-name $FUNCTION_NAME --zip-file fileb://$BACKUP_DIR/lambda-code-BEFORE.zip"
