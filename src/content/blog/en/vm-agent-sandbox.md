---
title: "Autopilot for Coding Agents Without Handing Over Your Homelab"
date: "2026-09-21"
tag: { displayName: "K8s", uriName: "k8s" }
description: "Autopilot for Coding Agents Without Handing Over Your Homelab"
---

**This article is fully human written. No LLM was used to generate any of the text.**

Do you work on your homelab with autonomous coding agents?

I would bet the answer is _yes_, because this is the era of Agentic AI, where nobody is writing code by hand anymore (or blog posts, sigh).

## The Problem

_Well, actually_, there are several problems with working on your homelab with autonomous coding agents:

1. Providers can record your prompts and use your homelab source code to train their models.
2. Agents can send your personal data and access keys to 3rd parties.
3. A lot of homelabs (mine included) have self-hosted APIs exposed with sub-optimal authn/authz as they do not expect untrusted actors inside the internal network.
4. Coding agents can tinker with your homelab and break it.
5. Agents can use unlimited amounts of tokens, leading to huge spend.

## The Solution

We are going to create a Gitops-based isolated dev environment for our coding agent.

**Disclaimer**: this solution is great for _me_. I already develop on VMs over ssh, use ArgoCD to deploy software, and expose services to my home network via K8s Gateway API.

<picture>
  <source media="(max-width: 640px)" srcset="/vm-agent-sandbox-flow-mobile.svg">
  <img src="/vm-agent-sandbox-flow.svg" alt="Flowchart of the agent sandbox: the coding agent calls an Envoy AI Gateway which forwards to an LLM provider and reports metrics to Grafana, pushes to a GitOps repo that ArgoCD's ApplicationSet deploys into the dedicated k8s cluster, reads that cluster directly over kubectl, and is blocked from reaching the homelab.">
</picture>

The solution consists of:

1. **Dedicated dev VM**. The agent runs inside this VM. Personal repositories are never cloned to this VM and it's blocked from accessing the homelab network via network policies.
2. **Dedicated k8s cluster** with dedicated dev namespaces.
3. **Dedicated gitops repo** scoped to the dedicated k8s cluster.
   Commits in this repo act as an audit log to changes the agent made.
4. **AI gateway** for rate limiting token usage and providing an audit log of LLM calls made by the agent.
   A grafana dashboard is used to display live LLM usage metrics exposed by the gateway.

Together, these prevent data exfiltration and unauthorized API usage, alongside neat observability.

## Implementation

My homelab is built around Kubernetes so I'm going to build the solution with it.

### Dedicated (KubeVirt) Dev VM

A debian 13 VM provisioned with KubeVirt. We block access to internal homelab subnets with a network policy attached to the VM pod.

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: agent-sandbox
  namespace: workstation
spec:
  running: true
  template:
    spec:
      domain:
        cpu:
          cores: 4
          model: host-passthrough
        devices:
          disks:
            - disk:
                bus: virtio
              name: bootdisk
            - cdrom:
                bus: sata
                readonly: true
              name: cloudinitdisk
          interfaces:
            - masquerade: {}
              name: default
        machine:
          type: q35
        resources:
          requests:
            memory: 8G
      networks:
        - name: default
          pod: {}
      volumes:
        - name: bootdisk
          persistentVolumeClaim:
            claimName: agent-sandbox # created by a KubeVirt DataVolume.
        - name: cloudinitdisk
          cloudInitNoCloud:
            userData: |
              #cloud-config
              # ssh key + qemu-guest-agent provisioning
```

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-sandbox-egress
  namespace: workstation
spec:
  podSelector:
    matchLabels:
      vm.kubevirt.io/name: agent-sandbox
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Public internet, excluding the cluster's own pod/service subnets
    # and other private ranges.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 100.64.0.0/10
    # agent-sandbox-cluster API server
    - to:
        - ipBlock:
            cidr: 10.130.0.12/32
      ports:
        - protocol: TCP
          port: 6443
    - to:
        # ai.lab.linuxdweller.com (AI gateway)
        - ipBlock:
            cidr: 10.130.0.11/32
        # argo.management.linuxdweller.com (ArgoCD API server)
        - ipBlock:
            cidr: 10.130.0.2/32
      ports:
        - protocol: TCP
          port: 443
```

### Dedicated K8s Cluster

The cluster must be connected to your gitops operator which is ArgoCD in my case.

I omitted the cluster manifests for brevity as it doesn't matter how you provision the cluster.

Network policies in the dev namespaces should be created to prevent pods from accessing your homelab subnets.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: litellm-egress
  namespace: litellm # Dev namespace.
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Public internet, same shape as the VM's policy.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 100.64.0.0/10
```

Also, a Service Account is created for our agent to interact with the cluster directly for improved troubleshooting.

It is equipped with permissions to:

1. Read-only for all resources in the dev namespaces.
2. `portforward` and `delete` on `pods` and `jobs` in the dev namespaces.
3. Read-only for `namespaces` and `nodes` resources.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-sandbox-readonly
  namespace: agent-sandbox
---
apiVersion: v1
kind: Secret
metadata:
  name: agent-sandbox-readonly-token
  namespace: agent-sandbox
  annotations:
    kubernetes.io/service-account.name: agent-sandbox-readonly
type: kubernetes.io/service-account-token
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agent-sandbox-litellm-readonly
  namespace: litellm
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [pods/portforward]
    verbs: [create]
  - apiGroups: [""]
    resources: [pods]
    verbs: [delete]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: agent-sandbox-litellm-readonly
  namespace: litellm
subjects:
  - kind: ServiceAccount
    name: agent-sandbox-readonly
    namespace: agent-sandbox
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: agent-sandbox-litellm-readonly
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: agent-sandbox-readonly-nodes
rules:
  - apiGroups: [""]
    resources: [nodes, namespaces]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: agent-sandbox-readonly-nodes
subjects:
  - kind: ServiceAccount
    name: agent-sandbox-readonly
    namespace: agent-sandbox
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: agent-sandbox-readonly-nodes
```

### Dedicated GitOps Repo

Configure a dedicated gitops repository which is connected only to the dedicated k8s cluster.

The agent gets a fine grained access token scoped to this repo so it can push commits only to it.

An ApplicationSet watches this repo and generates an application from each top level directory. The application
is installed to a dev namespace named after the directory.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: agent-sandbox
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions:
    - missingkey=error
  generators:
    - git:
        repoURL: https://github.com/linuxdweller/agent-sandbox-gitops
        revision: HEAD
        directories:
          - path: "*"
  template:
    metadata:
      name: "{{ .path.basenameNormalized }}"
    spec:
      project: agent-sandbox
      source:
        repoURL: https://github.com/linuxdweller/agent-sandbox-gitops
        targetRevision: HEAD
        path: "{{ .path.path }}"
      destination:
        name: agent-sandbox/agent-sandbox-cluster
        namespace: "{{ .path.basenameNormalized }}"
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

The AppProject is scoped to deploy specific resources only to the specific dev namespaces. It also can't create any cluster scoped resources as these can be used to obtain permissions in non-dev namespaces (via creating a ClusterRole for example).

A role with read/refresh/sync permissions is created for convenience as these are actions we want the agent to be able to run.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: agent-sandbox
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: >-
    Sandbox project for content pushed by the agent-sandbox VM to
    agent-sandbox-gitops.
  sourceRepos:
    - https://github.com/linuxdweller/agent-sandbox-gitops
  destinations:
    - name: agent-sandbox/agent-sandbox-cluster
      namespace: litellm
  clusterResourceWhitelist:
    - group: external-secrets.io
      kind: ClusterSecretStore
  namespaceResourceBlacklist:
    - group: ""
      kind: Secret
    - group: ""
      kind: ServiceAccount
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
    - group: rbac.authorization.k8s.io
      kind: Role
    - group: rbac.authorization.k8s.io
      kind: RoleBinding
    - group: networking.k8s.io
      kind: NetworkPolicy
    - group: argoproj.io
      kind: Application
    - group: argoproj.io
      kind: AppProject
    - group: argoproj.io
      kind: ApplicationSet
  roles:
    - name: sync-role
      policies:
        - p, proj:agent-sandbox:sync-role, applications, sync, agent-sandbox/litellm, allow
        - p, proj:agent-sandbox:sync-role, applications, get, agent-sandbox/litellm, allow
```

### AI Gateway

Any AI gateway which has rate limiting and exposes prometheus metrics should do the job.

I chose to use [Agent Router](https://github.com/theagentrouter/agent-router) (formerly Envoy AI Gateway) as I already use Envoy Gateway controller in my clusters. It is fully configurable with CRDs and owned by a neutral foundation (Agentic AI Foundation).

I have a two-part guide for setting Agent Router up from scratch. [Here is part one](/en/posts/envoy-ai-gateway-part-1). [And here is part two](/en/posts/envoy-ai-gateway-part-2)

## Result

TODO

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
