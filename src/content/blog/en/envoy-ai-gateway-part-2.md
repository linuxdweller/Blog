---
title: "Agent Router: A K8s Native AI Gateway (Part 2)"
date: "2026-09-23"
tag: { displayName: "K8s", uriName: "k8s" }
description: "Operating an AI gateway entirely with GitOps and K8s Custom Resources"
---

## (Part 2) Defining Routes And API Keys

In this example, the gateway is connected to both Gemini and OpenRouter.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: gateway
  namespace: ai-gateway
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  gatewayClassName: envoy
  listeners:
    - name: https
      hostname: ai.lab.linuxdweller.com
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - group: ""
            kind: Secret
            name: gateway-tls
      allowedRoutes:
        namespaces:
          from: All
```

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: gemini
  namespace: ai-gateway
spec:
  endpoints:
    - fqdn:
        hostname: generativelanguage.googleapis.com
        port: 443
---
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: gemini-tls
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.envoyproxy.io
      kind: Backend
      name: gemini
  validation:
    wellKnownCACertificates: System
    hostname: generativelanguage.googleapis.com
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: gemini
  namespace: ai-gateway
spec:
  schema:
    name: OpenAI
    prefix: /v1beta/openai
  backendRef:
    name: gemini
    kind: Backend
    group: gateway.envoyproxy.io
```

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: gemini
  namespace: ai-gateway
spec:
  parentRefs:
    - name: gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: gemini-3.1-flash-lite
      backendRefs:
        - name: gemini
          modelNameOverride: gemini-3.1-flash-lite
          priority: 0
          weight: 1
      modelsOwnedBy: Envoy AI Gateway
    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: qwen/qwen3.8-flash
      backendRefs:
        - name: openrouter
          modelNameOverride: qwen/qwen3.8-flash
          priority: 0
          weight: 1
      modelsOwnedBy: Envoy AI Gateway
  llmRequestCosts:
    - metadataKey: llm_input_token
      type: InputToken
    - metadataKey: llm_cached_input_token
      type: CachedInputToken
    - metadataKey: llm_output_token
      type: OutputToken
    - metadataKey: llm_total_token
      type: TotalToken
```

Generate a consumer key for the agent and define rate limiting for it based on the expected usage and your budget.

This defines two 48 character keys, `agent-sandbox-gemini-token` and `swe-bench-token`, using external secrets operator Password generator.

```yaml
apiVersion: generators.external-secrets.io/v1alpha1
kind: Password
metadata:
  name: agent-sandbox-gemini-token
  namespace: ai-gateway
spec:
  length: 48
  symbols: 0
  allowRepeat: true
  secretKeys:
    - agent-sandbox
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: agent-sandbox-gemini-token
  namespace: ai-gateway
spec:
  refreshInterval: "0"
  target:
    name: agent-sandbox-gemini-token
  dataFrom:
    - sourceRef:
        generatorRef:
          apiVersion: generators.external-secrets.io/v1alpha1
          kind: Password
          name: agent-sandbox-gemini-token
---
apiVersion: generators.external-secrets.io/v1alpha1
kind: Password
metadata:
  name: swe-bench-token
  namespace: ai-gateway
spec:
  length: 48
  symbols: 0
  allowRepeat: true
  secretKeys:
    - swe-bench
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: swe-bench-token
  namespace: ai-gateway
spec:
  refreshInterval: "0"
  target:
    name: swe-bench-token
  dataFrom:
    - sourceRef:
        generatorRef:
          apiVersion: generators.external-secrets.io/v1alpha1
          kind: Password
          name: swe-bench-token
```

Then, register the keys as actual consumer keys with an Envoy Proxy custom resource:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: gemini-consumer-auth
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: gemini
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: gemini-external
  apiKeyAuth:
    forwardClientIDHeader: x-llm-client-id
    credentialRefs:
      - group: ""
        kind: Secret
        name: agent-sandbox-gemini-token
      - group: ""
        kind: Secret
        name: swe-bench-token
    extractFrom:
      - headers:
          - Authorization
```

Finally, we set a limit of 500K total tokens per hour or 1M per day (input, cached, output, and reasoning combined).

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: gemini-token-ratelimit-policy
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: gemini
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: gemini-external
  connection:
    bufferLimit: 10Mi
  rateLimit:
    type: Global
    global:
      rules:
        - clientSelectors:
            - headers:
                - name: x-api-key
                  type: Distinct
                  invert: false
                - name: x-ai-eg-model
                  type: Exact
                  value: gemini-3.1-flash-lite
                  invert: false
          limit:
            requests: 500000
            unit: Hour
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_total_token
        - clientSelectors:
            - headers:
                - name: x-api-key
                  type: Distinct
                  invert: false
          limit:
            requests: 1000000
            unit: Day
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_total_token
```

## Result

This is what the Grafana dashboard looks like after running a single SWE-bench test case with `qwen3.8-flash` with the consumer key `swe-bench` alongside OpenCode running on `deepseek-v4-flash-0731` with the consumer key `agent-sandbox`:

```bash
export OPENAI_BASE_URL="https://ai.lab.linuxdweller.com/v1"
export OPENAI_API_KEY=<swe-bench-secret-consumer-key>
swebench infer lite \
  -m openai/qwen/qwen3.8-flash - \
  -run-id qwen-test -w 1 \
  -c agent.step_limit=120 \
  -- --filter "^django__django-13964$" \
  --redo-existing
swebench eval lite \
  -p logs/inference/qwen-test/preds.json \
  --run-id qwen-test-eval \
  -j 1
```

![agent sandbox dashboard](/agent-sandbox-dashboard.png)

[The dashboard's json definition is available here](https://gist.github.com/linuxdweller/d355653ed256ed19963a9ccedf85beef). It includes:

1. Input, cached, output and reasoning token count per model.
2. Cost per consumer key.
3. Output tokens per second (p50 / p90 / p99).
4. Request latency (p50 / p90 / p99).

Agent Router has many more interesting and useful metrics which are exposed. I suggest everyone to build their own dashboard based on their own needs in a couple of minutes using their favorite LLM.

## Tradeoffs

With current hardware prices this solution is very hard to justify.

Running a dev VM, K8s cluster, and Prometheus+Grafana just for local development is not cheap. It requires significant memory, cpu and storage which mostly sit idle and can't easily scale down.

For me, the only reason this makes sense financially is that I have a lot of extra hardware sitting idle. My homelab rarely goes above 30% memory/cpu usage.

## Limitations

This solution is still severely lacking. Coding agents running in this sandboxed VM are unable to:

1. Access my "real" k8s clusters, where I actually deploy all my things and work regularly.
2. Access Prometheus metrics and OTel logs and traces.
3. Access shared storage (I use Ceph) and routers/switches in my home network.

Perhaps the next step would be a just-in-time permission system with fine grained roles for every part of my homelab.

For now though I prefer waiting for the community to settle on tooling for agent permissions before I join everyone else and build my own.
