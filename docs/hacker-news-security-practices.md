# Hacker News Security Practices (Community-Sourced)

Last reviewed: 2026-02-25

This is a synthesis of recurring security practices from relevant Hacker News discussions.  
These are community recommendations, not formal standards.

## 1) Keep secrets out of repos, history, and prompts

Recurring HN guidance:

- Do not commit API keys, tokens, or `.env` files.
- Scan history before open-sourcing or sharing repos.
- Assume leaked keys are compromised and rotate immediately.

## 2) Prefer managed secrets and identity-based auth over static keys

Recurring HN guidance:

- Use cloud secret managers and audited access paths.
- Prefer temporary/identity-derived credentials when available.
- Avoid long-lived static credentials in local scripts and CI.

## 3) Use least privilege and short token lifetimes

Recurring HN guidance:

- Scope each token to minimum resources/actions.
- Separate read/write/admin roles.
- Keep token TTL short and automate rotation.

## 4) Add financial and operational blast-radius controls

Recurring HN guidance:

- Set strict billing alerts/budgets for AI/API providers.
- Keep kill switches and revoke paths easy to execute.
- Monitor unusual spend spikes as potential key abuse.

## 5) Enforce automated secret scanning and policy checks in CI

Recurring HN guidance:

- Run secret scanners and static analysis in pre-commit/CI.
- Block merges on leaked secret patterns or policy violations.
- Include supply-chain checks for dependencies and generated code.

## 6) Do not rely on prompts alone for security

Recurring HN guidance:

- Prompt-injection resistance needs runtime controls.
- Layer authorization, constrained tool access, and sandbox boundaries.
- For agentic systems, proxy/mediate tool calls and centralize policy decisions.

## 7) Separate agent classes and trust levels

Recurring HN guidance:

- Keep highly privileged coding/ops agents separate from customer-facing assistants.
- Give each agent type a distinct permission and network profile.
- Keep production credentials off general-purpose agent sessions.

## Inference Notes

The recommendations above are inferred from repeated patterns across multiple threads and comments.  
Where commenters disagreed on implementation details, this document captures the overlap only.

## Source Threads

- Secret leaks and API key abuse: https://news.ycombinator.com/item?id=45241001
- Secret manager + audit log discussion: https://news.ycombinator.com/item?id=39276346
- CI/pre-commit secret scanning and dependency controls: https://news.ycombinator.com/item?id=46976845
- Prompt injection and access control discussion: https://news.ycombinator.com/item?id=40607476
- Agent class separation and MCP proxy/governance discussion: https://news.ycombinator.com/item?id=48705473
- Long-lived PAT/token risk patterns: https://news.ycombinator.com/item?id=33248988
