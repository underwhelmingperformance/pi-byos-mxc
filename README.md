# Experimental MXC provider for Pi

Loading this extension activates Microsoft MXC for BYOS in Pi. Pi's shell, file
and search tools run inside MXC on the live checkout, so workspace writes appear
on the host immediately. A shell command can request an escalation. BYOS
presents the destination and its restrictions before an escalation can run. On
Apple Silicon, reviewers can inspect a private copy with networking denied.

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

- accessing host files beyond the selected policy and approved path grants;
- changing protected workspace entries;
- reaching the network directly when the policy has `network: false`;
- keeping processes in their original process group running after the command
  ends.

The workspace is a shared host directory. A sandboxed command can write files
that later run on the host, including source files, package scripts and build
files. A command can also create a nested Git repository.
[Protected workspace resources](#protected-workspace-resources) reduce the risk
for files that host tools run without the user choosing to run them, but they do
not remove it.

The provider also does not stop:

- processes that leave their process group, which can keep running after
  cancellation or disposal;
- host services reached through Unix sockets with the generated MXC profiles, as
  described in [Network access](#network-access);
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
to [BYOS revision `caf0963`][byos-pin]. Auto-review needs a version that uses
review source identities from the redesigned SDK. A source build requires a C
compiler and the target platform's headers. Build the archive on the target OS
and architecture.

[byos-pin]:
  https://github.com/underwhelmingperformance/pi-bring-your-own-sandbox/commit/caf09630558859d62c34b3242db865756b80bec3

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

MXC and the permission extensions can load in either order. BYOS records the
pending shell call on `tool_execution_start`, before the permission extensions
look up its review source during `tool_call`.

`pi install` appends new entries to `packages` in `~/.pi/agent/settings.json`.
`pi-permission-auto-review` needs to load before `pi-permission-system` so it
can capture the complete tool input.

```json
{
  "packages": [
    "/trusted/pi-byos-mxc",
    "npm:@mzwing/pi-permission-auto-review",
    "npm:@gotgenes/pi-permission-system"
  ]
}
```

For a single session, run `pi -e /trusted/pi-byos-mxc` from the target
workspace.

To enable `/byos status`, `/byos providers` and `/byos log`, add the absolute
path to the diagnostics extension under `extensions` in the same
`settings.json`. Pi loads the local package from its checkout, so use the path
under `/trusted/pi-byos-mxc`.

```json
{
  "extensions": ["/trusted/pi-byos-mxc/dist/diagnostics.js"]
}
```

The package registers the provider and replaces the shell, file and search tools
under their original names. Pi 1.5 enables `read`, `bash`, `edit` and `write` by
default. If you enable `ls`, `find` or `grep`, those calls also use MXC. Your
existing tool selection applies.

On Apple Silicon, BYOS consumers can copy the host workspace or an existing MXC
sandbox. A reviewer can keep a copy across tool calls while you continue
editing. The copy accepts writes. Edits stay in the copy, and a second copy
includes the parent copy's edits. Close each copy when finished to release its
files and scratch directory.

```typescript
const review = await sandbox.copy({
  access: {
    hostWorkspaceWrites: 'prevented',
    network: 'prevented',
    hostUserData: 'prevented'
  }
});
```

MXC needs read access to host system files in both live and copied workspaces.
The SDK rejects a copy request with `hostSystemFiles: 'prevented'`.

### Copy limits

MXC reports the first applicable workspace constraint as a startup diagnostic:

- The workspace exceeds 100,000 entries. Remove generated files before copying.
  The root and every file, directory and link count, including those in `.git`
  and `node_modules`.
- The workspace exceeds 128 levels of nesting. Move or remove deeply nested
  entries before copying.
- The workspace exceeds 512 MiB of regular file data. Move or remove large files
  before copying.
- The workspace has an absolute symbolic link. Replace it with a relative link
  that resolves inside the copy, or remove it. Examples include `result` from
  `nix build` and links from nix-direnv to `/nix/store`.
- A symbolic link does not resolve inside the copy. Fix the link or remove it
  before copying.
- The workspace crosses a mount. Unmount it or copy a workspace on a single
  filesystem.
- The workspace has an immutable or append-only entry. Remove the flags or move
  the entry before copying.
- The workspace contains a special file. Remove sockets, FIFOs and devices
  before copying.
- The workspace contains a multiply linked regular file. Replace hard links with
  independent files before copying.
- The workspace changed while MXC was copying it. Stop the processes that modify
  it and retry.
- A path in the copy exceeds the system path length limit. Shorten the path
  before copying.
- The copy requires file cloning on the same filesystem. Move the workspace to a
  filesystem that supports cloning and contains the temporary directory.

Other snapshot helper failures produce the generic `MXC opening failed`
diagnostic.

The SDK registers user-shell commands, Bash escalation and Pi's six file and
search tools. Pi uses the sandbox facade for filesystem operations and edit
previews. The SDK's file helper runs inside MXC and limits file reads and writes
to 16 MiB per operation. Pi's `grep` uses the target's `rg` when available. Pi's
`find` uses the provider's search operation.

### Settings

`mxc-sandbox.json` in Pi's agent directory contains SDK settings and MXC
settings at the top level. Reload Pi after changing it. The following settings
match the SDK default policy at the pinned revision.

```json
{
  "policy": {
    "hostWorkspaceWrites": true,
    "network": false,
    "hostUserData": "read-only",
    "hostSystemFiles": "read-only"
  },
  "protectPaths": [".husky"]
}
```

Omit `policy` to use the SDK default. If you supply `policy`, include all four
properties. The other shared keys are:

- `userShell` selects the shell for Pi's user commands. MXC provides `sh` and
  `bash`. The default is `sh`.
- `allowEscalation` controls whether Bash may request escalations. The default
  is `true`.
- `cleanup` sets `cancellationGraceMs` and `disposalTimeoutMs`. Each accepts an
  integer from 1 to 300,000. The SDK defaults are 5,000 and 10,000 ms unless the
  embedding host supplies defaults.

MXC no longer reads `byos.json`. Move settings into `mxc-sandbox.json` and use
the shared `policy` in place of `mode` and `network`. The `readonlyPaths` key
has been removed. Use the policy for host file access and escalation for
additional paths.

MXC also accepts these keys:

- `backend` selects `auto`, `seatbelt` or `bubblewrap`. An explicit choice must
  match the host.
- `shells` configures the absolute paths to the shell executables. The defaults
  are `/bin/sh` for `sh` and `/bin/bash` for `bash`. MXC opens a backend only if
  both shells start and pass their probes.
- `protectPaths` adds read-only workspace paths. Use relative paths.
- `environment` sets string defaults for the target shell. MXC does not copy the
  host environment. Per-command overrides and deletions apply only in the
  target.

Every profile grants read-only access to the running Node executable, its linked
libraries and the packaged tool runtime. MXC uses `otool` on macOS and `ldd` on
Linux to find the libraries. On macOS MXC also looks for `fd` and `rg` in Pi's
personal `bin` and in system installations on the host search path. MXC grants
the selected executables and resolves their libraries the same way. A library
grant covers its Nix store output or Homebrew Cellar package when applicable,
and the individual file in other installations. `environment.PATH` can select
tools that are already readable under the chosen profile.

## Protected workspace resources

MXC protects Git metadata, `.pi`, `.envrc`, `.direnv`, `.vscode`, `.idea` and
`.devcontainer` whenever a backend can write to its workspace. Add project
entries through `protectPaths`:

```json
{
  "protectPaths": [".husky"]
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
  links, because Bubblewrap follows symbolic links when it mounts protected
  paths.

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
`.husky` in `protectPaths`. Scripts that a protected hook calls are not
protected unless they are also listed. The provider reads these locations when
the backend opens; later host-side changes to the Git configuration need a new
backend. Without Git installed, a workspace with a `.git` entry cannot be
protected.

Protection applies to commands run through BYOS. It does not make modified
source, package scripts or build files safe to run on the host.

## Configuration and effective boundary

MXC advertises separate profiles for the live checkout and for copies. BYOS
selects a profile before allocation. The live checkout can be writable or
read-only inside MXC. Host changes are visible in either case. Copies never
write to the live checkout. Each backend has a writable private scratch
directory. MXC removes it on successful disposal. Recovery records are stored
separately.

Every profile allows host system reads and prevents general host system writes.
A `hostUserData: "denied"` profile excludes other host user files. A macOS
`hostUserData: "read-only"` profile can read those files except known credential
locations under the host home directory. The [credential path list][credentials]
comes from the SDK and includes SSH, AWS and Git credentials, keychains,
keyrings and browser profiles. Seatbelt may expose metadata for files outside
the readable paths.

[credentials]:
  https://github.com/underwhelmingperformance/pi-bring-your-own-sandbox/blob/caf09630558859d62c34b3242db865756b80bec3/packages/sdk/src/credential-locations.ts

Linux profiles narrow host user data to `denied`. Bubblewrap cannot mask an
absent credential path inside a read-only host mount. If the host later creates
that path, the sandbox could read it. Toolchains under the host home directory
therefore need escalation path grants on Linux.

An approved escalation can add read or write access to specific paths. Paths
under the host home directory appear at the same relative path in the private
target home. Other paths keep their absolute locations unless they are in the
workspace. BYOS requires an approved escalation for grants inside credential
locations. On macOS, the native offline profiles and the open-egress profiles
with host user data denied can grant individual credential paths. The
open-egress profiles with read-only host user data reject credential grants
because the generated Seatbelt rules cannot make an exception for one path
inside a protected directory.

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

On macOS, `policy.network: false` uses the native offline Seatbelt profile.
Users who previously set `network: "off"` now get the native offline profile. It
denies IP networking, pathname Unix socket connections and Mach service lookup.
Child processes inherit those restrictions. The default search path checks
Apple's developer tools before the `/usr/bin/git` launcher.

On Linux, `policy.network: false` uses MXC's `ip-denied` mode. On both systems,
`policy.network: true` uses `open-egress`, which permits external outbound IP
traffic. Both generated modes request ingress and host-loopback IP denial.
Ingress, expanded loopback coverage and IPv6 validation are incomplete.

The following Unix socket exceptions apply to the generated MXC profiles. A
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
the other profiles, exit status is optional. Pi displays unavailable status as a
failed command.

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
