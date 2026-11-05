# Controlled network fixtures

The source checkout includes `script/network-peer.ts`, a Node 24 standard
library test service. Python is not required. It is not part of the provider
runtime or its trusted execution path. No hosted service or user-supplied
fixture is required.

Run the service on a trusted VM or separate host with a specific IPv4 bind
address:

```sh
node script/network-peer.ts 10.240.1.37
```

Do not use a wildcard address. The service exits after 30 minutes and handles
SIGTERM or Ctrl-C by closing its HTTP connections and UDP sockets. A service
manager may impose a shorter lifetime. Stop the service after testing. It
contains no workload runner or credential access.

The execution host must reach the peer over IP. OrbStack isolated machines
restrict communication with macOS, so establish reachability before interpreting
denial results. A trusted fixture machine is distinct from the isolated Linux
machines used for sandbox execution. Do not execute model workloads on the
fixture machine.

## Protocol

All endpoints use the supplied bind address:

| Port  | Protocol     | Behaviour                                                           |
| ----- | ------------ | ------------------------------------------------------------------- |
| 18080 | HTTP         | `GET /probe/TOKEN` returns `fixture` and records a TCP probe        |
| 18080 | HTTP         | `GET /seen/TOKEN` returns the TCP, UDP and DNS request counts       |
| 18081 | UDP          | Echoes the token and records a UDP probe                            |
| 18082 | DNS over UDP | Answers `TOKEN.mxc.test A` with `203.0.113.7` and records the query |

Tokens are 32 lowercase hexadecimal characters. Observation responses include
exactly `tcp`, `udp` and `dns` counts. Counter updates are synchronous on the
Node event loop, and the service limits storage to 4096 distinct tokens. Tokens
and fixed synthetic answers are test data, not secrets.

The test uses a distinct token for each host control and target probe. A
negative target result must coincide with zero peer requests. An open-egress
result must include the expected response and one observed request. Host
controls before and after each target probe prevent an unreachable service from
passing as isolation.

## Gate

```sh
MXC_EGRESS_TEST_URL=https://example.com \
  MXC_MATRIX_HOST=10.240.1.37 pnpm test:network
```

Use the peer address reachable from the execution host. The HTTPS endpoint must
return 200 without URL credentials. Missing configuration fails the gate.

On macOS, probes use Apple system curl, nc and dig. Host Node and the
Nix-provided curl could not reach the local VM addresses in the observed setup,
so their failures cannot establish sandbox isolation.

The current macOS result is seven passing tests and one failing open-egress DNS
test. The peer receives the DNS query, but sandboxed dig reports
`;; communications error: permission denied`. Keep that failure visible. A
controlled public-SDK comparison makes dig succeed when ingress is allowed and
fail when only that field changes to denied. A connected UDP DNS probe receives
the complete expected answer while ingress and host loopback remain denied. The
existing dig-based gate is still failing; changing its acceptance criteria
requires an explicit decision about the dig socket-pattern limitation. The
[source-backed diagnosis and working TCP alternative][macos-dns] explain the
remaining compatibility restriction. Both Linux network matrices pass all eight
cases, and direct Linux dig probes succeed under open egress with ingress still
denied. Ingress, expanded loopback, IPv6 and complete platform acceptance remain
incomplete.

[macos-dns]: macos-dns.md
