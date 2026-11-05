# macOS DNS under ingress denial

The configured open-egress policy permits outbound traffic while denying ingress
and host-loopback access. Apple dig 9.10.6 can send a UDP query under this
policy, but its receive operation fails. The controlled peer records the query.
The failure is not evidence that the peer is unreachable or that DNS queries
cannot leave the sandbox.

## Evidence

| Probe                                                           | Result                                                |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| Apple dig outside MXC                                           | Receives the expected answer                          |
| Apple dig inside MXC, ingress denied                            | Query reaches the peer; dig prints a permission error |
| Same public-SDK request with ingress allowed                    | Receives the expected answer                          |
| Connected UDP DNS, ingress still denied                         | Receives the complete expected DNS packet             |
| Apple dig over TCP, ingress still denied                        | Returns A records successfully                        |
| Node DNS resolver to an external resolver, ingress still denied | Returns A records successfully                        |

The ingress-allowed request was a disposable diagnostic comparison. The provider
still denies ingress and host loopback. No SDK patch, profile override, command
rewrite or automatic retry was added.

Dig can exit zero while printing `;; communications error: permission denied`.
Tests must check answer bytes and peer observations, not just its exit status.

## Source-backed explanation

Apple's published [BIND source][dighost] identifies itself as version
[9.10.6][version], matching the tested system tool. Its `send_udp()` path
creates and binds a UDP socket, queues a receive and calls
`isc_socket_sendtov2()`. Unlike its TCP path, the UDP path does not call
`isc_socket_connect()`.

The receive callback `recv_done()` prints the observed
`;; communications error: …` message when its receive event fails. The
corresponding [Unix socket implementation][socket] performs that receive with
`recvmsg()` and converts the failure into an ISC result.

MXC's pinned [Seatbelt profile builder][profile] grants outbound networking, IP
socket binding and system sockets for open egress. It grants `network-inbound`
only when ingress is allowed. The published source and controlled ingress
comparison explain the difference between this UDP receive pattern and a
connected UDP client. This is source-backed diagnosis, not a privileged syscall
trace of the installed Apple binary.

[dighost]:
  https://github.com/apple-oss-distributions/bind9/blob/f9be7e5c419f4923bed87b0482b40bf304dbaacb/bind9/bin/dig/dighost.c
[version]:
  https://github.com/apple-oss-distributions/bind9/blob/f9be7e5c419f4923bed87b0482b40bf304dbaacb/bind9/version
[socket]:
  https://github.com/apple-oss-distributions/bind9/blob/f9be7e5c419f4923bed87b0482b40bf304dbaacb/bind9/lib/isc/unix/socket.c
[profile]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/src/mxc-sdk/src/backends/seatbelt/common/profile_builder.rs

## Working alternatives and remaining limitation

An explicit TCP query works without changing the provider's policy:

```sh
dig +tcp @1.1.1.1 example.com A +short
```

The diagnostic used successful host controls and the same command inside MXC. A
separate Node DNS resolver probe also succeeded under ingress denial. Connected
UDP DNS was verified against the controlled peer with the complete expected
response packet.

These successes do not repair default UDP dig, and Apple's `host` and `nslookup`
fail the same way. The public ingress API exposes only `default` and
`hostLoopback`, not a narrow exception for this receive pattern. Enabling
ingress would change the approved boundary.

The restriction comes from Seatbelt itself. With `sandbox-exec` and MXC's
network rules, and no MXC involved, dig fails in the same way. Adding
`(allow network-inbound (remote udp "*:53"))` or
`(allow network-inbound (remote ip "*:53"))` does not help. Only
`(allow network-inbound (local udp "*:*"))` makes dig work, and that rule admits
unsolicited datagrams to any bound UDP socket. No Seatbelt rule tried here
admits replies alone, so an MXC option for this receive pattern is unlikely.

The network gate now uses `dig +tcp` for its macOS DNS case and keeps a separate
UDP dig case that expects the query to reach the peer and the reply to be
refused.

On Linux, both controlled network matrices pass all eight cases. Direct dig
9.18.39 probes also receive the expected UDP answer under Bubblewrap with open
egress, ingress denial and host-loopback denial, on ARM64 and amd64/Rosetta. The
same probes fail with network unreachable under IP denial. These Linux results
must not be substituted for macOS compatibility evidence.
