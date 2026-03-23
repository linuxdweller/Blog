---
title: "Sandboxing LLM Agents on Kubernetes: Shell Access Without the Keys to Production"
date: "2026-02-03"
tag: { displayName: "K8s", uriName: "k8s" }
description: "How to use Kubernetes with open source security tools like gVisor, Falco, and Kata Containers to sandbox LLM agent tool use so that prompt injection ends in a failed syscall, not a compromised cluster."
---

AI agents are finally useful. They can browse the web, write and execute code, query databases, call APIs, and interact with your file system. The problem is that all of those capabilities are also exactly what an attacker would do if they compromised your production environment. The question is not whether to give agents tool use. The question is how to do it without turning every agent pod into a liability.

This post walks through how to harden the Kubernetes workloads that run your AI agents so that tool use stays sandboxed, blast radius stays small, and lateral movement becomes nearly impossible even if the agent is manipulated via prompt injection.

## Why Agents Are Different From Normal Services

A typical microservice has a well defined, static behavior. You know exactly what system calls it makes, which network endpoints it talks to, and which files it touches. You can lock that down with confidence.

An LLM agent is different. Its behavior is dynamic. A ReAct agent or a function calling loop can decide at runtime to execute a shell command, write a file, or call an internal API, based on what the model outputs. The attack surface is not defined by your code. It is defined by what the model decides to do, which includes what an attacker can trick the model into doing via prompt injection.

This is why standard Kubernetes security posture is not enough. You need defense in depth at the pod level.

## Start With the Right Runtime

The first layer of defense is the container runtime itself. By default, Kubernetes pods run on runc, which shares the host kernel. A container escape CVE means your agent workload is directly adjacent to the node.

gVisor (runsc) changes this. It interposes a user space kernel between the container and the host kernel, so system calls from the agent process never reach the real kernel directly. If your agent executes malicious code inside its tool use sandbox, gVisor absorbs the blast. You deploy it on Kubernetes by installing the GKE Sandbox node pool or by running the gVisor RuntimeClass on your own clusters.

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

Then reference it in your agent pod spec:

```yaml
spec:
  runtimeClassName: gvisor
```

Kata Containers is the alternative when you need stronger isolation at the cost of higher overhead. Each pod runs inside a lightweight VM. If your agent workload handles untrusted code execution this is worth the tradeoff.

## Lock Down the Pod With Security Context

RuntimeClass handles kernel isolation. The Pod Security Context handles everything above that.

Every agent pod should run with this baseline:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65534
  runAsGroup: 65534
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

- `runAsNonRoot`: fail the container if it tries to run as root.
- `runAsUser` and `runAsGroup`: specify a non-root UID/GID for the container.
- `allowPrivilegeEscalation`: prevent the process from granting a newly-started program priviliges that the process did not have.
- `capabilities: drop: ALL`: prevents kernel level operations like binding ports, changing UID/GID and file ownership. [See the full list here](https://github.com/torvalds/linux/blob/master/include/uapi/linux/capability.h).

Enforce this at the namespace level with Pod Security Admission set to restricted:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: agents
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

This also enforces setting a seccomp profile, which relates to the next item.

## Seccomp Profiles: Allowlist the System Calls Your Agent Actually Needs

Using Seccomp we can block syscalls we know our agent won't need. The default Seccomp profile of your container runtime is a good starting point. [This is the blocked syscalls list for `containerd`](https://docs.docker.com/engine/security/seccomp/#significant-syscalls-blocked-by-the-default-profile).

Use the RuntimeDefault profile as a floor:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent
  namespace: agents
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
```

Figuring out which syscalls are not used by your agent is both tricky and tediuos. You should record a log of syscalls your agents use during testing using tooling like [seccomp operator](https://github.com/kubernetes-sigs/security-profiles-operator).

## Network Policy: Agents Should Not Talk Directly With Other Pods

By default, Kubernetes allows all traffic between pods — same namespace, different namespaces, everything.

An agent pod should have a NetworkPolicy that denies traffic to all other pods. NetworkPolicies are additives, so explicitly allowing egress traffic to specific pods is possible if needed.

This is a default deny policy for egress to all pods. It is applied to all pods in the `agents` namespace. This policy works by denying access to the entire pod subnet. Change this subnet to match your cluster's pod subnet.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress-pods-subnet
  namespace: agents
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              # Pod subnet of your cluster.
              - 10.243.0.0/16
```

## Disable ServiceAccount Automount

By default, a `ServiceAccount` is mounted automatically on `/var/run/secrets/kubernetes.io/serviceaccount/token`.

If your pod does not use these credentials to authenticate to your cloud provider or the Kubernetes API server, we can opt out of this behavior by setting `automountServiceAccountToken: false`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent
spec:
  automountServiceAccountToken: false
```

## Runtime Threat Detection With Falco

All of the above is preventive. Falco gives you detective capability. Deploy it as a DaemonSet and write rules that fire when an agent pod does something unexpected: socket mutations, mutating Linux `coreutils` executeables, or making a DNS query to an unexpected domain. Wire the alerts to your incident response pipeline.

The combination of prevention and detection is what zero trust for agent workloads actually looks like in practice on Kubernetes.

## Putting It Together

The final Pod, NetworkPolicy, RuntimeClass manifests we assembled:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: agents
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/pod.json
apiVersion: v1
kind: Pod
metadata:
  name: envoy
  namespace: agents
spec:
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  containers:
    - name: claude-code
      image: claude-code:latest
      securityContext:
        seccompProfile:
          type: RuntimeDefault
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
      livenessProbe: &probe
        httpGet:
          path: /
          port: 8080
      readinessProbe: *probe
      startupProbe: *probe
      resources:
        requests:
          cpu: 50m
          memory: 128Mi
        limits:
          cpu: 50m
          memory: 128Mi
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/networkpolicy.json
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: agents
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.243.0.0/16
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.35.0-standalone/runtimeclass.json
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```
