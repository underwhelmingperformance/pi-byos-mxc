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
