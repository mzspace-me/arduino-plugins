# Arduino Plugins

Extensions for Arduino IDE 2. The IDE is built on Eclipse Theia and loads VS Code extensions (`.vsix`) placed in `%USERPROFILE%\.arduinoIDE\plugins\`, read at start-up.

| Plugin | What it does |
|---|---|
| [git-branch-indicator](git-branch-indicator/) | Shows the git branch and commit of the open sketch in the status bar |

Each plugin folder has its own `build_vsix.ps1`, which packs the `.vsix` without npm and installs it with `-Install`.

Planned features and decisions are tracked as [issues](https://github.com/MotazBanyAmer/arduino-plugins/issues).
