# codex-resets

Unofficial CLI for checking Codex Desktop reset-credit expirations from your terminal.

It reads the local Codex Desktop auth file at runtime, calls the same ChatGPT backend endpoint that the desktop app uses, and prints the available reset credits for the currently logged-in account.

## Safety Model

- No token is stored in this repo or copied into the CLI.
- The CLI reads `~/.codex/auth.json` only on the machine where you run it.
- The Codex bearer token is sent only to allowlisted HTTPS OpenAI hosts: `chatgpt.com` or `chat.openai.com`.
- Account IDs, credit IDs, local auth paths, and source profile IDs are redacted by default. Pass `--show-identifiers` only when you intentionally need them.
- The raw request command is read-only and accepts only relative API paths.

This is an unofficial tool that relies on an internal/undocumented Codex Desktop endpoint. It may break if OpenAI changes the app or backend API.

## Quick Start

Run it directly with `npx`:

```bash
npx --yes codex-resets credits summary
```

Other common commands:

```bash
npx --yes codex-resets doctor
npx --yes codex-resets credits list
npx --yes codex-resets --json credits summary
```

If the npm package is still propagating, you can run the GitHub version directly:

```bash
npx --yes github:sourav-bhar/codex-resets credits summary
```

## Install

To install it globally:

```bash
npm install -g codex-resets
codex-resets credits summary
```

To install from a local checkout:

```bash
git clone https://github.com/sourav-bhar/codex-resets.git
cd codex-resets
make install-local
```

The local checkout installer copies `codex-resets` to `~/.local/bin`. Make sure `~/.local/bin` is on your `PATH`.

## Usage

```bash
codex-resets doctor
codex-resets credits list
codex-resets credits summary
codex-resets --json credits summary
```

To intentionally include local/account identifiers:

```bash
codex-resets --show-identifiers --json credits list
```

To use a non-default Codex auth file for one run:

```bash
codex-resets --auth-file ~/path/to/auth.json credits list
```

## JSON Output

With `--json`, successful commands emit stable JSON to stdout. Errors also emit JSON and never include bearer tokens or cookies:

```json
{
  "ok": false,
  "error": {
    "message": "Codex auth file not found",
    "code": "AUTH_FILE_MISSING"
  }
}
```

## Periodic Checks On macOS

Generate a LaunchAgent plist:

```bash
mkdir -p ~/Library/LaunchAgents ~/.codex/resets
CODEX_RESETS_EXECUTABLE="$(command -v codex-resets)" codex-resets schedule launchd-plist --interval-minutes 360 > ~/Library/LaunchAgents/com.codex-resets.check.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.codex-resets.check.plist
```

The generated job writes JSON summaries to `~/.codex/resets/codex-resets.log` and errors to `~/.codex/resets/codex-resets.err`.

## Raw Read-Only Escape Hatch

```bash
codex-resets request get /wham/rate-limit-reset-credits
```

Only `GET` is supported. The CLI deliberately does not include a command to consume or redeem a reset credit.

Do not paste raw request output into public issues or social posts. Raw endpoint responses can contain account-specific fields that are not part of the redacted high-level commands.

## Development

```bash
make test
npm run check
```

The project has no runtime npm dependencies.
