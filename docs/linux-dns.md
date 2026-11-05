# Linux resolver-file grants

The adapter's automatic exact resolver-file grant broke open-egress DNS on hosts
whose resolver file specifies only loopback nameservers, including an IPv4
address. MXC intentionally treats an explicit grant on the resolver file as a
caller-supplied resolver and disables its automatic substitution.

The adapter now applies MXC's own test before granting the file: when every
nameserver is a loopback address and at least one is IPv4, it adds no grant, so
MXC substitutes slirp's forwarder. Other resolver files are still granted. Unit
tests cover the decision. On the Linux ARM64 OrbStack machine,
`/etc/resolv.conf` was temporarily replaced with a file listing only
`127.0.0.53`, with a forwarding stub listening on that address. The external
HTTPS test then passed under open egress with the corrected adapter, and failed
when the adapter was patched back to granting the resolver file. The amd64
machine was not rerun.

## Controlled results

The probes used the unmodified native `lxc-exec` bundled with
`@microsoft/mxc-sdk@1.0.1`, plus the public Node `/v1` API. The package's
release source is `fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2`.

Each group of comparisons ran in a fresh, unprivileged user, mount and network
namespace. The user mapping was `0 501 1`: namespace root mapped to the ordinary
VM user, not host root. A Node fixture answered DNS on `127.0.0.53:53`. A second
configuration used `192.0.2.2` on a private dummy interface as a non-loopback
resolver. Mounts of synthetic `/etc`, `/run` and `/opt` applied only inside
these namespaces; the VM's resolver was not modified.

The fixture returned `203.0.113.7` for unique tokens under `mxc.test`.
Successful host controls before and after every case established that the stub
worked. Independent fixture counters distinguished delivered queries from failed
lookups. The probes checked both fully qualified and search-domain lookups.

Every sandbox request allowed egress and denied ingress and host loopback.

| Resolver configuration                                                      | Extra read-only grant         | Resolver inside sandbox  | Lookup result                      | Query reaches stub |
| --------------------------------------------------------------------------- | ----------------------------- | ------------------------ | ---------------------------------- | ------------------ |
| Regular file specifying `127.0.0.53`                                        | None                          | `10.0.2.3`               | Success                            | Yes                |
| Symlink to `/run/systemd/resolve/stub-resolv.conf`, specifying `127.0.0.53` | None                          | `10.0.2.3`               | Success                            | Yes                |
| Either of those loopback configurations                                     | Exact canonical resolver file | `127.0.0.53`             | `getent` exits 2                   | No                 |
| Symlink outside baseline mounts, specifying `127.0.0.53`                    | None                          | `10.0.2.3`               | Success, with a mount-hint warning | Yes                |
| Same out-of-baseline loopback configuration                                 | Its isolated parent directory | `10.0.2.3`               | Success, without that warning      | Yes                |
| Same out-of-baseline loopback configuration                                 | Exact canonical resolver file | `127.0.0.53`             | `getent` exits 2                   | No                 |
| Symlink outside baseline mounts, specifying `192.0.2.2`                     | None                          | Resolver file unreadable | `getent` exits 2                   | No                 |
| Same non-loopback configuration                                             | Exact canonical resolver file | `192.0.2.2`              | Success                            | Yes                |

An explicit `dig @10.0.2.3` query succeeded in every case that started,
including cases with failed ordinary lookups. Slirp connectivity and forwarding
were working. The failure was the resolver selected by the visible file.

Both Linux ARM64 and amd64 under Rosetta produced the same results. Each
architecture ran 24 native-CLI cases and 13 public-SDK cases. These are
diagnostic comparisons, not additions to the ordinary unit-test count or full
platform acceptance.

## Mechanism

The adapter's [system path helper][adapter] always adds the canonical Linux
resolver file to `readonlyPaths`. It checks that the destination is a regular
file, but does not distinguish baseline mounts, loopback stubs or non-loopback
nameservers.

MXC's [resolver decision][decision] first checks whether every nameserver is
loopback and at least one is IPv4. For that configuration it would normally
replace the sandbox's resolver file with one specifying `10.0.2.3`. Slirp
forwards queries from that address to the host namespace's resolver, so the
host's loopback stub remains reachable.

Before creating the replacement, MXC checks whether the filesystem policy
explicitly specifies either `/etc/resolv.conf` or its canonical destination. An
exact file grant means the caller supplied a resolver. MXC preserves that file
and emits a warning. Inside the new network namespace, `127.0.0.53` refers to
the sandbox's own loopback, not the host stub. Ordinary lookups fail.

This behaviour is intentional and already has upstream unit coverage in
`the_decision_declines_a_caller_supplied_resolver` and
`the_decision_declines_a_caller_supplied_resolver_through_a_symlink`. The
[existing upstream runtime test][runtime-test] also creates a loopback stub and
checks successful automatic substitution, but does not add our exact-file grant.

[adapter]: ../src/platform/system-paths.ts
[decision]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/src/mxc-sdk/src/backends/bubblewrap/common/proxy_network.rs#L1471-L1551
[runtime-test]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/tests/scripts/run_bwrap_dns_test.sh

## Resolver service sockets

MXC 1.0.1 read-only binds `/run/systemd/resolve`, `/run/NetworkManager` and
`/run/resolvconf` so resolver symlinks keep working. When systemd-resolved is
running, `/run/systemd/resolve` also contains its Varlink sockets. A probe in
`ip-denied` mode called `ResolveHostname` through `io.systemd.Resolve`, and an
independent DNS server outside the sandbox recorded the query.

Denying the whole directory breaks DNS when `/etc/resolv.conf` links into it.
The adapter instead lists the sockets in these directories before each command
and passes them as `deniedPaths`. MXC mounts `/dev/null` over each denied
socket. With systemd-resolved started on the ARM64 machine, the provider test
found neither socket inside the sandbox; with the denial removed, both were
present. Open-egress DNS still resolved through slirp's forwarder.

## Correction constraints

Removing every automatic resolver grant is not sufficient: an out-of-baseline
non-loopback resolver then becomes unreadable, as the controlled comparison
shows. The correction must preserve narrow access where needed without
accidentally overriding MXC's loopback-stub handling. Ordinary `/etc` and
systemd resolver paths already have baseline mounts.

A parent-directory mount preserved substitution in the isolated fixture, but
that directory contained only the test resolver. The experiment does not justify
automatically granting arbitrary host directories. No such grant was added to
the provider.

An out-of-baseline loopback resolver works natively without an extra grant, but
still produces MXC's advisory mount-hint warning. The separate Node SDK
warning-cleanup hazard therefore remains relevant to that configuration.
Warning-producing cases were examined with the shipped CLI; public-SDK probes
used warning-free configurations. The warning-cleanup investigation remains
deferred, and neither the SDK nor native library was patched.

Literal symlink grants exposed a separate native mount problem: granting
`/etc/resolv.conf` itself when it was a symlink caused Bubblewrap startup to
fail with `Can't create file at /etc/resolv.conf: No such file or directory`.
The adapter already canonicalises grants, so that failure is not the cause of
its loopback-stub regression. It was recorded separately from completed lookups;
startup failure was not treated as DNS isolation evidence.
