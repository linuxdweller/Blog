---
title: "Agent Router: A K8s Native AI Gateway (Part 1)"
date: "2026-09-22"
tag: { displayName: "K8s", uriName: "k8s" }
description: "Operating an AI gateway entirely with K8s Custom Resources"
---

**This article is fully human written. No LLM was used to generate any of the text.**

This is a two-part series. Part one (the current article) shows how to install Agent Router. Part two (a future article) will show how to deploy a production-ready AI gateway with it.

Agent Router (formerly Envoy AI Gateway) is a K8s operator for deploying fully fledged
AI/LLM gateways. It is built on Envoy Gateway, the official K8s Gateway API implementation for Envoy.

## Agent Router Special Features

What makes Agent Router unique is its ability to configure everything using CRDs (Custom Resource Definitions):

1. OpenAI-compatible routes for different models and providers.
2. Automatic fallback to a backup provider.
3. Per client API keys for tracking usage.
4. Highly customizeable budget quotas per consumer key.

Using CRDs to define configuration is super useful.

It reduces drift (as there is a controller which constantly reconciles the desired state)
and allows creating app-specific resources like API keys inside the helm chart which deploys your application to K8s (without needing to
run terraform to create these resources on the side).

<picture>
  <source media="(max-width: 640px)" srcset="/envoy-ai-gateway-flow-mobile.svg">
  <img src="/envoy-ai-gateway-flow.svg" alt="Agent Router capabilities grouped into Configuration and Routing (K8s CRDs, Budget per Consumer, Model Fallback).">
</picture>

## Components To Install

Agent Router requires installing four different helm charts:

1. Gateway API CRDs: standard Gateway API CRDs like Gateway and HTTPRoute.
2. Envoy Gateway: Gateway API controller which reconciles Gateway API CRDs.
3. Agent Router CRDs: the CRDs which define LLM routes, consumer keys, rate limiting, etc.
4. Agent Router: the controller which reconciles Agent Router CRDs.

We will also deploy Redis as standalone deployment and service resources. It is required by Agent Router for rate limiting consumers when they exceed their budget.

<picture>
  <source media="(max-width: 640px)" srcset="/envoy-ai-gateway-argocd-apps-mobile.svg">
  <img src="/envoy-ai-gateway-argocd-apps.svg" alt="Five installation steps grouped into an Envoy Gateway stack (Gateway API CRDs feeding Envoy Gateway) and an Agent Router stack (Agent Router CRDs feeding Agent Router), with Envoy Gateway feeding Agent Router and Redis feeding Agent Router's rate limiter.">
</picture>

## Installation

### Envoy Gateway

We start with installing Envoy Gateway CRDs. We need both standard Gateway API CRDs and custom out-of-spec Envoy Gateway CRDs.

We install both by setting `envoyGateway.enabled: true` (custom Envoy Gateway CRDs) and `gatewayAPI.enabled` (standard Gateway API CRDs).

```bash
helm upgrade -i eg-crds oci://docker.io/envoyproxy/gateway-crds-helm \
  --version 1.8.3 \
  --namespace envoy \
  --create-namespace \
  --set crds.envoyGateway.enabled=true \
  --set crds.gatewayAPI.enabled=true
```

Then, we install the Envoy Gateway controller.

```bash
helm upgrade -i eg oci://docker.io/envoyproxy/gateway-helm \
  --version 1.8.3 \
  --namespace envoy \
  --create-namespace \
  -f envoy-gateway-values.yaml
```

`envoy-gateway-values.yaml`:

```yaml
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
certgen:
  job:
    tolerations:
      - effect: NoSchedule
        key: node-role.kubernetes.io/control-plane
        operator: Exists
```

[This config is taken from the official example for rate limiting](https://github.com/theagentrouter/agent-router/blob/main/manifests/envoy-gateway-values.yaml).

`config.envoyGateway.extensionManager.service` must match your Agent Router controller host. `config.envoyGateway.rateLimit.backend.redis.url` needs
to match your Redis host.

This example works with the Redis and Agent Router configs below.

### Agent Router

We install the Agent Router CRDs chart:

```bash
helm upgrade -i aieg-crd oci://docker.io/envoyproxy/ai-gateway-crds-helm \
  --version v1.1.0 \
  --namespace envoy-ai-gateway-system \
  --create-namespace
```

Then, we install Agent Router.

```bash
helm upgrade -i aieg oci://docker.io/envoyproxy/ai-gateway-helm \
  --version v1.1.0 \
  --namespace envoy-ai-gateway-system \
  -f ai-gateway-values.yaml
```

`ai-gateway-values.yaml`:

```yaml
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
```

The controller is configured to watch all namespaces.

`controller.requestHeaderAttributes: "x-llm-client-id:client.id"` will be used to make
rate limiting work in part 2 of this series.

### Redis

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

The controller pods should be running and ready.

The Agent Router controller pod is running in the `envoy-ai-gateway-system` namespace:

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
