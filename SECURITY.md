# Security

## Current Model

Agentdiff v0 is open-source and BYOK. It runs in your CI or local environment and does not require an agentdiff-hosted backend.

Current defaults:

- no hosted inference by agentdiff
- no hosted repository ingestion
- no agentdiff-managed API-key custody
- reports are written to local/CI artifacts and, when configured, pull request comments

## Secrets

Do not paste secrets into GitHub issues, pull requests, screenshots, or public traces.

Avoid sharing:

- API keys
- GitHub tokens
- customer data
- private prompts
- production traces with sensitive content
- internal repository code that you cannot publish

If you report a security issue, redact secrets and provide the smallest safe reproduction.

## Reporting Security Issues

Security reporting contact: `security@example.com` placeholder.

Until a dedicated disclosure address is configured, open a minimal public issue that asks for a private contact path and does not include exploit details or secrets.

## Supported Versions

Agentdiff is pre-1.0. Security fixes are expected to land on `main`.
