#!/usr/bin/env bash
set -euo pipefail

token_file=/run/policy-monitor-acme-token
domain_file=/run/policy-monitor-acme-domain
record="_acme-challenge.${CERTBOT_DOMAIN}"

umask 077
printf '%s\n' "${CERTBOT_VALIDATION}" > "${token_file}"
printf '%s\n' "${record}" > "${domain_file}"

for _ in $(seq 1 120); do
    response=$(curl --fail --silent --show-error --max-time 5 \
        "https://dns.alidns.com/resolve?name=${record}&type=TXT" || true)
    if RESPONSE="${response}" EXPECTED="${CERTBOT_VALIDATION}" python3 -c \
        'import json, os, sys; payload=json.loads(os.environ["RESPONSE"]); expected=os.environ["EXPECTED"]; values=[str(item.get("data", "")).strip("\"") for item in payload.get("Answer", [])]; sys.exit(0 if expected in values else 1)'; then
        # Let secondary CA resolvers move past any cached negative response.
        sleep "${CERTBOT_PROPAGATION_WAIT:-180}"
        exit 0
    fi
    sleep 5
done

echo "Timed out waiting for ${record} TXT propagation" >&2
exit 1
