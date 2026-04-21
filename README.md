# GitHub Copilot Chat Exporter

Export your GitHub Copilot chat conversations from VS Code as **JSON** or **Markdown** files. This extension reliably extracts your complete conversation history, parsing through VS Code's internal storage regardless of the Copilot version mode used.

## 🚀 Features

- **🎯 Workspace Export**: Choose to export conversations exclusively from your currently active workspace or from all registered workspaces at once.
- **⚡ Advanced JSONL & Delta Support**: Seamlessly supports both the legacy `.json` and the newer Copilot Agent Mode `.jsonl` streaming chat data formats. It parses initial state snapshots and meticulously reconstructs session message history by applying incremental updates (deltas) seamlessly behind the scenes.
- **📝 Multiple Export Formats**: Export output as machine-readable **JSON** (excellent for dataset curation and analytics) or human-readable **Markdown** (for direct reading and sharing). You can export to both simultaneously.
- **🌍 Cross-platform Compatibility**: Works perfectly across Windows, Mac, and Linux, and natively supports **VS Code Insiders**.
- **📅 Date Filter**: Filter out older sessions optionally by limiting exports to conversations from the last N days.
- **💬 Intelligent Session Labels**: Each session exported is labelled vividly with its custom title, or uses the first query message if a title is absent.
- **⚙️ User-Configurable**: Easily customise the default output directory, default format, and default date filters directly via VS Code settings (`settings.json`).
- **🔍 Detailed Diagnostics Check**: Integrated diagnostic tools to present helpful debugging information directly to you in case the chat data isn't found.

## 📦 Installation

To install, you can compile and package the extension manually via building the VSIX package yourself using tools like `vsce` or directly install the pre-packaged `.vsix` file:

```shell
code --install-extension vscode-copilot-exporter-0.X.0.vsix --force
```

## 🛠️ Usage

1. Open the VS Code workspace you want to export your Copilot Chat history from.
2. Click the **"Export Copilot Chat"** button elegantly sitting on the VS Code status bar (bottom right), or run the command directly from the Command Palette (`Ctrl+Shift+P` -> `Export Copilot Chat`).
3. Select the **export format** you desire (`JSON`, `Markdown`, or `Both`).
4. Choose **which workspace(s)** you wish to export history for (Target current workspace specifically, or All accumulated workspaces globally).
5. Optionally, input a **date filter** (e.g., typing `30` to only export sessions spanning the last 30 days).
6. Pick an **output destination folder** anywhere on your robust file system.
7. Open the output directory to explore your neatly organized exported chat sessions.

## ⚙️ Settings / Configuration

You can customize the extension via your VS Code Settings UI, or directly through `.vscode/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `copilotExporter.outputDirectory` | `""` | The exact path of your default output directory. If left entirely empty, it will naturally prompt you or use the local workspace / home directory. |
| `copilotExporter.exportFormat` | `"json"` | Your preferred go-to output format: `json`, `markdown`, or `both`. |
| `copilotExporter.defaultDaysBack` | `0` | Default days-back threshold filter. Setting it to `0` means absolutely no filter (unlimited history). |
