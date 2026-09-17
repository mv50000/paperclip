#!/usr/bin/env bash
# Deploys index.mjs as the rk9-ses-forwarder Lambda's code. No node_modules are
# bundled: the nodejs20.x Lambda runtime already provides @aws-sdk/client-s3
# and @aws-sdk/client-ses (confirmed by inspecting the currently deployed zip,
# which likewise contains only index.mjs). Requires an authenticated AWS
# session (aws sts get-caller-identity).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FUNCTION_NAME="rk9-ses-forwarder"
ZIP="$(mktemp -d)/function.zip"

zip -qj "$ZIP" index.mjs
echo "Uploading $ZIP to $FUNCTION_NAME ..."
aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://$ZIP"
rm -f "$ZIP"
echo "Done. Verify: aws lambda get-function --function-name $FUNCTION_NAME --query Configuration.LastModified"
