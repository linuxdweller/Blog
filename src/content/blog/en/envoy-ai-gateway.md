---
title: "Agent Router: A K8s Native AI Gateway"
date: "2026-09-21"
tag: { displayName: "K8s", uriName: "k8s" }
description: "Operating an AI gateway entirely with GitOps and K8s Custom Resources"
---

**This article is fully human written. No LLM was used to generate any of the text.**

Agent Router (formerly Envoy AI Gateway) is a K8s operator for deploying production-ready
AI/LLM gateways. It is built on Envoy Gateway, the official K8s Gateway API implementation for Envoy.

For latest features you might want to look at something like LiteLLM. What makes Agent Router unique is it's ability to configure everything
(including consumer keys and budget quotas) using CRDs.

This is a two-part series. Part one (the current article) is going to focus on installing Agent Router. Part two (a future article)
will show how it's CRDs can be used to deploy an actual AI gateway with:

1. OpenAI-compatible routes for different models, with fallback to different LLM providers.
2. Client consumer keys with custom budget quotas per key.
3. Grafana dashboard with cost attributuion per consumer key and usage metrics like output tokens/sec and time-to-first-token.

<picture>
  <source media="(max-width: 640px)" srcset="/envoy-ai-gateway-flow-mobile.svg">
  <img src="/envoy-ai-gateway-flow.svg" alt="A client sends requests to Agent Router, which applies rate limiting and forwards them to LLM providers, while reporting usage metrics to Prometheus for a Grafana dashboard.">
</picture>

## Things We Need To Install

We are going to deploy four different helm charts:

1. Gateway API CRDs: standard Gateway API CRDs like Gateway and HTTPRoute.
2. Envoy Gateway: Gateway API controller which reconciles Gateway API CRDs.
3. Agent Router CRDs: the CRDs which define LLM routes, consumer keys, rate limiting, etc.
4. Agent Router: the controller which reconciles Agent Router CRDs.

We will also deploy Redis as standalone deployment and service resources. It is required by Agent Router for rate limitng consumers.

<img src="/envoy-ai-gateway-argocd-apps.svg" alt="Five ArgoCD Apps grouped into an Envoy Gateway stack (Gateway API CRDs feeding Envoy Gateway) and an Agent Router stack (Agent Router CRDs feeding Agent Router), with Envoy Gateway feeding Agent Router and Redis feeding Agent Router's rate limiter.">

The examples use ArgoCD Applications for deploying the charts as we are installing a lot of CRDs and Helm does not handle upgrading CRDs when upgrading chart versions.

### Envoy Gateway CRDs

We start with installing Envoy Gateway CRDs. We need both standard Gateway API CRDs and custom out-of-spec Envoy Gateway CRDs.

We install both by setting `envoyGateway.enabled: true` (custom Envoy Gateway CRDs) and `gatewayAPI.enabled` (standard Gateway API CRDs).

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: lab-lab-cluster-envoy-crds
  namespace: argocd
  resourceVersion: "473988295"
spec:
  destination:
    name: lab/lab-cluster
    namespace: envoy
  project: lab-lab-cluster-system
  source:
    chart: gateway-crds-helm
    helm:
      valuesObject:
        crds:
          envoyGateway:
            enabled: true
          gatewayAPI:
            enabled: true
    repoURL: docker.io/envoyproxy
    targetRevision: 1.8.3
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: -1
      backoff:
        duration: 15s
        factor: 2
        maxDuration: 60s
```

Then, we install the Envoy Gateway controller. [Note we use a custom config from the official install instructions required for rate limiting](https://github.com/theagentrouter/agent-router/blob/main/manifests/envoy-gateway-values.yaml).

`config.envoyGateway.extensionManager.service` must match your Agent Router controller host. `config.envoyGateway.rateLimit.backend.redis.url` needs
to match your Redis host. This example works with the Redis and Agent Router configs below.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: lab-lab-cluster-envoy
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  destination:
    name: lab/lab-cluster
    namespace: envoy
  project: lab-lab-cluster-system
  source:
    chart: gateway-helm
    helm:
      skipCrds: true
      valuesObject:
        certgen:
          job:
            tolerations:
              - effect: NoSchedule
                key: node-role.kubernetes.io/control-plane
                operator: Exists
        config:
          envoyGateway:
            extensionApis:
              enableBackend: true
              enableEnvoyPatchPolicy: true
            extensionManager:
              hooks:
                xdsTranslator:
                  post:
                    - Translation
                    - Cluster
                    - Route
                  translation:
                    cluster:
                      includeAll: true
                    listener:
                      includeAll: true
                    route:
                      includeAll: true
                    secret:
                      includeAll: true
              service:
                fqdn:
                  hostname: ai-gateway-controller.envoy-ai-gateway-system.svc.cluster.local
                  port: 1063
            gateway:
              controllerName: gateway.envoyproxy.io/gatewayclass-controller
            logging:
              level:
                default: info
            provider:
              kubernetes:
                rateLimitDeployment:
                  patch:
                    type: StrategicMerge
                    value:
                      spec:
                        template:
                          spec:
                            containers:
                              - image: docker.io/envoyproxy/ratelimit:60d8e81b
                                imagePullPolicy: IfNotPresent
                                name: envoy-ratelimit
              type: Kubernetes
            rateLimit:
              backend:
                redis:
                  url: redis-master.redis-system.svc.cluster.local:6379
                type: Redis
        crds:
          enabled: false
        deployment:
          envoyGateway:
            resources:
              limits:
                cpu: 500m
                memory: 1024Mi
              requests:
                cpu: 100m
                memory: 256Mi
    repoURL: docker.io/envoyproxy
    targetRevision: 1.8.3
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: -1
      backoff:
        duration: 15s
        factor: 2
        maxDuration: 60s
```

Now, we install Agent Router CRDs:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ai-gateway-crds
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: tenants
  source:
    chart: ai-gateway-crds-helm
    repoURL: docker.io/envoyproxy
    targetRevision: v1.1.0
  destination:
    name: lab/lab-cluster
    namespace: envoy-ai-gateway-system
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: -1
      backoff:
        duration: 15s
        factor: 2
        maxDuration: 60s
```

Finally, we install Agent Router. The controller will watch Custom Resources in all namespaces.
Note we set `controller.requestHeaderAttributes: "x-llm-client-id:client.id"` which we are going to use to make
rate limiting work in part 2 of this series.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ai-gateway
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: tenants
  source:
    chart: ai-gateway-helm
    repoURL: docker.io/envoyproxy
    targetRevision: v1.1.0
    helm:
      valuesObject:
        envoyGateway:
          namespace: envoy
        controller:
          requestHeaderAttributes: "x-llm-client-id:client.id"
          resources:
            limits:
              cpu: 500m
              memory: 1024Mi
            requests:
              cpu: 100m
              memory: 256Mi
  destination:
    name: lab/lab-cluster
    namespace: envoy-ai-gateway-system
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: -1
      backoff:
        duration: 15s
        factor: 2
        maxDuration: 60s
```

Last but not least, the Redis Deployment and Service resources:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: redis
  name: redis
  namespace: redis-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - image: redis:8.10.2
          name: redis
          ports:
            - containerPort: 6379
              name: redis
              protocol: TCP
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 15
            periodSeconds: 20
            timeoutSeconds: 5
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            timeoutSeconds: 5
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
            requests:
              cpu: 50m
              memory: 64Mi
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis-master
  namespace: redis-system
spec:
  selector:
    app: redis
  ports:
    - name: redis
      port: 6379
      protocol: TCP
      targetPort: 6379
```

## Result

Verify everything works by checking the ArgoCD apps are synced and healthy.

In terms of plain pods, the Agent Router controller pod is running in the `envoy-ai-gateway-system` namespace:

```bash
kubectl get pods -n envoy-ai-gateway-system
NAME                                     READY   STATUS    RESTARTS   AGE
ai-gateway-controller-594995f4b4-x4w82   1/1     Running   0          1d
```

And the Envoy Gateway controller pods are running in the `envoy` namespace:

```bash
kubectl get pods -n envoy
NAME                                     READY   STATUS    RESTARTS   AGE
envoy-gateway-5879f99d5c-xfx86           1/1     Running   0          1d
envoy-ratelimit-55b448d98c-s66w8         1/1     Running   0          1d
```

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
