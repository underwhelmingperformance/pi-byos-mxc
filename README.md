# Experimental MXC provider for Pi

This private extension registers Microsoft MXC as BYOS provider `mxc`. It
sandboxes shell commands from cooperating BYOS consumers. The optional
`pi-tools` entrypoint routes Pi's shell tools through BYOS. File, edit and
search tools, other extensions and MCP processes remain host operations.

Termination covers the direct process and its original supervised POSIX process
group. A child that changes group or session can continue modifying permitted
files after completion, cancellation, timeout, disposal or session replacement,
even when its parent waited. Access restrictions remain effective. Disposal is
not permission revocation or a workspace transaction. Do not use this provider
when whole-workload termination is required.

The implementation is experimental, not production-ready. See the [verification
evidence][evidence] and [recovery procedure][recovery].

[evidence]: docs/feasibility.md
[recovery]: docs/recovery.md

## Support and prerequisites

| Host        | Status                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| macOS ARM64 | Native, real Pi and packed-install checks pass on the test host            |
| Linux x64   | Provider/Pi tests pass under OrbStack/Rosetta; native hardware unverified  |
| Linux ARM64 | Provider/Pi tests pass on OrbStack; resource/network acceptance incomplete |
| macOS x64   | Not supported by the inspected MXC archive                                 |
| Windows     | Not supported                                                              |

The tested baseline is Node **24.22.2**, pnpm **12.15.0**, Pi **1.4.0**, TypeBox
**1.3.27**, MXC **1.0.1** and private BYOS commit
`b61c8b012391c157548f1ada7f3f8643638b01f0` (service version 1). MXC imports use
its public `/v1` API.

Linux requires unprivileged user namespaces and Bubblewrap 0.5.0 or newer. Open
egress needs additional slirp, iproute2, util-linux and firewall prerequisites.
The inspected slirp transport lacks IPv6 connectivity. See the pinned
[Bubblewrap guide][bubblewrap]. Root-only tests cannot establish unprivileged
support. The [Seatbelt guide][seatbelt] describes the macOS backend.

[bubblewrap]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/docs/backends/bwrap/bubblewrap-backend.md
[seatbelt]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/docs/backends/seatbelt/seatbelt-backend.md

## Local setup

Keep this checkout, BYOS, Node and their dependencies outside every writable
target workspace. The provider rejects writable-grant overlaps with trusted
runtime code or private control metadata, including symlink aliases. Do not
install the runtime inside the project that the sandbox will modify.

Use the recorded BYOS checkout as a sibling, then build both packages:

```sh
cd /trusted/pi-bring-your-own-sandbox
pnpm install --frozen-lockfile
pnpm build

cd /trusted/pi-byos-mxc
pnpm install --frozen-lockfile
pnpm check
```

The adapter currently has a normal local-file BYOS dependency. Both packages are
private; no registry release is required or implied. A matching `0.0.0` version
does not establish the BYOS baseline. Verify the checkout commit and rebuild
before refreshing an existing local dependency.

No dependency build scripts were needed for the tested macOS ARM64 path. Project
configuration denies scripts for `koffi`, `node-pty`, `protobufjs` and
`@google/genai`. Do not enable scripts globally to make installation succeed.
Other platforms need their own installation and native-asset checks.

From a separate target workspace, load the compiled entrypoints explicitly:

```sh
pi -e /trusted/pi-byos-mxc/dist/extension.js \
   -e /trusted/pi-byos-mxc/dist/pi-tools.js \
   -e /trusted/pi-byos-mxc/dist/diagnostics.js
```

The default factory only registers the provider. It does not select MXC, open a
sandbox or replace tools. `pi-tools` enables BYOS shell routing; `diagnostics`
provides BYOS diagnostics. Package metadata automatically lists only the
provider factory. Do not load multiple copies of a factory.

Selection is personal configuration. Put the following in `byos.json` in your Pi
agent directory if you choose to activate MXC:

```json
{
  "provider": "mxc",
  "cleanup": {
    "cancellationGraceMs": 10000,
    "disposalTimeoutMs": 15000
  },
  "userShell": "bash",
  "providerConfig": {
    "network": "ip-denied"
  }
}
```

These cleanup values are examples, not measured requirements. The adapter uses
the effective BYOS budgets and never silently extends them. Set `userShell` to
`"sh"` when Bash is not available; Bash is advertised by an opened backend only
after successful execution.

The declared default policy is:

```json
{
  "workspaceAccess": "read-write",
  "filesystemScope": "provider-default",
  "networkAccess": "provider-default"
}
```

A complete explicit personal policy replaces the default. Partial policies,
read-only workspaces, `workspace-only` filesystem scope and strict `denied`
network access are rejected.

## Configuration and effective boundary

`providerConfig` accepts only:

- `backend`: `auto`, `seatbelt` or `bubblewrap`. Explicit choices must match the
  host; the adapter does not fall back to another backend.
- `network`: `ip-denied` (default) or `open-egress`.
- `shells`: absolute trusted `sh` and optional `bash` paths. The defaults are
  `/bin/sh` and `/bin/bash`.
- `readonlyPaths`: additional absolute read-only grants for required tools. Use
  narrow files or toolchain directories, not the host home, `/`, all of `/nix`
  or the whole Nix store. Read grants can expose credentials and sockets.
- `environment`: explicit string defaults for the target shell. Host environment
  variables and credentials are not copied. Per-command string overrides and
  null deletions apply only to the target environment.

The canonical host workspace is shared and writable. Host file-tool changes are
visible immediately, and sandbox writes modify the project immediately. A
generation also has a private writable scratch/home directory, which is removed
on successful disposal. Control records are separate from writable scratch. The
backend permits baseline host-system reads and explicit read-only grants; it
does not promise workspace-only reads or general resource quotas. On Linux, the
canonical `/etc/resolv.conf` target is granted read-only as an exact regular
file, including when a custom resolver is outside MXC's baseline mounts.

`ip-denied` requests direct IP denial. `open-egress` permits external outbound
IP traffic. Both modes request ingress and host-loopback IP denial. Enforcement
is delegated to the pinned MXC backend. Accessible filesystem UNIX sockets can
contact host services, so these modes do not implement BYOS strict denied
networking. The current macOS network gate passes seven of eight cases. A DNS
query reaches the controlled peer under open egress, but sandboxed `dig` reports
`;; communications error: permission denied`. DNS acceptance remains blocked;
ingress, expanded loopback coverage and IPv6 validation are also incomplete.

Shell requests use native `sh` or a verified Bash executable. There is no argv
emulation, PowerShell, PTY or interactive stdin. After the release barrier,
target stdin receives EOF. Output remains bytes. A verified native result with
unavailable status remains unavailable; the adapter does not invent a signal or
exit code. Pi receives null exit details and failed-command presentation.

Consumers may require `terminationScope: 'workload'`. Acquisition then fails
without fallback or replay. Uncertain original-group termination or native
allocation cleanup also fails; excluded survivors do not justify ignoring owned
resource leaks. Surviving children may interfere with later generations that
reuse the workspace. Pi full-output references are host transcript paths, not
automatically readable sandbox paths.

## Packed installation and verification

Pack both built private packages into a directory outside the checkouts:

```sh
cd /trusted/pi-bring-your-own-sandbox
pnpm pack --pack-destination /trusted/artifacts

cd /trusted/pi-byos-mxc
pnpm pack --pack-destination /trusted/artifacts
```

In a clean consumer, explicitly resolve the adapter's private BYOS dependency to
the archived baseline. For pnpm, add this fixture-local configuration to
`pnpm-workspace.yaml`:

```yaml
---
overrides:
  'pi-byos-mxc>pi-bring-your-own-sandbox': file:/trusted/artifacts/pi-bring-your-own-sandbox-0.0.0.tgz
```

Install the archives with the tested host peers:

```sh
pnpm add /trusted/artifacts/pi-byos-mxc-0.0.0.tgz \
  /trusted/artifacts/pi-bring-your-own-sandbox-0.0.0.tgz \
  @earendil-works/pi-coding-agent@1.4.0 typebox@1.3.27 --ignore-scripts
```

This override is local to the consumer. Do not resolve the private dependency
from an unavailable registry release or assume the adapter archive includes
BYOS. Future CI must provision the baseline checkout or archive explicitly.

Development checks:

```sh
pnpm check
pnpm test:provider
MXC_EGRESS_TEST_URL=https://example.com \
  MXC_MATRIX_HOST=10.240.1.37 pnpm test:network
```

The HTTPS endpoint must return 200. Replace the example peer address with a
reachable controlled IPv4 fixture. The source checkout includes
`script/network-peer.ts`; [fixture instructions][network-fixtures] describe its
TCP, UDP, DNS and observation endpoints. The gate checks host reachability
before and after sandbox probes, plus independent peer request counters. Invoked
gates fail when runtimes or fixtures are missing, and the known DNS failure is
not skipped. See the evidence document for actual results and gaps.

[network-fixtures]: docs/network-fixtures.md
