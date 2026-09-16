---
title: Replace HTTP Copilot endpoint with WebSocket streaming protocol and broaden host allowlisting
description: Record the local dashboard server's WebSocket Copilot protocol and host allowlisting decision.
---

# ADR 1870: Replace HTTP Copilot endpoint with WebSocket streaming protocol and broaden host allowlisting

## Status

Accepted

## Context

The dashboard local dev server (`dashboard/local-server.mjs`) previously exposed a single-shot POST endpoint `/__dashboard_copilot` (`copilotEndpoint`) that read a JSON request body via `readJsonRequest`, validated Origin and Content-Type headers, ran one Copilot prompt synchronously through `copilotRuntime.prompt(...)`, and returned a single JSON response (`{ ok: true }` or `{ error: ... }`). Only one Copilot request could be active at a time, enforced by a `copilotRequestActive` flag that caused the endpoint to return HTTP 409 when busy.

Separately, the server already maintained a WebSocket connection for pushing dashboard preview-reload notifications, using a minimal, non-standard "receivedHeaderBytes" 2-byte header scheme rather than real WebSocket framing.

The server's HTTP request handler and WebSocket upgrade handler each independently enforced host validation by comparing the `Host` header against a single `expectedAuthority` value (`=== expectedAuthority`). This strict single-authority check is implicated by the PR title ("fixing local server + localhost") as a source of local development / Codespaces access problems, since it apparently did not accept localhost variants or GitHub Codespaces forwarded-port hostnames.

## Decision

1. Remove the HTTP `/__dashboard_copilot` POST endpoint and its synchronous request/response model entirely.
2. Multiplex a new command/event protocol for Copilot requests onto the existing dashboard preview WebSocket connection, replacing the ad hoc 2-byte header scheme with real WebSocket frame parsing (`readWebsocketFrames`): text frames (opcode 0x1), ping frames (opcode 0x9, answered with `websocketPongFrame`), and close frames (opcode 0x8), with a 16,384-byte frame size cap and rejection of unsupported opcodes or oversized frames.
3. Define client→server commands `copilot.start` (`{ view, request }`, with `view` validated to 1–200 characters and `request` validated to 1–10000 trimmed characters — the same validation previously applied to the HTTP POST body) and `copilot.stop` (only honored if sent from the same socket, `copilotSocket`, that started the active request).
4. Define server→client streaming events sent via `sendSocketEvent`: `started`, `debug`, `assistant-delta`, `assistant-message`, `status`, `error`, `stopped`, and `done`, replacing the single synchronous JSON response with a multi-event async stream.
5. Extend `startCopilotRuntime`'s returned runtime with a `stop()` method and an `activeSession` handle (wrapping `session.abort()` + `session.disconnect()`); `prompt()` now accepts an `onEvent` callback forwarding session events (`assistant.message_delta`, `assistant.message`, `tool.execution_start`, `tool.execution_complete`, `session.error`, `session.idle` with `aborted`) and returns `{ aborted }`. `close()` now also stops any active session before shutdown. On socket disconnect, the handler calls `copilotRuntime?.stop()` for cleanup.
6. Preserve the single-active-request concurrency constraint, but enforce it by rejecting `copilot.start` over the socket instead of returning HTTP 409.
7. Remove the Origin/Content-Type header check that previously guarded the HTTP Copilot endpoint, relying instead on the existing WebSocket upgrade validation (`isAllowedHost` plus `sec-websocket-key`/`sec-websocket-version` checks) as the trust boundary for Copilot requests.
8. Introduce `codespaceAuthority` and `localhostAuthority` variables and a new `isAllowedHost(host)` predicate that accepts a request if the `Host` header matches `expectedAuthority` OR `localhostAuthority` OR `codespaceAuthority`. Apply this single predicate to both the HTTP request handler and the WebSocket upgrade handler, replacing the two separate strict `=== expectedAuthority` checks.

## Alternatives Considered

- **Keep the synchronous HTTP endpoint and add polling for progress.** The diff replaces the single JSON HTTP response with a multi-event WebSocket stream (`assistant-delta`, `status`, etc.), implying that continuing to use request/response HTTP (e.g., with client-side polling for progress) was rejected in favor of a persistent streaming connection. This alternative and the specific reasoning for rejecting it are inferred from the diff's shift to streaming events, not stated explicitly in the evidence.
- **Keep the strict single-authority host check and require users to work around it externally (e.g., manual host-header rewriting or proxy configuration) instead of expanding server-side allowlisting.** The introduction of `isAllowedHost` with `localhostAuthority` and `codespaceAuthority` alternatives implies that the prior single-`expectedAuthority` check was a barrier to local/Codespaces development, and that broadening the allowlist server-side was chosen over pushing the workaround to the client/environment. This alternative and rejection rationale are inferred from the diff, not asserted as fact in the evidence.

## Consequences

**Positive:**
- The dashboard UI can now receive live, incremental progress updates (`assistant-delta`, `status`, `debug`) during a Copilot request instead of waiting for a single final response, enabling streaming UX.
- Mid-flight cancellation is now supported via `copilot.stop` and `stop()`/`activeSession`, which was not possible under the prior synchronous request/response model.
- Cleanup on socket disconnect (`copilotRuntime?.stop()`) prevents orphaned active sessions when a client disconnects mid-request, an improvement over the connection-agnostic HTTP model.
- Local development and Codespaces access to the dashboard preview server should improve, since `isAllowedHost` now accepts localhost and Codespaces-forwarded hostnames in addition to the original expected authority, applied consistently across both the HTTP and WebSocket upgrade paths.
- Consolidating host-authority validation into one `isAllowedHost` predicate, used by both the HTTP handler and WebSocket upgrade handler, removes the prior duplication of two separate strict equality checks.

**Negative:**
- The removal of the dedicated Origin/Content-Type header check for the Copilot endpoint means Copilot request trust now depends entirely on the WebSocket upgrade validation (`isAllowedHost` plus `sec-websocket-key`/`sec-websocket-version`); any gap in that validation would now also expose the Copilot command channel, whereas previously it had its own independent check.
- Broadening `isAllowedHost` to accept `localhostAuthority` and `codespaceAuthority` in addition to `expectedAuthority` increases the set of Host header values the server will accept, which is a strictly larger trust surface than the prior single-authority check.
- The protocol complexity increases: the server must now implement WebSocket frame parsing (`readWebsocketFrames`) with size caps and opcode handling, session lifecycle management (`activeSession`, `stop()`), and multiple event types (`started`, `debug`, `assistant-delta`, `assistant-message`, `status`, `error`, `stopped`, `done`), replacing what was a simple single-endpoint HTTP handler.
- Not inferable from current pull request evidence: any performance or latency impact of the new protocol, or any user-facing/API compatibility considerations for clients still expecting the old `/__dashboard_copilot` HTTP endpoint.
