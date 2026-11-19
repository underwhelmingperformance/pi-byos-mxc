# Run from the built checkout on Apple Silicon: vhs demo/workspace.tape
Output docs/images/workspace.gif
Require node
Require fd
Require rg

Set Shell bash
Set Width 1000
Set Height 690
Set FontSize 21
Set FontFamily "Menlo"
Set Framerate 12
Set Padding 16
Set TypingSpeed 38ms
Set Theme "Dracula"

Hide
Type@1ms "sh demo/session.sh"
Enter
Wait+Screen@90s /scripted/
Type@12ms "!cat CHANGELOG.md"
Enter
Wait+Screen@60s /CSV export \(preview\)/
Show
Sleep 1s
Type "Mark CSV export as stable in the changelog."
Enter
Wait+Screen@60s /Updated CHANGELOG.md\./
Sleep 2s
Type "Update .envrc to use the stable channel too."
Enter
Wait+Screen@60s /shell configuration is protected\./
Sleep 3s
Type "!cat .envrc"
Enter
Wait+Screen@30s /export CHANNEL=preview/
Sleep 3s
Hide
Ctrl+D
Sleep 1s
