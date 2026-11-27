# BYOS provider conformance at `e8f4dfd`

On macOS ARM64, MXC has eight live-checkout profiles and four private-copy
profiles. The SDK suite selects each profile through its broker. It checks
literal argv, shell execution, file and search operations, copying,
process-group cancellation, and disposal and recovery after opening faults. MXC
also checks writes through aliases to host files independently of the backend.
On macOS 27.0.1 ARM64 with Nix Node 24.21.0, the single SDK suite runs 328
cases. These include FIFO refusal and workspace read grants for each of the
eight live-checkout profiles, and 126 credential cases across six profiles that
allow host user data reads.

`pnpm check` passed 187 unit and 31 integration tests. The full provider run
passed 383 tests and skipped two Linux tests for nested-path pins and resolver
sockets.

Readable profiles publish the canonical host home as
`workspace.hostUserDataRoot`. The SDK locates its synthetic host files through
that field. `workspace.home` continues to specify private scratch and the
location of home-relative path grants.

The SDK's workspace visibility case still disables profile generation. MXC keeps
its native visibility tests. The SDK's credential cases attempt writes only for
`read-write` profiles. A separate MXC test verifies that a `read-only` profile
refuses writes to an ordinary host file and a credential marker.

MXC uses the SDK's provider registration, OS error mapping, copy-source
validation, workspace protection defaults and cleanup context. The SDK's
`ShellTransportRunner` starts argv commands through the existing supervisor.
MXC's recovery records and IPC track the supervisor and target process group
separately. The SDK's `PosixProcessRunner` supervises one group.

The SDK file and search helpers run inside the target. MXC sends the portable
search program to Node over stdin with the configured `sh`, filesystem grants
and network mode for an ordinary command. Only the search request and its
parameters travel in the command arguments. Pi's `grep` uses the target's `rg`
when available.

## Native Linux validation

The OrbStack machine `mxc-linux-conformance` runs Debian 13 (trixie) on ARM64
with kernel `7.2.12-orbstack-00394-gbecdd6130068` and Bubblewrap 0.12.0. It has
Debian's `slirp4netns`, `uidmap`, `iproute2`, `util-linux`, `iptables`,
`ripgrep`, `fd-find`, `git` and `build-essential` packages. It uses Node 24.22.2
from nodejs.org and pnpm 12.15.0 through Corepack.

Run the checks as the machine's default unprivileged user so that the tests use
unprivileged user namespaces:

```sh
orb -m mxc-linux-conformance bash -c 'cd ~/mxc &&
  pnpm install --frozen-lockfile &&
  pnpm check &&
  pnpm test:provider --reporter=verbose'
```

The frozen install succeeded. `pnpm check` passed 187 unit and 31 integration
tests. The provider run passed 96 tests, including all 70 SDK cases across the
four live-checkout profiles. It skipped 31 macOS cases covering copy backends,
host user data and credential policies, and native Seatbelt behaviour.

Linux commands see a private `/tmp`. Bubblewrap creates the parent of a
workspace mounted under `/tmp`, so a pathname under that parent can refer to a
private file. The alias fixture puts its host marker in a separate directory and
reads the host marker after the attempted write.

In a fresh clone with default protection, host
`git status --short --untracked-files=all` listed 18 empty placeholder files
while an ordinary MXC command ran. Git reported a clean checkout before and
after the command. The crash fixture has no `.git` directory and records 19
placeholders, including `.git`, when MXC cannot confirm termination.
