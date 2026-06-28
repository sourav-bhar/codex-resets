# Security Policy

## Supported Versions

The `main` branch is the supported version until tagged releases exist.

## Reporting A Vulnerability

Open a GitHub issue or contact the maintainer through the repository profile.

Do not include bearer tokens, cookies, full `~/.codex/auth.json` contents, account IDs, credit IDs, or other private account data in public issues. Redact those values before sharing logs.

## Security Design

`codex-resets` reads your local Codex Desktop auth file and sends the bearer token only to allowlisted HTTPS OpenAI hosts. The CLI does not store tokens, does not write auth files, and does not include reset-credit redemption commands.
