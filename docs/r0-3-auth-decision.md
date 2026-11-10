# R0.3 authentication decision — option B and original M0/M1 split approved

Research checked 2026-11-10. After PR #22 checkpoint `6fd0907`, the user explicitly chose “Exempt OpenAI smoke (Recommended)” and “Approve original split (Recommended)”. Both decisions are recorded in the `plan.md` §0.3 scope change log and applied in `docs/roadmap.md`. Only the M0 OpenAI live API-key smoke is exempt; both adapters' original conformance acceptance remains. F-AGT-1 stays Partial across M0 primary-loop / M1 editable Plan Mode and Explore. No OpenAI Platform key is requested. ChatGPT OAuth remains unimplemented and unverified; F-MDL-3/F-AUTH-2 and M2 SIWC remain unchanged. No M1 implementation, PR merge or PR #19 changes are authorized.

## Original contracts and preserved evidence

- `plan.md` F-MDL-1 AC: one adapter package without agent-core changes; streaming, tool round-trip, structured output, cancellation, rate-limit retry; explicit logged degradation. Its AC does not itself demand live OpenAI listing. R0.3 adds that live listing check for both providers.
- FR-1 is Gemini model listing, selection, temperature, supported thinking/reasoning controls, and max output. It must be verified independently of the OpenAI decision.
- FR-5 requires new providers without changes to agent core.
- `plan.md` §12 M0 explicitly names Gemini and **OpenAI API-key** adapters. §12 M2 names SIWC behind a flag, if approved. F-MDL-3 additionally requires approved/registered SIWC OIDC+PKCE, ID-token verification, keychain refresh-token storage, plan-usage status, and no access to another application's credential store. An app-server login does not, by itself, prove all these Helix requirements.
- Preserved: commit 663805d Gemini live listing (28 chat models) and schema-valid output; both adapters' 23/23 A-local conformance cases. Rerun this session: 23 passed, 0 failed, 6 live skipped. Fakes remain mechanical evidence, not live authentication evidence.

## Official supported integration investigated

Sources: [Codex App Server](https://developers.openai.com/codex/app-server), [Authentication](https://developers.openai.com/codex/auth), [app-server authentication methods](https://developers.openai.com/codex/app-server#account-and-authentication).

The documented embedding interface is the genuine `codex app-server` subprocess, preferably local stdio JSONL. Identify Helix honestly in `initialize.clientInfo`; then send `initialized`. Managed login is `account/login/start` with `type: chatgpt` (browser URL and local callback), or `chatgptDeviceCode` (verification URL/user code, when enabled). Wait for matching `account/login/completed` and `account/updated`; inspect account/plan and `account/rateLimits/read`. The app-server owns its login and refresh lifecycle. Use an isolated Helix-owned CODEX_HOME and keyring/ephemeral credential storage; Helix must not read `~/.codex/auth.json`, borrow OAuth client IDs/ports, extract tokens, scrape cookies, or call undocumented ChatGPT endpoints.

Discover with paginated `model/list`; **a listed model is not available until an authenticated minimal turn succeeds**. Exercise `thread/start`, `turn/start`, streamed items, `turn/interrupt`, usage events, refresh/revocation, denied entitlement, and restart. The documented app-server is a Codex **agent protocol**, not a drop-in OpenAI Responses model stream. Its tool execution must not bypass Helix policy, real local-container execution, checkpointing, trace attribution, or tool-result replay guarantees. A safe model-only/tool bridge and all five conformance cases need evidence before this can replace any adapter acceptance.

`account/usage/read` and quota percentages are not a USD invoice. Subscription usage has no assumed per-token USD rate; keep unknown money null. It cannot automatically satisfy G0.1 priced reconciliation. Use genuinely priced Gemini for that independent gate.

## Compared options (B approved; A not authorized)

| | A — complete the ChatGPT path | B — formally separate the M0 adapter criterion |
|---|---|---|
| Deliverable | A Helix-owned official app-server integration, live user login, discovery **plus access test**, safe tool bridge, streaming/structured output/cancellation/retry tests, usage and keychain/refresh/revocation evidence | Keep the OpenAI API-key adapter and all A-local conformance tests; remove only the R0.3 requirement to perform OpenAI **API-key live listing in this M0 environment**; preserve live Gemini discovery/configuration and complete adapter package-independence proof |
| Scope effect | Bringing SIWC into M0 conflicts with current §12 M2 placement and F-MDL-3's standalone OIDC acceptance; requires a §0.3 approval specifying app-server versus standalone SIWC semantics. Login alone cannot close unchanged original criteria | Requires a §0.3 dated change-log entry explicitly exempting the OpenAI live API-key smoke from R0.3 M0 acceptance, with reason (no Platform-key billing) and approver; leaves F-MDL-3/F-AUTH-2 and M2 SIWC untouched |
| Proposed wording | Not drafted as an approved replacement: first agree whether an app-server-managed flow satisfies F-MDL-3 or whether independent registered SIWC remains required | Proposed R0.3 Accept: "Both Gemini and OpenAI API-key adapters pass all five A-local conformance categories and explicit degradation; a new adapter is addable in one package without agent-core changes. Gemini live discovery and authenticated per-request configuration pass. OpenAI live API-key listing is not required for M0 under the user's no-Platform-key policy; ChatGPT SIWC remains an unverified, separately gated M2 requirement." |
| External dependency | User approval of the scope/auth design and an interactive eligible ChatGPT account; approved/registered independent SIWC if that original criterion is retained | Explicit user approval only for the precise acceptance change; no new credentials |
| Evidence retained | Existing Gemini live and 23/23 A-local evidence; no retrospective OAuth claim | The same evidence; no claim that OpenAI live, OAuth, or subscription billing was tested |
| M0 result now | Not authorized; not implemented or verified | Approved under §0.3; R0.3 can close with both adapters' A-local conformance/package proof and genuine Gemini live evidence. This does not waive R0.8 or certify M0 overall. |

Decision: the user chose B. No broader authentication contract was approved. Neither approval authorizes M1 implementation, merging PR #22, or touching PR #19.

## G0.2: original M0 versus later work

- FR-1 is wholly M0. Its previously missing live thinking/configuration evidence now passes: artifact `evals/results/fr-1-gemini-controls-2026-11-10T13-58-50-776Z.json`, commit ad1386e. Listing was followed by two actual access tests, not an assumption of availability.
- FR-5 / F-MDL-1 AC1 has a dynamically loaded, self-contained provider package proof against the public gateway, including ledger reconciliation, without changes to the agent core (ad1386e). The original five-category adapter tests remain 23/23. With the approved R0.3 exemption, F-MDL-1's original AC can be marked Done with this evidence and logged degradation; no checker bypass or live OpenAI claim is involved.
- F-AGT-1's M0 acceptance is durable primary tool-call spans, model-cost attribution, checkpoints, cancellation within 1 s, and restart. Original §12 M1 explicitly names **Plan Mode and Explore subagent**; R1.16 covers visible/editable plan review, and R1.47 adds previously missing nested Explore attribution/checkpoint/cancellation coverage beyond T6's summary mechanics. No M1 implementation is authorized this session.
- Approved mapping: **M0 (primary loop), M1 (editable Plan Mode / Explore)**. Its row carries `M0 part: Evidence:` from R0.6/R0.10/G0.1 and remains **Partial** until M1 passes. The unchanged checker can accept its M0 part but must still reject its incomplete M1 part. No requirement or exit gate is deleted, no original acceptance is narrowed, and R0.8's dispatch/reference-runner blockers are not waived.
