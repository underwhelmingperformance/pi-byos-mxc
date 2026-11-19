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

## Threat model

The provider confines commands that run through BYOS. It aims to stop them from:

- reading or changing host files outside the workspace, the private scratch
  directory and configured read-only grants;
- changing protected workspace entries, when the policy requests protection;
- reaching the network directly when `network` is `ip-denied`;
- keeping processes in their original process group running after the command
  ends.

It does not aim to make the workspace safe to use afterwards. The workspace is a
shared host directory, so anything a command writes there, such as source files,
package scripts, build files or a new nested Git repository, can run on the host
later. [Protected workspace resources](#protected-workspace-resources) reduce
the risk for files that host tools run without the user choosing to run them,
but they do not remove it.

The provider also does not stop:

- processes that leave their process group, which can keep running after
  cancellation or disposal;
- host services that a command reaches through a UNIX socket from making network
  connections on its behalf, as described in [Network access](#network-access);
- Pi's file, edit and search tools, other extensions and MCP servers, which run
  on the host outside the sandbox.

## Support and prerequisites

| Host        | Status                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| macOS ARM64 | Native, real Pi and packed-install checks pass on the test host            |
| Linux x64   | Provider/Pi tests pass under OrbStack/Rosetta; native hardware unverified  |
| Linux ARM64 | Provider/Pi tests pass on OrbStack; resource/network acceptance incomplete |
| macOS x64   | Not supported by the inspected MXC archive                                 |
| Windows     | Not supported                                                              |

The tested baseline is Node **24.21.0** and **24.22.2**, pnpm **12.15.0**, Pi
**1.5.0**, TypeBox **1.3.27**, MXC **1.0.1** and private BYOS commit
`9af3b122d87bf93478918a428781cb92684876a5` (service version 1). MXC imports use
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

The adapter currently has a normal local-file BYOS dependency. The BYOS checkout
exports its TypeScript sources, which Node does not load from `node_modules`. Pi
loads extensions through jiti, so `pi -e` works; importing `dist/extension.js`
with plain Node does not. Packed archives use BYOS's compiled output. Both
packages are private; no registry release is required or implied. A matching
`0.0.0` version does not establish the BYOS baseline. Verify the checkout commit
and rebuild before refreshing an existing local dependency.

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

A complete explicit personal policy replaces the default. Partial policies are
rejected. Workspace access can be `read-write` or `read-only`, so a personal
policy or a consumer's acquisition request can make the workspace read-only.
Each negotiated policy gets its own backend and private scratch directory.

The filesystem scope can be `provider-default` or `system-read-only`. Both use
the same MXC mounts. With `system-read-only`, opening fails with
`UnsupportedSandboxPolicyError` when a configured read-only grant or shell
resolves outside the platform's system and runtime directories:

| Host  | Directories                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------- |
| macOS | `/bin`, `/sbin`, `/usr`, `/System`, `/Library`, `/Applications`, `/opt`, `/private/etc`, `/nix/store` |
| Linux | `/bin`, `/sbin`, `/usr`, `/lib*`, `/etc`, `/opt`, `/nix/store`, `/run/current-system`                 |

A toolchain under the home directory, such as one installed by mise, therefore
needs `provider-default`. Neither scope lets commands list or read the host home
directory. On macOS, Seatbelt still allows file metadata reads, so a command can
learn whether a known path exists and its size and times.

The provider rejects `workspace-only` filesystem scope because MXC always
exposes host system directories. It rejects strict `denied` network access
because sandboxed commands can reach host services through UNIX sockets, as
described in [Network access](#network-access).

## Protected workspace resources

The provider supports BYOS `workspaceProtection`, including the
`host-configuration` preset. It grants each protected workspace entry read-only
inside the writable workspace, so sandboxed commands cannot change Git metadata,
Pi settings, direnv files or editor configuration that the host later runs.

```json
{
  "workspaceProtection": {
    "preset": "host-configuration",
    "additionalPaths": [".husky"]
  }
}
```

Opening fails with `UnsupportedSandboxPolicyError` and a diagnostic when the
backend cannot keep a resource immutable:

- On macOS, a protected path must be a direct entry of the workspace or lie
  inside one, such as `.husky` for `.husky/_`. Seatbelt cannot stop a sandboxed
  command from renaming the writable directory that contains a nested path and
  creating a replacement. On Linux, the provider grants each directory above a
  protected path as a separate mount, which cannot be renamed, so nested paths
  need no such entry.
- A protected file must not have another hard link, and a symbolic link inside a
  protected tree must not point to writable workspace files.
- On Linux, a protected path and the directories above it must not be symbolic
  links, because Bubblewrap mounts the target of a link instead of the link.

Absent paths are protected too. Seatbelt denies them directly. Bubblewrap can
only mount over a path that exists, so on Linux the provider creates an empty
placeholder file at each absent protected path, or at its first missing
directory, before each command, and mounts it read-only. Like the mount points
that `sandbox-runtime` and Codex create, a placeholder is visible on the host
while the command runs, so host tools may react to it: for example, direnv
reports an empty, blocked `.envrc`. The provider removes a placeholder after the
last command using it has stopped, and only while it is still the empty file
that the provider created. Deleting a placeholder on the host during a command
lifts its protection inside that command's sandbox. When a command's outcome is
unknown, its placeholders stay, and its recovery record lists them.

For Git metadata, the provider asks host Git for the repository directory, the
common directory, the effective hooks directory and every configuration include.
It protects the ones inside the workspace. A hooks path such as `.husky/_` needs
`.husky` in `additionalPaths`. Scripts that a protected hook calls are not
protected unless they are also listed. The provider reads these locations when
the backend opens; later host-side changes to the Git configuration need a new
backend. Without Git installed, a workspace with a `.git` entry cannot be
protected.

Protection applies to commands run through BYOS. It does not make modified
source, package scripts or build files safe to run on the host.

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

The canonical host workspace is shared. With `read-write` access, sandbox writes
modify the project immediately. With `read-only` access, the sandbox can read
the project but not modify it. In both modes, host file-tool changes are visible
immediately. Each backend also has a private writable scratch/home directory,
which is removed on successful disposal. Control records are separate from
writable scratch. The backend permits baseline host-system reads and explicit
read-only grants; it does not promise workspace-only reads or general resource
quotas.

On Linux, the adapter grants read-only access to the canonical
`/etc/resolv.conf` target when that file lists a routable nameserver, including
when the file is outside MXC's baseline mounts. When every nameserver is a
loopback address, as with systemd-resolved's stub, the adapter adds no grant.
MXC then points the sandbox at slirp's DNS forwarder, which forwards queries to
the host's resolver. The [Linux resolver notes][linux-dns] describe the
mechanism.

### Network access

`ip-denied` requests direct IP denial. `open-egress` permits external outbound
IP traffic. Both modes request ingress and host-loopback IP denial. Enforcement
is delegated to the pinned MXC backend. Ingress, expanded loopback coverage and
IPv6 validation are incomplete.

Neither mode is BYOS strict denied networking. A sandboxed command can connect
to a host service's UNIX socket and ask it to make network connections on the
command's behalf. MXC 1.0.1 provides no option that blocks UNIX socket
connections, so the adapter cannot close this route in general. Reachable
sockets include:

- sockets in the writable workspace, which any host process can create;
- on Linux, sockets in read-only grants, because a read-only mount does not
  prevent connecting to a socket;
- on macOS with `open-egress`, every socket on the host, including the
  ssh-agent, Nix daemon and launchd sockets.

MXC's Linux baseline also mounts the host resolver directories, which can
contain systemd-resolved's sockets. Through those sockets, a sandboxed command
could make the host resolve names even with `ip-denied`. Before each command,
the adapter denies every socket in `/run/systemd/resolve`, `/run/NetworkManager`
and `/run/resolvconf`. DNS still works with `open-egress`, through the resolver
file or slirp's forwarder.

On macOS, Seatbelt checks receives on an unconnected UDP socket against inbound
rules, which MXC denies. Under open egress, a program that sends a UDP request
from such a socket can send the request but cannot receive the reply. Apple's
`dig`, `host` and `nslookup` work this way and print
`;; communications error: permission denied`. The system resolver works, as do
connected-UDP clients such as Node's resolver and `dig +tcp`. The evidence is in
the [macOS DNS notes][macos-dns].

[linux-dns]: docs/linux-dns.md
[macos-dns]: docs/macos-dns.md

Shell requests use native `sh` or a verified Bash executable. There is no argv
emulation, PowerShell, PTY or interactive stdin. After the release barrier,
target stdin receives EOF. The working directory must exist; a missing directory
fails before the command starts. Output remains bytes. A verified native result
with unavailable status remains unavailable; the adapter does not invent a
signal or exit code. Pi receives null exit details and failed-command
presentation.

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
  @earendil-works/pi-coding-agent@1.5.0 typebox@1.3.27 --ignore-scripts
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

`pnpm check` runs the unit tests, which replace the host filesystem, Git, clock
and supervisor process with in-memory implementations, and the integration
tests, which use the real host. `pnpm test:provider` runs real MXC sandboxes.
The integration and provider tests need Git. The HTTPS endpoint must return 200.
Replace the example peer address with a reachable controlled IPv4 fixture. The
source checkout includes `script/network-peer.ts`; [fixture
instructions][network-fixtures] describe its TCP, UDP, DNS and observation
endpoints. The gate checks host reachability before and after sandbox probes,
plus independent peer request counters. Invoked gates fail when runtimes or
fixtures are missing. On macOS, an additional `dig` case checks that the query
reaches the peer and the reply is refused, so a change in that behaviour fails
the gate. See the evidence document for actual results and gaps.

[network-fixtures]: docs/network-fixtures.md
