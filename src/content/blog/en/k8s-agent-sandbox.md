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
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

Drop all Linux capabilities. Agents do not need CAP_NET_ADMIN, CAP_SYS_PTRACE, or anything else. A read only root filesystem means that even if the agent writes a malicious script, it cannot persist it to disk. Use an emptyDir volume mount for the scratch space your agent genuinely needs, scoped and ephemeral.

Enforce this at the cluster level with Pod Security Admission set to restricted on the namespace where your agents run:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: agents
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

Pair this with Kyverno or OPA Gatekeeper policies to reject any agent pod that does not declare a seccomp profile.

## Seccomp Profiles: Allowlist the System Calls Your Agent Actually Needs

Seccomp is the most underused control in Kubernetes. It lets you define exactly which Linux system calls a container is allowed to make. For an agent that runs Python and makes HTTP calls, you need maybe 50 system calls. There are over 300 available.

Use the RuntimeDefault profile as a floor:

```yaml
seccompProfile:
  type: RuntimeDefault
```

For production agent workloads, generate a custom profile using tooling like Inspektor Gadget or the seccomp operator. Record the agent doing its normal work, generate the allowlist, and then enforce it. Now prompt injection that tries to call fork, execve, or ptrace gets blocked at the kernel level before anything happens.

## Network Policy: Agents Should Talk to Almost Nobody

An agent pod should have a NetworkPolicy that explicitly allows only the traffic it needs. Egress to the LLM API endpoint. Egress to the specific tool backends it is authorized to call. Nothing else.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-egress
  namespace: agents
spec:
  podSelector:
    matchLabels:
      app: agent
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: tools
```

No egress to the Kubernetes API server. No egress to the node metadata endpoint (169.254.169.254 is where cloud credential theft happens). No ingress from other namespaces unless explicitly required.

## ServiceAccount Least Privilege

Every agent pod gets a dedicated Kubernetes ServiceAccount. That ServiceAccount gets no ClusterRole bindings. If the agent needs to interact with Kubernetes resources as part of its tool use, scope the Role to the minimum verbs on the minimum resources in the minimum namespace. Use IRSA on AWS or Workload Identity on GCP to give the pod cloud credentials, scoped to exactly the S3 bucket or Pub/Sub topic it needs.

Automounting the default ServiceAccount token is disabled at the namespace level:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent
  namespace: agents
automountServiceAccountToken: false
```

## Runtime Threat Detection With Falco

All of the above is preventive. Falco gives you detective capability. Deploy it as a DaemonSet and write rules that fire when an agent pod does something unexpected: spawns a shell, opens a sensitive file path, or makes a DNS query to an unexpected domain. Wire the alerts to your incident response pipeline.

The combination of prevention and detection is what zero trust for agent workloads actually looks like in practice on Kubernetes.

## Putting It Together

The threat model for LLM agents is unique because the attack vector is the model output itself. Prompt injection is a real production concern and it means your agent pod will sometimes try to do things it should not. The Kubernetes security stack gives you the tools to make sure that when that happens, the blast radius is a failed syscall rather than a compromised cluster.

gVisor or Kata for kernel isolation. Seccomp allowlists. Read only filesystems. Dropped capabilities. Tight NetworkPolicy. Scoped ServiceAccounts. Falco for detection. None of these are novel Kubernetes features. Applying them together to agent workloads is what separates a production ready AI platform from a demo that got deployed.
