---
title: "Agent Router: A K8s Native AI Gateway (Part 2)"
date: "2026-09-23"
tag: { displayName: "K8s", uriName: "k8s" }
description: "Operating an AI gateway entirely with GitOps and K8s Custom Resources"
---

**This article is fully human written. No LLM was used to generate any of the text.**

This is a two-part series. Part one (the previous article) shows how to install Agent Router.
Part two (this article) shows how to deploy a production-ready AI gateway with it.

Agent Router (formerly Envoy AI Gateway) is a K8s operator for deploying fully fledged
AI/LLM gateways. It is built on Envoy Gateway, the official K8s Gateway API implementation for Envoy.

## Goal

We are going to use Agent Router CRDs (Custom Resource Definitions) to deploy a production-ready
gateway with:

1. Automatic fallback to backup providers.
2. API keys with custom budgets.
3. Grafana usage dashboard.

<picture>
  <source media="(max-width: 640px)" srcset="/envoy-ai-gateway-request-flow-mobile.svg">
  <img src="/envoy-ai-gateway-request-flow.svg" alt="Client request flow: a client sends a request with an API key to the Gateway, which checks the budget via its rate-limit service, rejects with 429 when over limit, otherwise routes to Gemini as primary or OpenRouter as fallback, and emits metrics to Prometheus which feeds a Grafana dashboard.">
</picture>

Using CRDs for defining everything is super useful for two main reasons:

1. It reduces drift, as there is a controller which constantly reconciles live state.
2. It allows creating app-specific resources like API keys inside the helm chart which deploys
   our application to K8s (without needing to run terraform to create these resources on the side).

## Prerequesites

You'll need a K8s cluster with the following operators installed:

1. Agent Router with the configuration from part one.
2. [External Secrets Operator](https://external-secrets.io/main/), for generating random API keys.
3. [cert-manager](https://cert-manager.io/docs/), for issuing TLS certificates for the gateway.
4. [Grafana operator](https://grafana.github.io/grafana-operator/docs/), for creating the dashboard.
5. [Prometheus operator](https://prometheus-operator.dev/docs/getting-started/introduction/), for scarping metrics from the gateway.

## Creating A Gateway

A standard Gateway resource is used to create an Envoy gateway. The CRDs in the next sections are used
to configure it.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: gateway
  namespace: ai-gateway
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    aigateway.envoyproxy.io/gateway-config: gateway-config
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

TLS is handled by cert-manager, which creates the `tls.certificateRefs` secret automatically.

The `aigateway.envoyproxy.io/gateway-config` annotation points at a `GatewayConfig` resource. It defines
cost and usage metadata keys which are used for calculating budget quotas and Prometheus metrics:

```yaml
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: GatewayConfig
metadata:
  name: gateway-config
  namespace: ai-gateway
spec:
  globalLLMRequestCosts:
    - metadataKey: llm_input_token
      type: InputToken
    - metadataKey: llm_cached_input_token
      type: CachedInputToken
    - metadataKey: llm_output_token
      type: OutputToken
    - metadataKey: llm_total_token
      type: TotalToken
    - metadataKey: llm_cost_microusd
      type: CEL
      cel: >-
        (model == "gemini-3.1-flash-lite") ?
          int(double(input_tokens - cached_input_tokens) * 0.25 + double(cached_input_tokens) * 0.025 + double(cache_creation_input_tokens) * 0.08333 + double(output_tokens + reasoning_tokens) * 1.5)
        : (model == "deepseek-flash") ?
          int(double(input_tokens - cached_input_tokens) * 0.3 + double(cached_input_tokens) * 0.006 + double(cache_creation_input_tokens) * 0.3 + double(output_tokens + reasoning_tokens) * 1.2)
        : int(double(total_tokens) * 10.0)
```

`llm_cost_microusd` is a CEL expression which calculates the cost per request in micro-dollars.

## Defining Routes With Fallback

We define a backend by creating a group of `Backend`, `BackendTLSPolicy` and `AIServiceBackend`
resources.

In this example we define `api.deepseek.com` as the actual backend.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: deepseek
  namespace: ai-gateway
spec:
  endpoints:
    - fqdn:
        hostname: api.deepseek.com
        port: 443
```

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: deepseek-tls
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.envoyproxy.io
      kind: Backend
      name: deepseek
  validation:
    wellKnownCACertificates: System
    hostname: api.deepseek.com
```

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: deepseek
  namespace: ai-gateway
spec:
  schema:
    name: OpenAI
  backendRef:
    name: deepseek
    kind: Backend
    group: gateway.envoyproxy.io
```

1. `Backend` is a custom Envoy Gateway CRD which is used to route traffic to a backend which is _not_ a K8s service.
2. `BackendTLSPolicy` is a standard Gateway API CRD which is required to communicate with a backend over HTTPS.
3. `AIServiceBackend` is an Agent Router CRD which specifies our backend is using an OpenAI-compatible schema.

Finally, an `AIGatewayRoute` is used to tie everything together. It defines routes to specific models
(deepseek-v4-pro and deepseek-flash in this case) with fallback to other models/backends (gemini-3.1-flash-lite):

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: models
  namespace: ai-gateway
spec:
  parentRefs:
    - name: gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  hostnames:
    - ai.lab.linuxdweller.com
  rules:
    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: deepseek-flash
      backendRefs:
        # Main.
        - name: deepseek
          modelNameOverride: deepseek-flash
          priority: 0
          weight: 1
        # Fallback.
        - name: gemini
          modelNameOverride: gemini-3.1-flash-lite
          priority: 1
          weight: 1
      modelsOwnedBy: Envoy AI Gateway
```

In this example, `deepseek-flash` has a fallback to `gemini-3.1-flash-lite`. Gemini also has an `AIServiceBackend` which is ommited for brevity as it matches the deepseek one.

`x-ai-eg-model` is populated automatically by Agent Router with the model name the client specified in the
request body.

## Creating API Keys

First, we generate a `swe-bench-token` Secret with a random 48 character token using External Secrets Operator `Password` and `ExternalSecret` resources:

```yaml
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
```

```yaml
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

Then, we allow the `swe-bench-token` Secret to make API requests using a `SecurityPolicy` (custom Envoy Gateway CRD):

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: opencode-consumer-auth
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: models
  apiKeyAuth:
    forwardClientIDHeader: x-llm-client-id
    credentialRefs:
      - group: ""
        kind: Secret
        name: swe-bench-token
    extractFrom:
      - headers:
          - Authorization
```

## Defining Budget Quotas

Using a `BackendTrafficPolicy` (custom Envoy Gateway CRD) we define a custom budget quota:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: gemini-token-ratelimit-policy
  namespace: ai-gateway
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: gateway
  connection:
    bufferLimit: 10Mi
  timeout:
    tcp:
      connectTimeout: 2s
  rateLimit:
    type: Global
    global:
      rules:
        - clientSelectors:
            - headers:
                - name: x-api-key
                  type: Distinct
                  invert: false
          limit:
            requests: 50000000 # = $50.00/day
            unit: Day
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_cost_microusd
        - clientSelectors:
            - headers:
                - name: x-api-key
                  type: Distinct
                  invert: false
          limit:
            requests: 100000000
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
  retry:
    numAttemptsPerPriority: 1
    numRetries: 3
    perRetry:
      backOff:
        baseInterval: 100ms
        maxInterval: 2s
      timeout: 3s
    retryOn:
      httpStatusCodes:
        - 429
        - 500
      triggers:
        - connect-failure
        - retriable-status-codes
```

We are actually configuring two different quota rules:

1. 50$ per _day_ for each API key.
2. 100M max total tokens (input and output) per _day_ for each API key.

The first quota rule to hit will cause a client to receieve 429 responses.

## Scraping Prometheus Metrics

Agent Router metrics are scraped with this PodMonitor which targets the `aigw-admin` port on the Envoy pod.
Behind this port sits the Agent Router sidecar.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: ai-gateway-extproc
  namespace: ai-gateway
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy
      app.kubernetes.io/component: proxy
  podMetricsEndpoints:
    - port: aigw-admin
      path: /metrics
      interval: 30s
```

The following metrics are available as histograms:

1. `gen_ai_client_token_usage`: input/output/cached/rasoning token usage.
2. `gen_ai_server_request_duration_seconds`: total request latency.
3. `gen_ai_server_time_per_output_token_seconds`: output tokens/s.
4. `gen_ai_server_time_to_first_token_seconds`: first output token latency.

## Creating A Grafana Dashboard

I took a screenshot of the dashboard after making requests with two API keys, `swe-bench` and `agent-sandbox`, to the models `deepseek-v4-flash-0731` and `qwen3.8-flash`.

![agent sandbox dashboard](/agent-sandbox-dashboard.png)

[The dashboard's json definition is available here](https://gist.github.com/linuxdweller/d355653ed256ed19963a9ccedf85beef). It uses all Agent Router metrics to display:

1. `Tokens by Type & Model`: input, cached, output and reasoning token count per model.
2. `Total Cost`: cost per API key.
3. `Total Tokens`: total tokens (input and output) per API key.
4. `Request Duration`: request latency.
5. `Time per Output Token`: output tokens/s.
6. `Time to First Token`: first token latency per API key.

## Result

Our gateway is fully provisioned using K8s CRDs. It is ready to use, with full observability and custom rate limiting in place.

This is an example `v1/chat/completions` (openai-compatible) request to the `deepseek-flash` model we confiugred:

```bash
export SWE_BENCH_TOKEN=$(kubectl get secret -n ai-gateway swe-bench-token -o json | jq -r '.data["swe-bench"]' | base64 -d)
curl https://ai.lab.linuxdweller.com/v1/chat/completions \
  -H "Authorization: Bearer ${SWE_BENCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"say OK"}],"max_tokens":5}'
```

## Tradeoffs

We managed to configure a production-grade AI gateway entirely with CRDs. We also used a completely open solution which
has no features gated behind an enterprise contract.

As an avid K8s user, I consider that a great success.

Still, there are several things to consider before deploying Agent Router to production:

1. It requires installing 4 different Helm charts for two different operators (see part 1).
2. It is still in beta, with new features and bug fixes coming every month.
3. It does not have cool cutting-edge capabilities like LiteLLM's auto-router.

Even if you are not going to deploy Agent Router, I think it is interesting to keep paying attention to it, as it has the potential
to become one of the top options to provision AI gateways on K8s.
