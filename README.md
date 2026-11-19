# A sandbox for Pi with Microsoft MXC

Give Pi a project to work in without giving its tools the same access as your
terminal. Pi can read the code, edit a file and run a test. If it also tries to
change your Git hooks or the `.envrc` that your shell loads, the sandbox blocks
that change.

This extension uses Microsoft MXC to run Pi's tools in a sandbox on your
machine. The **workspace** is the directory where you start Pi. You and Pi see
the same files, so a successful edit shows up immediately in your editor or
`git diff`. On Apple Silicon the sandbox runs natively on macOS.

![Pi updates a changelog, gets a permission error editing .envrc, then reads back its original value.][demo]

The recording uses a scripted model and a real MXC sandbox. Pi edits the release
notes, then shows why a second edit failed. [Recording instructions and VHS
tape][replay].

[demo]: docs/images/workspace.gif
[replay]: demo

## Get started

This experimental extension is tested with [Pi][pi] 1.5.0. To build it, you'll
need Git, Node.js 24.21 or later in the 24.x series, pnpm 12.15.0 and a C
compiler. On an Apple Silicon Mac, install Apple's Command Line Tools with
`xcode-select --install` if you don't have them. Linux ARM64 and x64 require
Bubblewrap 0.5 or later and unprivileged user namespaces. Intel Macs and Windows
are unsupported.

Build the extension once in a directory outside the projects where you'll use
Pi. The tools need that copy to stay outside their writable workspace.

```sh
git clone https://github.com/underwhelmingperformance/pi-byos-mxc.git ~/pi-byos-mxc
cd ~/pi-byos-mxc
pnpm install --frozen-lockfile
pnpm build
pi install "$PWD"
```

Now start `pi` **from your project directory**. Ask it to make a small edit and
show you the diff. Its usual `read`, `edit`, `write` and `bash` calls use MXC
automatically. The same goes for `ls`, `find` and `grep` if you enable them in
Pi. You can also run a command in the sandbox yourself by typing
`!git status --short` in Pi.

To try it for one session, skip the `pi install` step and run
`pi -e ~/pi-byos-mxc` from your project. To remove a persistent installation,
run `pi remove ~/pi-byos-mxc` and restart Pi.

[pi]: https://github.com/earendil-works/pi

## Choose what Pi's tools can do

The defaults allow project edits and protect Git metadata, Pi settings and other
configuration that programs on your machine load. Tools can read system files
that they need to run and have their own temporary directory. Direct IP
networking is blocked by default. Some local services are still reachable
through Unix sockets and can make network requests on a tool's behalf.

You can change these permissions in `~/.pi/agent/mxc-sandbox.json`. If you set
`PI_CODING_AGENT_DIR`, put the file in that directory. For example, on Apple
Silicon this configuration lets Pi edit your project, keeps your `deploy`
directory read-only and blocks network connections, including connections to
local Unix sockets:

```json
{
  "mode": "strict",
  "network": "denied",
  "protectPaths": ["deploy"]
}
```

Restart Pi after changing the file. Use `"mode": "read-only"` when you want Pi
to inspect the project without editing it. Linux supports read-only workspaces
but cannot enforce `"network": "denied"`. These settings govern tools. Pi's
connection to your model provider is independent. See the [settings and network
reference][reference] for more options.

[reference]: docs/provider-reference.md

## Use it with auto-review

An editor and a reviewer can inspect the same uncommitted change with different
permissions. On Apple Silicon, the [compatible permission auto-review
extension][reviewer] can read the diff and run a command to check a fact. Its
investigation has read-only project access and denied networking, even when the
editor can write.

If you already use the permission system and the reviewer's default `codex`
preset, installing MXC is enough. The reviewer discovers MXC through [Bring Your
Own Sandbox][byos], the interface that Pi extensions use to request a sandbox.
Linux cannot provide the reviewer's required network policy.

[reviewer]:
  https://github.com/iainlane/pi-packages/tree/codex-parity/packages/pi-permission-auto-review
[byos]: https://github.com/underwhelmingperformance/pi-bring-your-own-sandbox

## Where the sandbox stops

Other extensions and independent MCP servers can still access the host through
their own tools. If you configure and approve an outside-sandbox shell command,
that command runs at the approved destination.

Review project changes before running them in your own terminal. A sandboxed
edit can change a build script that you later run with your own permissions. A
child process that leaves its process group can also outlive a cancelled command
and retain access to permitted files. If Pi reports that it couldn't clean up a
sandbox, follow the [recovery guide][recovery].

[recovery]: docs/recovery.md
