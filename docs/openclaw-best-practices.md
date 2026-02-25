# OpenClaw Best Practices (Official Docs)

Last reviewed: 2026-02-25

This document summarizes security and operations guidance from the official OpenClaw docs.

## 1) Treat trust boundary design as the first control

- Use one trusted operator boundary per Gateway.
- Do not run one shared Gateway for mutually untrusted users.
- If users are mixed-trust, split into separate gateways (ideally separate OS users/hosts).

Why: OpenClaw docs explicitly frame the default model as a personal-assistant trust boundary, not hostile multi-tenant isolation.

## 2) Run the built-in security audit regularly

- Run:
  - `openclaw security audit`
  - `openclaw security audit --deep`
  - `openclaw security audit --fix`
  - `openclaw security audit --json`
- Run audits after config changes and after exposing new network surfaces.

## 3) Start with minimum access, then open intentionally

- Keep tool profile minimal.
- Deny risky tool groups by default (`runtime`, `automation`, filesystem, etc.) and re-enable only where needed.
- Keep exec approvals strict unless you explicitly trust the sender + session.

OpenClaw guidance: hard enforcement is tool policy, exec approvals, sandboxing, and allowlists; prompt text alone is not sufficient.

## 4) Use sandboxing as a blast-radius control

- Prefer sandbox mode for sessions that handle untrusted input.
- Keep workspace mounts read-only where possible.
- Avoid risky bind mounts (especially `docker.sock`) unless you intentionally want host-level control from the sandbox.
- Use `openclaw sandbox explain` to verify effective sandbox/tool/elevated state.

## 5) Harden network exposure and control UI

- Prefer loopback/private networking for Gateway and node hosts.
- Keep the Control UI on `localhost` or HTTPS.
- Avoid break-glass flags unless actively debugging and roll back immediately.
- Keep firewall and bind settings tight (default port surfaces include Control UI/canvas endpoints).

## 6) Harden channel ingress

- Keep DM policy on `pairing` or strict allowlists.
- Keep group policy on allowlist/disabled unless you intentionally need open.
- Keep mention-gating on for channels where possible.

## 7) Treat browser automation as a privileged surface

- Keep browser control loopback/private.
- Treat remote CDP URLs/tokens as secrets.
- Prefer HTTPS and short-lived tokens for remote CDP.
- Avoid long-lived secrets in config files.
- Disable page JS-eval automation if not needed: `browser.evaluateEnabled=false`.
- For login flows, manually authenticate in host browser; do not hand credentials to the model.

## 8) Keep skills and hooks operationally safe

- Skills:
  - Be concise.
  - Prevent command injection paths when using shell tools.
  - Test skills locally before broader use.
- Hooks:
  - Keep handlers fast (do not block command processing).
  - Catch errors and avoid crashing the hook chain.
  - Filter events early and register specific event keys to reduce overhead.

## 9) Operational response discipline

- Assume secrets are compromised when leaked, then rotate.
- Keep logs/transcripts redacted and retained intentionally.
- Use explicit security rules in system prompts, but rely on runtime/tool controls for enforcement.

## Source Links

- Security: https://docs.openclaw.ai/gateway/security
- Sandboxing: https://docs.openclaw.ai/gateway/sandboxing
- Sandbox vs Tool Policy vs Elevated: https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated
- Browser (OpenClaw-managed): https://docs.openclaw.ai/tools/browser
- Browser Login: https://docs.openclaw.ai/tools/browser-login
- Slack channel controls: https://docs.openclaw.ai/channels/slack
- Creating Skills: https://docs.openclaw.ai/tools/creating-skills
- Hooks: https://docs.openclaw.ai/automation/hooks
- ClawHub moderation model: https://docs.openclaw.ai/tools/clawhub
