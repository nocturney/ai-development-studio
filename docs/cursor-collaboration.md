# Cursor as an optional development reviewer

Cursor is a secondary development aid, not the AI Studio runtime or inference engine.

## Current availability (October 9, 2026)

Cursor Desktop 3.23.23 is installed on the Windows host. The editor launcher exists at:
`C:\Users\Chris\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd`

The separate Cursor Agent CLI is NOT installed or available on the service PATH. Desktop Commander commands currently run as `NT AUTHORITY\SYSTEM`, not in the user-facing Cursor session. As a result, automated Cursor tasks are **not enabled or connected**. This is not a user-requested install or an authorization to consume Cursor quota.

## Safe collaboration contract when Cursor is available

1. Use an independent Git branch/worktree per Cursor task. Never share an actively edited worktree with the main developer.
2. Cursor only performs an explicit scoped subtask: code review, accessibility analysis, security review, test proposals, or isolated implementation.
3. Cursor must never be used as the shipped AI Studio agent backend or inference source.
4. Protect local tokens/credentials, private branches and customer data. No implicit cloud inference without user knowledge of Cursor's account and quota terms.
5. No auto-merge or unaudited file changes. CI/test evidence and a human-readable PR are mandatory before integration.
6. No `--force` or unrestricted shell permissions to bypass tool consent.
7. Work can continue normally without Cursor. An unavailable Cursor CLI is not a blocker.

## Suggested first Cursor subtask

**Read-only review of the isolated-agent reliability branch**, focusing on cancellation races, stale recovery semantics, Git worktree/manifest validation, and possible approval-after-abort pathways. Return a written findings report with file/line references and recommended tests; do not modify files.

This review can be performed manually in the user's authenticated Cursor IDE if desired, or later through a safely authenticated CLI after verifying quotas and permissions.
