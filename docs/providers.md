# Provider research — 2026-10-09

The catalog is research/planning; remote cloud adapters are NOT implemented or enabled.

| Provider | Access type | Notes | Release decision |
| --- | --- | --- | --- |
| Ollama | local | Installed on both user's machines (custom loopback ports 11555 Windows and 11556 macOS). No vendor inference quota. | Foundation ready |
| LM Studio / llama.cpp | local | OpenAI-compatible local inference; benchmark later. | Planned |
| OpenRouter :free | Official free API | Free plan 50 requests/day and 20/minute (published Sep 2026); requires key. Only :free models. | Priority P1 |
| Groq Free Plan | Official free API | Official free model-specific RPM/TPM/RPD quotas; exact limits vary. Requires own key. | Priority P1 |
| Google Gemini API free | Official free API | Free quotas are model/project-specific and change. Verify account pricing status. | Priority P2 |
| Puter.js | User-pays with free allowance | No commercial model keys needed; users log in; monthly free allowance, afterward billing by user. Not unlimited free for users. | Priority P1 consent UX |
| Pollinations | User-based budget/API | API app and secret keys, OAuth/BYOP budget, not anonymous unlimited free. | Research P3 |
| GPT4Free g4f | Community aggregate | Includes reverse-engineered provider methods; often brittle/possibly restricted by provider TOS. Do not ship bypasses or make a default fallback. | Research only |
| OpenCode Zen free models | Official model gateway | Free-tagged models exist; availability and conditions change; not same as unlimited inference. | Research P2 |

## Consent, privacy, and cost contracts
- Local-only enabled by default. The cloud switch alone is insufficient: each provider must be approved.
- No remote provider request until official account authorization succeeds and current free allowance/policy is validated.
- If a provider cannot guarantee a zero-spend operation, block in zero-spend mode rather than risk billing.
- No retry/rotation intended to evade published quotas, access controls, CAPTCHA, or provider terms.
- No implicit fallback: user must explicitly select a different provider and approve outbound project content.
- Show token quotas, remaining requests if exposed, data destination, permission state and rate-limit cooldown.
- Isolate optional provider integration so a broken adapter cannot crash the core.

## Primary references
- https://docs.puter.com/user-pays-model/
- https://developer.puter.com/tutorials/puter-auth-token/
- https://openrouter.ai/pricing
- https://openrouter.zendesk.com/hc/en-us/articles/39501163636379-OpenRouter-Rate-Limits-What-You-Need-to-Know
- https://console.groq.com/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://github.com/xtekky/gpt4free
- https://github.com/pollinations/pollinations
- https://docs.opencode.ai/docs/zen/
