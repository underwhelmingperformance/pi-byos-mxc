# BYOS provider conformance at `caf0963`

On macOS ARM64, MXC has eight live-checkout profiles and four private-copy
profiles. The SDK suite selects each profile through its broker. It checks
literal argv, shell execution, file and search operations, copying,
process-group cancellation, and disposal and recovery after opening faults. MXC
also checks writes through aliases to host files independently of the backend.
On macOS 27.0.1 ARM64 with Nix Node 24.21.0, the two SDK suite instances passed
210 cases. Six MXC broker tests passed for the profiles that allow host user
data reads.

A second suite instance exercises live workspace visibility, workspace read
grants and refusal of a checkout with a FIFO. At this SDK revision, selecting
shared workspace visibility disables profile generation. The credential fixture
in the SDK expects host files under the sandbox's home directory. MXC uses that
directory for private scratch, so its broker tests use a synthetic host home and
check its original absolute paths in the target.

MXC uses the SDK's provider registration, OS error mapping, copy-source
validation, workspace protection defaults and cleanup context. The SDK's
`ShellTransportRunner` starts argv commands through the existing supervisor.
MXC's recovery records and IPC track the supervisor and target process group
separately. The SDK's `PosixProcessRunner` supervises one group.

The SDK file helper runs inside the target. MXC retains its search worker for
`find` and for `grep` when `rg` is unavailable. When `rg` is available, MXC uses
the SDK's ripgrep argument builder and output parser. The SDK's portable search
helper requires Linux descriptor paths.
