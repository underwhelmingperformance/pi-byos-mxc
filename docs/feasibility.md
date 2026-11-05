# MXC feasibility evidence

## Baseline

The initial probes used `@microsoft/mxc-sdk@1.0.1`, Node 24.22.2, Pi 1.4.0 and
BYOS commit `7198f1d`. The host was macOS 27.0.1 on ARM64. Native SDK imports
and Seatbelt execution worked without enabling dependency build scripts.

The runtime baseline is the published package, not repository `main`. The
[release implementation][release] defines the tested native behaviour.

[release]:
  https://github.com/microsoft/mxc/tree/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2

## Initial macOS probes

These were bounded scratch probes before provider implementation. They do not
establish complete provider conformance.

| Probe                      | Observed result                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Native shell               | Separate stdout/stderr and exit zero                                                        |
| Explicit Bash              | Bash syntax executed successfully                                                           |
| Binary output              | Exact stdout bytes `00 ff 0a` and separate stderr                                           |
| Target startup environment | `BASH_ENV` executed once in the requested Bash, not in the bootstrap                        |
| Normal completion          | A same-group descendant with closed stdio was stopped before the final group snapshot       |
| Cancellation               | The SDK returned `exitCode: -1`; the original process group had no live members afterwards  |
| Timeout                    | The SDK returned `exitCode: -1`, `timedOut: true`; the group had no live members afterwards |
| Denied host-local IP       | A host-reachable TCP listener could not be reached from Seatbelt                            |
| External egress            | An explicit open-egress request fetched HTTP status 200 from `https://example.com`          |

A fixed stdin barrier kept the native shell alive before executing the target. A
host `ps` snapshot verified that the SDK process ID was its process-group leader
before the barrier was released. Snapshots after native completion excluded
zombie processes, which cannot produce further effects.

## Cross-session cleanup limitation

A later bounded provider probe created a child in a new session with closed
output descriptors. The parent explicitly waited for child exit. On
cancellation, the backend returned
`{ kind: 'cancelled', termination: 'confirmed' }`, but the child appended five
heartbeat bytes during the following 500 ms. The result was reproduced twice.

The child terminated itself after 2.5 seconds. The completed probe removed its
owned directories and did not signal numeric PIDs.

The observer checks only the original POSIX process group. An empty original
group does not establish that foreground descendants in another session stopped.
That was a blocker under the original plan's broader foreground guarantee.

BYOS commit `b61c8b0` introduced explicit termination scopes. The revised plan
now specifies `process-group` for the provider and every backend. This scope
permits the observed survivor, including when its parent waited for it.
Consumers requiring `workload` are rejected without fallback. MXC's cleanup
limitation remains; the adapter does not promise whole-workload termination.

A surviving child can keep modifying permitted workspace files after
cancellation, timeout, disposal or session replacement. Scratch removal does not
revoke inherited open descriptors. Access restrictions remain in force, and
provider-owned helpers, handles and allocations still require separate cleanup.
Unknown outcomes within the promised group still quarantine the backend.

Upstream [issue #1459][cleanup-issue] reports cross-session survival through the
SDK and raw executor. [Issue #1527][ownership-issue] requests a stronger
ownership contract. The relevant cleanup functions were unchanged in inspected
main commit `6cc87651b94cc3efe134de42100e236a8ce9633a`; main was not executed.

[cleanup-issue]: https://github.com/microsoft/mxc/issues/1459
[ownership-issue]: https://github.com/microsoft/mxc/issues/1527

## Hard helper crash

A separate probe forcibly killed the host process containing MXC. Its sandboxed
`sleep 2` process remained alive immediately afterwards and exited only when
that finite command completed.

Therefore supervisor exit is not termination acknowledgement. The provider must
retain non-secret resource identities before releasing a target and report
unknown completion when the supervisor disappears. Recovery must not claim an
automatic expiry mechanism. Normal IPC disconnect handling can attempt cleanup,
but cannot guarantee cleanup after a hard crash.

## Owned resources and native finalisation

The tested macOS Seatbelt path creates a host supervisor, its native handles and
stdio bridges, the sandboxed process group and private generation directories.
Seatbelt does not provision a persistent container or networking helper for
these modes. Kernel profiles and descriptors retained by scope-excluded
processes are separate from the provider's own references.

The shipped Node [process implementation][node-process] waits for native
`free()` before resolving a successful `wait()`. The [FFI binding][ffi-binding]
awaits completion of that native call, whose ABI result is void. That return is
not proof that every descendant stopped. The adapter additionally requires
normal supervisor close, drained byte channels and an independent group
snapshot. Native fixtures inspect every recorded supervisor and original group,
as well as the removal of private directories.

Active `dispose()` starts asynchronous cleanup. In this adapter that fallback
follows an error path which sends `failed`, not `completed`; it cannot
acknowledge successful execution. Native startup can also fail before returning
a process handle, and failed-spawn cleanup is not an observable completion
certificate. Those paths remain unknown and preserve recovery. Raw background
diagnostics are not copied into workload output. A warning count is
informational, never cleanup evidence. Regressions reject failed finalisation,
contradictory terminal messages and duplicate completion frames.

A bounded native crash regression kills only an owned supervisor handle. It
observes a live original group after the unknown result, retained job records
and failed disposal, then permits the finite target to finish and independently
verifies group exit before fixture recovery. A separate native regression checks
a waiting child in a new session across disposal and Pi session replacement;
survivors retain read/write restrictions while continuing permitted effects.

Linux namespaces and Bubblewrap/slirp helpers require their own resource
inventory and independent release checks. The macOS inventory does not establish
Linux cleanup.

[node-process]:
  https://unpkg.com/@microsoft/mxc-sdk@1.0.1/dist/v1/container-process.js
[ffi-binding]:
  https://unpkg.com/@microsoft/mxc-sdk@1.0.1/dist/bindings/streaming.js

## Automated checks

Before the contract revision, `pnpm check` passed with 55 unit tests and the
macOS provider/Pi suite passed 17 tests. After migration to BYOS `b61c8b0`,
`pnpm check` now passes with 84 unit tests, including the Node peer, narrow
resolver grants, policy defaults, recovery bookkeeping and removal failure,
bounded cleanup, reentrant disposal and late recording outcomes. The build,
formatting, dependency, lint, Markdown and TypeScript checks pass.

`pnpm test:provider` passes 19 macOS tests, including real Pi shell hooks,
process-group acquisition and workload rejection, session replacement,
same-group cleanup, binary output beyond capture limits, host-path write denial,
host-local TCP denial, the accessible UNIX-socket exception, hard supervisor
crash recovery and the cross-session scope boundary. This is experimental
evidence for the tested cases, not a guarantee for every interleaving.

At BYOS `9af3b12` and Pi 1.5.0, `pnpm check` passes with 159 unit tests and 23
integration tests on macOS ARM64 and on the Linux ARM64 and x64 machines, and
under Node 24.21.0 on macOS. The unit tests use an in-memory host filesystem,
Git, clock and supervisor process; the integration tests use the real host.
`pnpm test:provider` passes 23 tests on all three hosts. The network gate passes
all 10 macOS cases and all 8 Linux ARM64 cases. The Linux resolver-socket test
is skipped unless systemd-resolved is running; it passed with systemd-resolved
temporarily started, and failed with the denial removed.

## Command latency

On macOS ARM64, one `:` command took about 370 ms through the backend. The
supervisor spent about 205 ms starting: Node took 40 ms, the MXC SDK 35 ms and
TypeBox about 125 ms. Two `ps` snapshots took about 35 ms each. MXC's
`MxcProcess.wait()` polls for exit every 100 ms, so most of the time between
release and completion was spent waiting for the next poll.

The supervisor now validates parent messages with a small guard instead of
TypeBox, and process-group checks use signal 0 before falling back to `ps`. A
command now takes about 215 ms and opening a backend about 580 ms, down from 1.1
s. Of the remaining time, about 90 ms is supervisor startup and up to 100 ms is
MXC's exit polling. `run()` of the same command takes about 30 ms, which is
close to the floor for a Seatbelt process.

A persistent supervisor per backend would remove the 90 ms startup from every
command. An upstream change to resolve `wait()` without polling would remove
most of the rest.

## System-read-only scope

MXC's Linux baseline binds only system locations: `/bin`, `/sbin`, `/lib*`,
`/usr/{bin,sbin,lib*,libexec,share}`, `/etc` and the resolver directories, with
a new `/dev`, `/proc` and `/tmp`. The Seatbelt baseline reads system directories
under `/System`, `/Library`, `/usr` and `/private/etc`. A probe could not list
or read the macOS home directory, but `stat` of `~/.ssh` succeeded because
Seatbelt allows metadata reads.

`src/filesystem-scope.provider.test.ts` checks that a `system-read-only` sandbox
reads `/etc/hosts` but cannot read a file in the host home directory or list
that directory, and that a configured home-directory grant makes opening fail.
With a home-directory grant under `provider-default`, the same read check fails,
so the probe detects home access.

## Workspace protection

Direct MXC 1.0.1 probes established what each backend can enforce for a
read-only entry inside a writable workspace. Each mutation was checked from the
host afterwards.

| Case                                             | Seatbelt        | Bubblewrap     |
| ------------------------------------------------ | --------------- | -------------- |
| Write, chmod, unlink, rename or rename-over      | Blocked         | Blocked        |
| Alias created inside the sandbox                 | Blocked         | Blocked        |
| Absent entry                                     | Blocked         | Startup fails  |
| Case alias on a case-insensitive volume          | Blocked         | Not applicable |
| Rename of an unprotected parent directory        | Allowed         | Allowed        |
| Hard link created on the host before the sandbox | Writable        | Writable       |
| Protected entry that is a symbolic link          | Target writable | Link removable |

The provider therefore requires protected paths to be covered by a protected
top-level entry, rejects hard-linked files and symbolic links to writable files
in protected trees, and on Linux rejects absent entries and symbolic links.
`src/protection.provider.test.ts` applies the `host-configuration` preset
through Pi and BYOS and repeats the mutation matrix against real sandboxes. It
passes on macOS ARM64 and Linux ARM64. On macOS, the same test fails without the
protection policy because the mutations move `.git` and `.pi`.

The separate `pnpm test:network` gate now runs with an HTTPS endpoint and a
controlled IPv4 peer. The two HTTPS cases pass against `https://example.com`.
The peer supplies TCP, UDP and DNS responses and independently counts unique
probe identifiers. Host controls run before and after target probes. Five of six
peer cases pass: both TCP cases, both UDP cases and denied DNS.

Open-egress DNS failed in that run. The peer recorded the query, but sandboxed
`/usr/bin/dig` printed `;; communications error: permission denied`. The [macOS
DNS notes][macos-dns] trace this to Seatbelt's treatment of receives on
unconnected UDP sockets. The gate now uses `dig +tcp` for the DNS case and keeps
a UDP dig case that expects the refused reply. With those cases, all ten macOS
network cases pass against the OrbStack fixture peer. Ingress, expanded loopback
and IPv6 coverage remain incomplete.

[macos-dns]: macos-dns.md

Host Node and the Nix-provided curl cannot contact these local VM endpoints in
the tested host environment; Apple system tools can. The macOS matrix uses Apple
curl, nc and dig for both target probes and paired host controls. A negative
verdict without a working positive control would not be evidence.

## Packed installation

Both private packages were built and packed at the recorded baseline. A clean
consumer outside both checkouts explicitly resolved the adapter's BYOS
dependency to the local archive through a fixture-only pnpm override. Installed
package paths resolved inside that consumer, not to either checkout.

The consumer passed TypeScript declaration checks and one real-Pi native test.
The test imported all three ESM factories, loaded the optional entrypoints,
executed the compiled supervisor, checked shared writes and complete sh-only
capabilities, rejected a workload requirement and verified private-directory
removal after disposal. Its consumer API came from a physically separate copy of
the archived BYOS build; host registration and the adapter used normal installed
dependencies. Command-handler failures were observable to the runner.

Installation was repeated from a new pnpm store with lifecycle scripts disabled,
side-effects caching disabled and copied package files. TypeScript and the
native test still passed. The downloaded graph included the prebuilt Koffi 3.3.6
macOS ARM64 addon and MXC's packaged native libraries. No global script approval
or native build step was needed on this host. This does not establish
installation requirements for Linux.

The package consumer was a disposable verification fixture, not an additional
ordinary unit test. [Setup instructions][setup] document the private-archive
resolution; [recovery instructions][recovery] describe uncertain ownership.

[setup]: ../README.md
[recovery]: recovery.md

## Remaining gates

The implementation must retain automated regression tests for the supported
completion scope, late cancellation, output failure, deadlines, recovery and
helper crashes. Passing the scratch probes does not establish safe behaviour for
every interleaving.

Linux was unavailable during the initial probes. It has since been tested in
separate isolated OrbStack 2.2.5 Ubuntu 24.04.5 machines: native ARM64 and amd64
under Rosetta, using kernel `7.2.12-orbstack-00394-gbecdd6130068`. Node 24.22.2
archives were checksum-verified; pnpm 12.15.0 installed the recorded dependency
graph with scripts disabled. Native probes ran as UID 501, not root.

Direct Bubblewrap 0.9.0 user/PID/network namespace probes pass. Public MXC
`getPlatformSupport()` reports Bubblewrap and network enforcement support when
called from an ordinary `.mjs` file. An initial inline `--input-type=module`
probe gave a false timeout because SDK file workers inherit execution flags;
that harness result is not evidence of missing Bubblewrap.

The initial ARM64 check passed 74 unit tests, but its native provider gate
failed 18 of 19 cases during opening. A public `/v1` spawn of a finite `:`
command crashed with status 139 on ARM64 and status 134 on amd64/Rosetta.

GDB isolated the crash to SDK warning-string cleanup. OrbStack's
`/etc/resolv.conf` points to `/opt/orbstack-guest/etc/resolv.conf`, outside the
baseline mounts. MXC emitted a missing-mount warning, and the process crashed
while freeing its JSON string. Granting read-only access to that exact resolver
file removed the warning and made the same public spawn succeed. A diagnostic
Koffi downgrade did not fix the crash; the original dependency graph was
restored. No SDK or native-library patch was made.

The adapter now resolves the Linux system resolver and verifies it is a regular
file before adding an exact read-only grant. Directories are rejected, missing
files add no grant, and other access errors remain errors. Workspace overlap
checks include the resolved file. No broad `/opt` or home grant was added. The
general SDK warning-string ownership defect still needs upstream work;
unexpected helper failures continue to preserve uncertainty and recovery.

With that runtime correction, all 19 provider/Pi tests pass on both ARM64 and
amd64/Rosetta, as well as macOS. The portable assertions preserve legitimate
platform differences: POSIX shells may return different nonzero redirection
statuses, Bubblewrap reports code 143 for the signalled test shell, and Linux
may stop the original group after helper death. Unknown completion and retained
recovery remain required after the lost acknowledgement.

The full `pnpm check` now passes on both Linux machines: build, formatting,
dependency checks, ESLint, Markdown, 84 unit tests and TypeScript. The provider
suite passes 19 cases on each machine, and the controlled HTTPS/TCP/UDP/DNS gate
passes all eight cases on each. Direct dig 9.18.39 probes also return the
expected UDP answer with ingress and host loopback denied under open egress.

The checks exposed two harness assumptions: a group can disappear between a
crash snapshot and a later effect request, and unknown transport completion may
truncate output. Crash coverage now accepts either permitted effects or broader
cleanup and awaits the finite workload deadline before teardown. Failed
finalisation checks permit only prefixes of known workload output; healthy
completion checks still require complete output. Diagnostic scripts were moved
outside the copied checkout before formatting validation.

A subsequent controlled [resolver-grant investigation][linux-dns] found that the
automatic exact-file grant disables MXC's resolver substitution for
loopback-stub hosts. Native and public-SDK comparisons confirmed both the
working substitution and the contrasting out-of-baseline non-loopback case. The
adapter now skips the grant for loopback-only resolvers. With a temporary
loopback-only resolver and forwarding stub on the ARM64 machine, the external
HTTPS test passes under open egress with the corrected adapter and fails with
the previous grant. The [resolver notes][linux-dns] describe the check.

[linux-dns]: linux-dns.md

The namespace/slirp allocation inventory, expanded ingress/loopback/IPv6 matrix
and Linux packed-install gate remain incomplete. Native x64 hardware remains
unverified. Passing these cases is not complete platform acceptance.
