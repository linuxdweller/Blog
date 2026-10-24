---
title: "No More LiteLLM API Keys: Auth with Kubernetes Service Accounts"
date: "2026-10-23"
tag: { displayName: "K8s", uriName: "k8s" }
description: ""
---

**This article is fully human written. No LLM was used to generate any of the text.**

Because I value your time, here is the result of this blog post: **a Kubernetes service account token is used to make a request to LiteLLM**:

![Exec into a pod, cat its ServiceAccount JWT, curl LiteLLM with it, get a real 200 response](/litellm-sa-auth.gif)

Do you see how there is no LiteLLM virtual key involved in the making of this request? Feel free to read the rest of the post to see why that is interesting.

## AI Gateways Are Weird

The weird thing with AI gateways is that they all generate API keys without expiration.

Take LiteLLM for example - API keys never expire, and OIDC / JWT auth is an enterprise feature (sigh).

Even if you are fine with the fact API keys never expire and still choose to use them, automating key creation in LiteLLM for each client can be pretty complex.

Still, companies do exactly that, while a much simpler (and more robust) solution exists, sitting in plain sight and waiting to be used.

## K8s Service Accounts Have Joined The Conversation

The solution to the above problem (and generally everything in life) is to use Kubernetes. Specifically, Kubernetes Service Accounts.

**If we make LiteLLM authentication work with service account tokens, our pods will be able to seamlessly make requests with them**.

There is a catch though: JWT authentication is an enterprise feature in LiteLLM, so we have to implement it ourselves as a custom auth plugin in Python.

It is not that hard though. Keep following for a vibecoded adventure on how to make that work.

## Working Example: Service Account Tokens As LiteLLM Virtual Keys

Let's just start with a fully working example: [a helm chart which deploys LiteLLM with a custom auth middleware for authenticating SA tokens](https://github.com/linuxdweller/litellm-sa-auth).

[The custom auth middleware](https://github.com/linuxdweller/litellm-sa-auth/blob/main/charts/litellm/templates/configmap-callbacks.yaml) does the following:

1. Verifies the bearer token against the Kubernetes API server's own JWKS endpoint (`/openid/v1/jwks`).
2. Checks the SA against an allowlist, deny by default.
3. Auto-creates a LiteLLM user for the SA on first request and sets its budget.
4. Falls through non-JWT callers to the existing master-key / virtual-key check.

```python
# Custom auth middleware.
import time

import httpx
import jwt
from jwt import InvalidTokenError
from jwt.algorithms import RSAAlgorithm

from litellm.proxy._types import UserAPIKeyAuth

JWKS_URL = "https://kubernetes.default.svc/openid/v1/jwks"
SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
JWKS_CACHE_SECONDS = 900
ISSUER = "{{ .Values.saAuth.issuer }}"
AUDIENCE = "{{ .Values.saAuth.audience }}"
# Deny-by-default allowlist: only these ServiceAccounts may
# authenticate via JWT. Empty = no SA is allowed (JWT auth is
# effectively off, not open) -- see values.yaml saAuth.allowedServiceAccounts.
ALLOWED_SERVICE_ACCOUNTS = frozenset([
    {{- range .Values.saAuth.allowedServiceAccounts }}
    "system:serviceaccount:{{ .namespace }}:{{ .name }}",
    {{- end }}
])

# Per-SA budget (USD) applied to the LiteLLM User auto-created for that SA
# on its first request -- see _ensure_sa_user_budget. None = no limit.
SA_MAX_BUDGETS = {
    {{- range .Values.saAuth.allowedServiceAccounts }}
    "system:serviceaccount:{{ .namespace }}:{{ .name }}": {{ if .maxBudget }}{{ .maxBudget }}{{ else }}None{{ end }},
    {{- end }}
}

# This pod's own default ServiceAccount is already authorized to read
# the cluster's /openid/v1/jwks (bound to system:serviceaccounts by
# k8s default, same as any other SA) -- no extra RBAC needed. Cached
# for JWKS_CACHE_SECONDS; the SA token itself is re-read from disk on
# every actual fetch since kubelet rotates it in place.
_jwks_cache = {"fetched_at": 0.0, "keys": {}}


def _load_jwks():
    now = time.monotonic()
    if _jwks_cache["keys"] and now - _jwks_cache["fetched_at"] < JWKS_CACHE_SECONDS:
        return _jwks_cache["keys"]
    try:
        with open(SA_TOKEN_PATH) as f:
            token = f.read().strip()
        resp = httpx.get(
            JWKS_URL,
            headers={"Authorization": f"Bearer {token}"},
            verify=SA_CA_PATH,
            timeout=5.0,
        )
        resp.raise_for_status()
        data = resp.json()
        _jwks_cache["keys"] = {k["kid"]: k for k in data.get("keys", [])}
        _jwks_cache["fetched_at"] = now
    except Exception:
        if not _jwks_cache["keys"]:
            raise
        # Transient fetch failure -- serve the stale cache rather than
        # fail every request; signing keys rotate rarely.
    return _jwks_cache["keys"]


def _verify_sa_jwt(token):
    header = jwt.get_unverified_header(token)
    jwk = _load_jwks().get(header.get("kid"))
    if jwk is None:
        raise InvalidTokenError(f"Unknown signing key id: {header.get('kid')}")
    public_key = RSAAlgorithm.from_jwk(jwk)
    return jwt.decode(
        token,
        key=public_key,
        algorithms=["RS256"],
        audience=AUDIENCE,
        issuer=ISSUER,
    )


async def _ensure_sa_user_budget(sub: str) -> None:
    """Create the LiteLLM User for this SA on first request and pin its
    max_budget to SA_MAX_BUDGETS[sub]. get_user_object(user_id_upsert=True)
    only applies litellm's one global default_internal_user_params on
    creation, so the per-SA figure still needs this explicit patch --
    plus a cache refresh, since the upsert call above already cached the
    pre-patch row under this user_id and common_checks() (called right
    after auth, per custom_auth_run_common_checks) would otherwise read
    that stale cached budget on this very request.
    """
    from litellm.proxy._types import LiteLLM_UserTable
    from litellm.proxy.auth.auth_checks import (
        _cache_management_object,
        _user_table,
        get_user_object,
    )
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_logging_obj,
        user_api_key_cache,
    )
    from litellm.repositories.user_repository import UserRepository

    user_obj = await get_user_object(
        user_id=sub,
        prisma_client=prisma_client,
        user_api_key_cache=user_api_key_cache,
        user_id_upsert=True,
        proxy_logging_obj=proxy_logging_obj,
    )
    budget = SA_MAX_BUDGETS.get(sub)
    if user_obj is not None and user_obj.max_budget != budget:
        await _user_table(UserRepository(prisma_client)).update(
            where={"user_id": sub},
            data={"max_budget": budget},
        )
        user_obj.max_budget = budget
        await _cache_management_object(
            key=sub,
            value=user_obj,
            user_api_key_cache=user_api_key_cache,
            proxy_logging_obj=proxy_logging_obj,
            model_type=LiteLLM_UserTable,
        )


async def user_api_key_auth(request, api_key: str) -> UserAPIKeyAuth:
    """Replaces LiteLLM's virtual-key auth with k8s ServiceAccount JWT
    verification for callers using their own SA identity. Non-JWT
    callers (the existing master/virtual key path) fall through to
    LiteLLM's own check unchanged -- see values.yaml saAuth.
    """
    token = api_key[len("Bearer ") :] if api_key.startswith("Bearer ") else api_key

    try:
        claims = _verify_sa_jwt(token)
    except Exception:
        # Not a valid SA JWT -- could be a plain LiteLLM key, a bad/
        # expired JWT, or a transient JWKS-fetch failure. Any of those
        # fall through to the key check below rather than hard-failing
        # here, same as a master/virtual key request would.
        claims = None

    if claims is not None:
        sub = claims["sub"]  # system:serviceaccount:<namespace>:<name>
        if sub not in ALLOWED_SERVICE_ACCOUNTS:
            raise Exception(f"ServiceAccount not authorized: {sub}")
        parts = sub.split(":")
        namespace = parts[2] if len(parts) == 4 else None
        await _ensure_sa_user_budget(sub)
        # Not team_id: that makes common_checks() look up a real
        # LiteLLM_TeamTable row for "namespace" and 404 the whole
        # request when none exists (we don't provision teams, only
        # per-SA Users). Record the namespace as plain metadata instead.
        return UserAPIKeyAuth(
            api_key=sub,
            user_id=sub,
            metadata={"namespace": namespace},
            jwt_claims=claims,
        )

    # Not a JWT -- validate against the master key / DB-backed virtual
    # keys ourselves. We can't call litellm's own user_api_key_auth()
    # here: it dispatches straight back to general_settings.custom_auth
    # (this very function), which is infinite recursion, not a fallback.
    import secrets

    from litellm.constants import LITELLM_PROXY_MASTER_KEY_ALIAS
    from litellm.proxy._types import LitellmUserRoles
    from litellm.proxy.proxy_server import litellm_proxy_admin_name, master_key

    if master_key and secrets.compare_digest(token, master_key):
        # user_role=PROXY_ADMIN is required for admin-only endpoints
        # (/user/info on another user, /user/delete, etc.) -- without
        # it the master key could call models but not manage users.
        # Mirrors litellm's own master-key UserAPIKeyAuth construction
        # (api_key aliased, never the raw master key, to keep it out of
        # spend logs/metrics labels).
        return UserAPIKeyAuth(
            api_key=LITELLM_PROXY_MASTER_KEY_ALIAS,
            user_id=litellm_proxy_admin_name,
            user_role=LitellmUserRoles.PROXY_ADMIN,
        )

    from litellm.proxy.auth.auth_checks import get_key_object
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_logging_obj,
        user_api_key_cache,
    )
    from litellm.proxy.utils import hash_token

    try:
        return await get_key_object(
            hashed_token=hash_token(token),
            prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache,
            proxy_logging_obj=proxy_logging_obj,
        )
    except Exception as e:
        raise Exception(f"Invalid LiteLLM API key: {e}")
```

[The chart has an E2E test which shows the full request path](https://github.com/linuxdweller/litellm-sa-auth/blob/main/tests/e2e/tests/test-sa-budget.sh) - a pod making authenticated requests using its whitelisted SA token until it reaches its budget.

```bash
#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-litellm}"
SA_NAME="${SA_NAME:-sa-jwt-test}"
SUB="system:serviceaccount:${NAMESPACE}:${SA_NAME}"
SVC_URL="${SVC_URL:-http://litellm.${NAMESPACE}.svc.cluster.local:4000}"
MODEL="${MODEL:-e2e-mock}"
BUDGET="${BUDGET:-0.01}"  # must match saAuth.allowedServiceAccounts[].maxBudget
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-litellm-master-key}"
MASTER_KEY_KEY="${MASTER_KEY_KEY:-masterKey}"
POD_NAME="sa-budget-test-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
# MAX_ATTEMPTS is computed after request 1 from its actual measured cost
# (budget / cost-per-call, +20% margin) -- the hammer loop then runs inside
# the pod in one kubectl exec to avoid per-call exec overhead at volume.

echo "== Fetching LiteLLM master key =="
MASTER_KEY=$(kubectl get secret "$MASTER_KEY_SECRET" -n "$NAMESPACE" -o jsonpath="{.data.${MASTER_KEY_KEY}}" | base64 -d)

cleanup() {
  echo "== Cleanup =="
  echo "-- deleting LiteLLM User ${SUB} (manual cleanup, admin API) --"
  kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
    curl -s -o /dev/null -w "user/delete status: %{http_code}\n" \
    -X POST "${SVC_URL}/user/delete" \
    -H "Authorization: Bearer ${MASTER_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_ids\": [\"${SUB}\"]}" || true
  echo "-- deleting pod ${POD_NAME} --"
  kubectl delete pod -n "$NAMESPACE" "$POD_NAME" --ignore-not-found --wait=false || true
}
trap cleanup EXIT

echo "== Creating test pod ${POD_NAME} (serviceAccountName=${SA_NAME}) =="
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${POD_NAME}
  namespace: ${NAMESPACE}
  labels:
    purpose: sa-budget-test
spec:
  serviceAccountName: ${SA_NAME}
  # The default automounted SA token's aud claim is the apiserver's default
  # audiences, not "litellm" -- custom_auth.py's jwt.decode(audience=AUDIENCE)
  # rejects it. Request a token scoped to the litellm audience instead.
  automountServiceAccountToken: false
  restartPolicy: Never
  volumes:
    - name: litellm-token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              audience: litellm
              expirationSeconds: 3600
  containers:
    - name: curl
      image: curlimages/curl:8.10.1
      command: ["sleep", "3600"]
      volumeMounts:
        - name: litellm-token
          mountPath: /var/run/secrets/litellm
EOF

echo "== Waiting for pod to be ready =="
kubectl wait -n "$NAMESPACE" "pod/${POD_NAME}" --for=condition=Ready --timeout=60s

call_litellm() {
  # -i includes response headers in the output -- some providers don't
  # embed "cost" in the JSON body, only in the x-litellm-response-cost
  # header, so extract_cost checks both.
  kubectl exec -n "$NAMESPACE" "$POD_NAME" -- sh -c '
    TOKEN=$(cat /var/run/secrets/litellm/token)
    curl -s -i -w "\n%{http_code}" -X POST "'"${SVC_URL}"'/chat/completions" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"'"${MODEL}"'\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":10}"
  '
}

extract_cost() {
  local c
  c=$(echo "$1" | grep -i '^x-litellm-response-cost:' | head -1 | awk '{print $2}' | tr -d '\r')
  if [ -z "$c" ]; then
    c=$(echo "$1" | grep -oE '"cost":[0-9.eE+-]+' | head -1 | cut -d: -f2)
  fi
  echo "$c"
}

user_info() {
  kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
    curl -s -X GET "${SVC_URL}/user/info" \
    -G --data-urlencode "user_id=${SUB}" \
    -H "Authorization: Bearer ${MASTER_KEY}"
}

echo "== Request 1: first call from ${SUB} =="
resp=$(call_litellm)
status="${resp##*$'\n'}"
body="${resp%$'\n'*}"
first_cost=$(extract_cost "$body")
echo "status=${status} cost=${first_cost}"

if [ "$status" != "200" ]; then
  echo "FAIL: first call did not succeed (status=${status})"
  echo "body=${body}"
  exit 1
fi

MAX_ATTEMPTS=$(python3 -c "
import math
cost = float('${first_cost:-0}' or 0)
budget = ${BUDGET}
if cost <= 0:
    print(50)
else:
    print(min(2000, max(10, math.ceil(budget / cost * 1.2))))
")
echo "measured cost/call=${first_cost} -> MAX_ATTEMPTS=${MAX_ATTEMPTS}"

echo "== Checking a LiteLLM User was auto-created =="
info=$(user_info)
if echo "$info" | grep -q "\"user_id\":\"${SUB}\"\|\"user_id\": \"${SUB}\""; then
  echo "PASS: User ${SUB} exists in LiteLLM"
else
  echo "FAIL: User ${SUB} not found after first request"
  echo "$info"
  exit 1
fi
echo "$info" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d.get('user_info',d); print('max_budget:', u.get('max_budget')); print('spend:', u.get('spend'))" || echo "$info"

echo "== Hammering the key until budget enforcement kicks in (max ${MAX_ATTEMPTS} attempts, run in-pod) =="
hammer_out=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- sh -c '
  TOKEN=$(cat /var/run/secrets/litellm/token)
  i=2
  while [ "$i" -le '"${MAX_ATTEMPTS}"' ]; do
    resp=$(curl -s -i -w "\n%{http_code}" -X POST "'"${SVC_URL}"'/chat/completions" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"'"${MODEL}"'\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":10}")
    code=$(echo "$resp" | tail -n1)
    body=$(echo "$resp" | sed "\$d")
    if [ "$i" = 2 ] || [ $(( i % 100 )) = 0 ]; then
      echo "attempt $i status=$code"
    fi
    case "$code" in
      400|429)
        case "$body" in
          *[Bb]udget*)
            echo "BUDGET_HIT at attempt $i"
            echo "$body"
            exit 0
            ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
  echo "NOT_HIT"
')
echo "$hammer_out"

if echo "$hammer_out" | grep -q "^BUDGET_HIT"; then
  echo "PASS: budget exceeded"
  budget_hit=true
else
  budget_hit=false
fi

if [ "$budget_hit" != "true" ]; then
  echo "FAIL: never hit budget enforcement within ${MAX_ATTEMPTS} attempts"
  user_info
  exit 1
fi

echo "== Final user state =="
user_info
echo
echo "All checks passed."
```

The test relies on a local Kind cluster which also runs a Postgres pod.
