# Native macOS tools in a private filesystem root

A private Darwin root could give Pi's shell, file and search tools the same view
of a live project. The reviewer's backend would expose that project read-only.
An editing backend would expose it read-write with the configured workspace
protections. Both would need an isolated native toolchain, so the shell could
run tools without reading the host's system directories.

## Findings on macOS 27.0.1

The probe ran on arm64, build 26A434, with MXC SDK 1.0.1. A temporary root
contained copies of Bash, dyld and Command Line Tools Git, plus a workspace
marker. The spike checked three separate prerequisites.

- **Entering the root.** A native process running as UID 501 called `chroot(2)`
  on the fixture outside the outer development sandbox. The kernel returned
  `Operation not permitted`. Apple's [XNU implementation][chroot] checks for
  superuser privileges. The attempted privileged fixture used the system
  `chroot` utility to drop to UID 501 before executing Bash. Noninteractive sudo
  required authentication, so this run did not establish that Bash or Git starts
  in the private root.
- **Mounting an existing project.** An unsandboxed `getvfsbyname(3)` probe found
  `apfs` and `nullfs`. It did not find `bindfs`. The published [XNU nullfs
  implementation][nullfs] checks an entitlement on mount and forces the mount
  read-only. Administrative access alone would not make that implementation
  suitable for an editor.
- **Providing a writable view.** Apple's [FSKit passthrough sample][fskit]
  presents an existing directory at another mount point. It requires an app
  extension with the filesystem module entitlement and user activation. The
  registered FSKit modules on the test Mac included DeviceFS, exFAT, FTP and
  MS-DOS. None provided the sample's passthrough filesystem. A live mount
  through FSKit therefore remains a design candidate.

[chroot]:
  https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_syscalls.c
[nullfs]:
  https://github.com/apple-oss-distributions/xnu/blob/main/bsd/miscfs/nullfs/null_vfsops.c
[fskit]:
  https://developer.apple.com/documentation/fskit/building-a-passthrough-file-system

## Native startup and tool routing

A native launcher would need to enter the root, discard setup privileges and
external descriptors, apply the command's Seatbelt policy, and supervise the
unprivileged process. The policy must also restrict network access and host IPC.
Changing the root directory only changes filesystem path resolution. The spike
produced no end-to-end latency or isolation result for this combination.

A [separate Darwin chroot project][darwin-jail] reports running native tools on
macOS 27. Its launcher exposes the host's dyld cache through file descriptors
and mounts devfs. Its default configuration includes a privileged command
service and forwards DNS to the host. Those facilities are outside the BYOS
investigation contract. The project provides evidence about native startup; it
does not validate this provider's isolation policy.

At BYOS revision `caf0963`, the SDK adapter routes Pi 1.5.0 shell, file and
search tools through the negotiated sandbox. `read` checks paths through the
sandbox facade. `grep` runs the target's `rg` when available. Direct Node calls
from extensions and independently running MCP servers require their own
integration.

[darwin-jail]: https://github.com/chkkv/macos-jail

## What would justify proceeding

First demonstrate an unprivileged native shell and Git inside the private root
with the required Seatbelt policy. Verify a real exit status, process-group
cancellation and refusal of access to outside files, network peers and host
sockets. A successful shell startup alone establishes only loader compatibility.

For a managed checkout, the project can live directly under the private root.
This avoids a passthrough mount and lets host tools open the same files. The
launcher and runtime must be outside the writable project. Supporting a project
at its existing arbitrary path requires a live projection into the root.

Mount one existing project and open two backends concurrently. An edit through
the writable backend must appear at the host path and in the reviewer's
read-only view. Include an editor's atomic replacement of a file, a rename, an
allowed in-tree symlink and a protected Git entry. Exercise Pi's actual file,
search and shell tools. Measure session startup, warm command latency and a
repository search against the existing MXC backend on the same checkout.
