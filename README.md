# Experimental MXC provider for Pi

Loading this extension activates Microsoft MXC for BYOS consumers in Pi. On
Apple Silicon, the Codex auto-review preset can investigate a live workspace
through a separate read-only backend with denied networking. Loading the package
also runs Pi's active shell, file and search tools through BYOS.

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
- host services reached through Unix sockets under provider-default networking,
  as described in [Network access](#network-access);
- direct host calls from other extensions or independent MCP servers.

## Support and prerequisites

| Host        | Status                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| macOS ARM64 | Native, real Pi and packed-install checks pass on the test host            |
| Linux x64   | Provider/Pi tests pass under OrbStack/Rosetta; native hardware unverified  |
| Linux ARM64 | Provider/Pi tests pass on OrbStack; resource/network acceptance incomplete |
| macOS x64   | Not supported by the inspected MXC archive                                 |
| Windows     | Not supported                                                              |

The tested baseline is Node **24.21.0** and **24.22.2**, pnpm **12.15.0**, Pi
**1.5.0**, TypeBox **1.3.27** and MXC **1.0.1**. The manifest pins the BYOS SDK
to commit `4f7a56b0c3db3a7ec94553d83b125d5f59517e39`, the same revision as the
[auto-review fork][auto-review]. A source build requires a C compiler and the
target platform's headers. Build the archive on the target OS and architecture.

[auto-review]:
  https://github.com/iainlane/pi-packages/commit/0b2abd69dfd8eadf7750a6267fb843c95d63667d

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

Install the pinned dependencies and build the provider:

```sh
cd /trusted/pi-byos-mxc
pnpm install --frozen-lockfile
pnpm build
```

Register the built package once for your Pi sessions:

```sh
pi install /trusted/pi-byos-mxc
```

For a single session, use `pi -e /trusted/pi-byos-mxc` from the target
workspace.

The package registers the provider and replaces the shell, file and search tools
under their original names. Pi 1.5 enables `read`, `bash`, `edit` and `write` by
default. If you enable `ls`, `find` or `grep`, those calls also use MXC. Your
existing tool selection applies.

On Apple Silicon, a compatible auto-review broker can give the `codex` reviewer
a fresh, read-only copy of the proposed command's workspace. Edits from your
editor stay visible to ordinary Pi tools and appear in the next review. The
reviewer must explicitly accept read-only access to system and runtime files.
Networking is denied. A review that requires `workspace-only` reads, or cannot
acquire a snapshot, uses the transcript alone.

MXC clones files on the same filesystem as its temporary directory. The
workspace must support file cloning and fit within 512 MiB, 100,000 entries and
128 directory levels. MXC rejects a changing source, a nested mount, special
files, multiply linked files, immutable files, and links that cannot resolve
inside the copy. Each review releases its own copy when it finishes.

The shell integration includes user-shell commands and the configured
outside-execution approval flow. The six file and search tools execute Pi's
implementations with the same filesystem and network policy as a sandbox shell.
This includes read path resolution, image decoding, edit previews and the `rg`
and `fd` subprocesses. Load `dist/diagnostics.js` for BYOS status.

### Personal settings

MXC reads `mxc-sandbox.json` from Pi's agent directory. To use a writable editor
on macOS with system reads and denied networking for ordinary tool calls, use:

```json
{
  "mode": "strict",
  "network": "denied"
}
```

A missing file selects `standard` mode with `network: "off"`. Standard mode
allows configured read-only grants outside the system directories. Strict mode
limits them to system and runtime paths. Both allow workspace writes.
`read-only` mode removes workspace writes. All three modes protect the
host-configuration preset by default. Add workspace entries with `protectPaths`.
The file also accepts `backend`, `shells`, `userShell`, `readonlyPaths` and
`environment`.

The network settings `off` and `on` select MXC's `ip-denied` and `open-egress`
modes. The separate `denied` setting requests the native offline policy. A
reviewer can request that policy independently of the editor's setting. Each
effective policy has a separate backend and private scratch directory.

Existing installations can keep their personal `byos.json` with provider `mxc`,
including its policy, protection preset, provider configuration, cleanup budgets
and outside-execution settings. Use one settings file. Reload Pi after editing
legacy settings.

With `system-read-only`, configured grants and shells must resolve inside the
system and runtime directories:

| Host  | Directories                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| macOS | `/bin`, `/sbin`, `/usr`, `/System/Library`, `/System/Applications`, `/Library`, `/Applications`, `/opt`, `/private/etc`, `/nix/store` |
| Linux | `/bin`, `/sbin`, `/usr`, `/lib*`, `/etc`, `/opt`, `/nix/store`, `/run/current-system`                                                 |

The provider grants the running Node executable and the packaged tool runtime
read-only. On macOS it looks for installed `fd` and `rg` in Pi's personal `bin`
and system installations on the host search path. It grants the selected
executables and their resolved system libraries. An explicit `environment.PATH`
selects your toolchain. Supply `readonlyPaths` for nonstandard installations and
their libraries. On macOS, filesystem metadata such as existence, size and
modification times remains visible outside the readable trees.

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

### Search from other extensions

BYOS consumers can request `search.find` and `search.grep`. Both run in the same
sandbox as shell commands. Find returns relative paths in UTF-16 code unit
order, with a trailing slash for directories. Patterns use Node's
`path.matchesGlob` on the basename, or on the relative path when the pattern
contains a slash. Searches skip `.git` and `node_modules`, include other hidden
entries when the pattern matches, and ignore Git ignore files.

Grep matches each UTF-8 line with a RE2 regular expression or a literal string.
It skips binary files and files larger than 8 MiB. The limit counts matching
lines. Both searches report truncation only when another result exists. A
directory listing or grep response larger than the worker's 8 MiB budget causes
the operation to fail.

### Network access

`ip-denied` requests direct IP denial. `open-egress` permits external outbound
IP traffic. Both modes request ingress and host-loopback IP denial. Enforcement
is delegated to the pinned MXC backend. Ingress, expanded loopback coverage and
IPv6 validation are incomplete.

On macOS ARM64, BYOS `networkAccess: "denied"` selects a separate Seatbelt
profile. The profile denies operations by default. It grants the workspace,
scratch and runtime file access independently of network access. IP sockets,
connections to pathname Unix sockets and Mach service lookup receive no allow
rule. The shell inherits these restrictions across fork and exec. The default
search path checks the native Git in Apple's developer tools before the
`/usr/bin/git` launcher.

The following Unix socket exceptions apply to provider-default networking. A
sandboxed command can connect to a host service's UNIX socket and ask it to make
network connections on the command's behalf. With MXC's generated profiles,
reachable sockets include:

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
under the offline macOS policy includes the exit code or signal from the kernel.
The supervisor registers a kqueue observer before releasing the target. Under
provider-default networking MXC can report unavailable status, which Pi displays
as a failed command.

Consumers may require `terminationScope: 'workload'`. Acquisition then fails
without fallback or replay. Uncertain original-group termination or native
allocation cleanup also fails; excluded survivors do not justify ignoring owned
resource leaks. Surviving children may interfere with later generations that
reuse the workspace. Pi full-output references are host transcript paths, not
automatically readable sandbox paths.

## Packed installation and verification

Build and pack on the intended platform. The archive includes the native
helpers, the Pi tool worker and the pinned BYOS SDK.

```sh
pnpm build
pnpm pack --pack-destination /trusted/artifacts
```

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
The integration and provider tests need Git. The macOS search tool test needs fd
and ripgrep on the host search path. The HTTPS endpoint must return 200. Replace
the example peer address with a reachable controlled IPv4 fixture. The source
checkout includes `script/network-peer.ts`; [fixture
instructions][network-fixtures] describe its TCP, UDP, DNS and observation
endpoints. The gate checks host reachability before and after sandbox probes,
plus independent peer request counters. Invoked gates fail when runtimes or
fixtures are missing. On macOS, an additional `dig` case checks that the query
reaches the peer and the reply is refused, so a change in that behaviour fails
the gate. See the evidence document for actual results and gaps.

[network-fixtures]: docs/network-fixtures.md
