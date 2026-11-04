# Arduino Plugins

Extensions for Arduino IDE 2. The IDE is built on Eclipse Theia and loads VS Code extensions (`.vsix`) placed in `%USERPROFILE%\.arduinoIDE\plugins\`, read at start-up.

| Plugin | What it does |
|---|---|
| [git-branch-indicator](git-branch-indicator/) | Shows the git branch and commit of the open sketch in the status bar |

Each plugin folder has its own `build_vsix.ps1`, which packs the `.vsix` without npm and installs it with `-Install`.

To install on another PC without building, download the `.vsix` from the plugin's [release](https://github.com/mzspace-me/arduino-plugins/releases) (tagged `<plugin>-v<version>`) and follow the install steps in its release notes. A plugin's `release.ps1` publishes them.

Planned features and decisions are tracked as [issues](https://github.com/mzspace-me/arduino-plugins/issues).

Made by [Mz](https://mzspace.me). MIT licence, see [LICENSE](LICENSE).
