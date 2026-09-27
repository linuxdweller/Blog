---
title: "Agent Router: A K8s Native AI Gateway (Part 1)"
date: "2026-09-22"
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

1. Envoy Gateway: Gateway API controller which reconciles Gateway API CRDs.
2. Gateway API CRDs: standard Gateway API CRDs like Gateway and HTTPRoute.
3. Agent Router: the controller which reconciles Agent Router CRDs.
4. Agent Router CRDs: the CRDs which define LLM routes, consumer keys, rate limiting, etc.

We will also deploy Redis as standalone deployment and service resources. It is required by Agent Router for rate limitng consumers.

<img src="/envoy-ai-gateway-argocd-apps.svg" alt="Five ArgoCD Apps grouped into an Envoy Gateway stack (Gateway API CRDs feeding Envoy Gateway) and an Agent Router stack (Agent Router CRDs feeding Agent Router), with Envoy Gateway feeding Agent Router and Redis feeding Agent Router's rate limiter.">

The examples use ArgoCD Applications for deploying the charts as we are installing a lot of CRDs and Helm does not handle upgrading CRDs when upgrading chart versions.

## Installation

We start with installing Envoy Gateway CRDs. We need both standard Gateway API CRDs and custom out-of-spec Envoy Gateway CRDs.

We install both by setting `envoyGateway.enabled: true` (custom Envoy Gateway CRDs) and `gatewayAPI.enabled` (standard Gateway API CRDs).

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: lab-lab-cluster-envoy-crds
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
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
  destination:
    name: lab/lab-cluster
    namespace: envoy
  project: lab-lab-cluster-system
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
  destination:
    name: lab/lab-cluster
    namespace: envoy
  project: lab-lab-cluster-system
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
  source:
    chart: ai-gateway-crds-helm
    repoURL: docker.io/envoyproxy
    targetRevision: v1.1.0
  destination:
    name: lab/lab-cluster
    namespace: envoy-ai-gateway-system
  project: tenants
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
  project: tenants
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

## Next Steps

This is the end of part one. Check out part two to see how we are going to deploy an actual AI Gateway with consumer keys,
rate limiting, and model/provider fallbacks. This will be done using all the different CRDs of Agent Router and Envoy Gateway.
