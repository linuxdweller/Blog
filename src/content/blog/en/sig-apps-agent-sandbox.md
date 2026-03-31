---
title: "Deploying LLM Agents in Kubernetes Sandboxes with kubernetes-sigs/agent-sandbox"
date: "2026-03-31"
tag: { displayName: "K8s", uriName: "k8s" }
description: "How to use the Kubernetes SIG project agent-sandbox to run LLM agents in isolated, cloud-native sandboxes — and how to deploy the router with Helm so agents can claim and use sandboxes from any pod in your cluster."
---

An agent executing code, browsing the web, or querying a database is dynamic by nature. Securing agents requires network and kernel isolation which is not present in regular K8s clusters.

Additionally, agents are expected to be idle most of the time. This means mechanics like pod snapshotting, suspension, and fast resumption are critical to save compute resources.

Orchestrating all of this manually can snowball into an operational nightmare at scale.

[To bridge this gap, SIG Apps is developing agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). The project introduces a declarative, standardized API specifically tailored for singleton, stateful workloads like AI agent runtimes.

## The Problem With Running LLM Agents in Kubernetes

Standard Kubernetes primitives were not designed for agent workloads. An agent sandbox is a stateful, single-purpose pod with a stable identity, its own storage, and a lifecycle tied to a specific task or session. A StatefulSet is a good fit for the task, except orchestrating it at scale is hard.

10 years of K8s existence has taught us that lifecycle management for stateful workloads should be abstracted by an API which is reconciled by a controller.

Such a controller can also help with automating small but meaningful tasks like creating the required NetworkPolicy resources to provide agents full network isolation and unmounting ServiceAccount credentials in agent pods.

## Introducing agent-sandbox

[`agent-sandbox` is a Kubernetes SIG project that introduces a dedicated API surface for running isolated agent workloads](https://github.com/kubernetes-sigs/agent-sandbox). It ships a controller, a router, and four CRDs under the `agents.x-k8s.io` API group.

The project installs directly from its release manifest:

```sh
export VERSION="v0.2.1" # This is latest at the time of writing.
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml
```

The `extensions.yaml` manifests are required to install all 4 of the CRDs.

From there, agents interact with sandboxes through the API rather than directly managing pods.

## The Four CRDs You Need to Know

- **Sandbox** — a single, stateful pod with a stable identity. The foundational unit.
- **SandboxTemplate** — a reusable pod spec template. Define your runtime once, stamp out sandboxes on demand.
- **SandboxClaim** — what a client creates to request a sandbox pod from a SandboxTemplate.
- **SandboxWarmPool** — a pool of pre-initialized sandbox pods ready to be claimed with a SandboxClaim instantly. Optional, but useful for eliminating cold-start latency.

This API completely abstracts the lifecycle management of sandbox pods from the user.

## The Router: One Entry Point, Thousands of Sandboxes

Each sandbox pod is ephemeral and gets a unique ID. The router solves the addressing problem: instead of exposing every sandbox pod directly, all agent traffic flows through a single entry point.

The client sets an `X-Sandbox-ID` header on its HTTP request. The router looks up which sandbox pod owns that ID and proxies the request to it. From outside the cluster, there is one hostname. Inside, there can be thousands of active sandboxes.

This matters for security. Sandbox pods never need to be reachable directly. The router is the single choke point, and the NetworkPolicy the controller applies allows only traffic from pods labeled `app: sandbox-router`.

## Deploying the Router With Helm

The router image must be built manually which is quite a headache. [I created this GitHub repository to automatically build and push new versions of the router to GHCR](https://github.com/linuxdweller/agent-sandbox-router).

[Then, I packaged the router, a Service, HTTPRoute, and a default SandboxTemplate into a Helm chart](https://github.com/linuxdweller/agent-sandbox-router-chart).

The chart can be installed with:

```sh
helm install agent-sandbox-router \
  oci://ghcr.io/linuxdweller/charts/agent-sandbox-router \
  --version 1.0.2 \
  --set httproute.hostname=<desired-router-hostname> \
  --set httproute.parentRef.name=<your-gasteway-name> \
  --set httproute.parentRef.namespace=<your-gateway-namespace>
```

Note that by default the chart installs all resources to the namespace `agent-sandbox`.

The chart provisions:

- **Deployment** — the router.
- **Service** — ClusterIP, selector-matched to the router pods
- **ClusterRole** — least-privilege RBAC: `create`/`delete`/`get`/`list`/`watch` on `SandboxClaims`, read-only on `Sandboxes`. Scoped to exact permissions required by the agent-sandbox Python client
- **HTTPRoute** — Gateway API route wiring the external hostname to the router Service
- **SandboxTemplate** — a default Python runtime template, ready to be claimed

## The Example: Claiming a Sandbox And Running Code

Test your installation by applying the following example with `kubectl apply` and checking the job completed.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/serviceaccount.json
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sandbox-client
  namespace: agent-sandbox
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sandbox-client
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: agent-sandbox-router-client
subjects:
  - kind: ServiceAccount
    name: sandbox-client
    namespace: agent-sandbox
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/configmap.json
apiVersion: v1
kind: ConfigMap
metadata:
  name: sandbox-client-script
  namespace: agent-sandbox
data:
  run.py: |
    from k8s_agent_sandbox import SandboxClient

    with SandboxClient(
        template_name="python-sandbox-template",
        api_url="https://sandbox-router.lab.linuxdweller.com",
        namespace="agent-sandbox"
    ) as sandbox:
        print(sandbox.run("echo 'Hello from Local!'").stdout)
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/job.json
apiVersion: batch/v1
kind: Job
metadata:
  name: sandbox-client
  namespace: agent-sandbox
spec:
  template:
    spec:
      serviceAccountName: sandbox-client
      restartPolicy: Never
      containers:
        - name: sandbox-client
          image: python:3.12-slim
          command:
            - sh
            - -c
            - pip install k8s-agent-sandbox --quiet && python -u /scripts/run.py
          volumeMounts:
            - name: script
              mountPath: /scripts
      volumes:
        - name: script
          configMap:
            name: sandbox-client-script
```

The Job gets a ServiceAccount, the ServiceAccount gets bound to the ClusterRole, and the Python SDK handles the rest. It creates a `SandboxClaim`, waits for a sandbox pod to be assigned, proxies the `run()` call through the router, and releases the claim on exit.

## What You Get

Combine `agent-sandbox` with the hardening from the [previous post](/blog/en/k8s-agent-sandbox) — gVisor RuntimeClass, seccomp profiles, Falco rules — and you get a production-grade agent execution layer on Kubernetes: sandboxed pods that agents can claim and release on demand, a single proxied entry point that enforces network isolation, least-privilege RBAC so agents cannot touch anything outside their sandbox, and warm pools that eliminate cold-start latency.

This is what running LLM agents in Kubernetes should look like. Not a raw pod with a mounted service account token. A first-class, auditable, isolated execution environment with a Kubernetes-native API.

The Helm chart is at [github.com/linuxdweller/agent-sandbox-router-chart](https://github.com/linuxdweller/agent-sandbox-router-chart).
