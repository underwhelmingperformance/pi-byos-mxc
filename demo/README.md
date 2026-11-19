# Record the Pi sandbox demo

On an Apple Silicon Mac, build the extension as described in the [installation
guide][setup]. Install `fd`, `ripgrep`, [VHS][vhs] and its recording
dependencies, then run this command from the root of the checkout:

```sh
vhs demo/workspace.tape
```

The [tape][tape] writes `docs/images/workspace.gif`. It launches the Pi version
installed by pnpm with a fresh agent directory and a temporary project. Pi's
scripted model requests two ordinary edits. MXC allows the changelog edit and
refuses the change to the shell configuration. The final shell command reads
back the file. The session checks both files on disk and removes the temporary
project when Pi exits. Recording requires no model account or API key.

[setup]: ../README.md#get-started
[vhs]: https://github.com/charmbracelet/vhs
[tape]: workspace.tape
