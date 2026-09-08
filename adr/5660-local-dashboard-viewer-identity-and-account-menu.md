# ADR 5660: Serve Local Dashboard Viewer Identity via `gh api user` and Consolidate Account Actions into an Account Menu

## Status

Draft

## Context

The local dashboard server (`dashboard/local-server.mjs`) previously computed `sourcesContent`/`sourceManifestContent` at startup and served them to the client, but had no mechanism for exposing the local user's GitHub identity to the dashboard UI. To support a viewer-aware UI, the server needed a way to fetch and safely expose the authenticated user's GitHub identity (login, name, avatar) when running in local mode.

Separately, the dashboard top bar and sidebar navigation exposed theme toggling as a single button and the "configuration" page as a standalone entry in the primary sidebar navigation list, with no unified location for account-related actions.

## Decision

- Add `loadLocalViewer(ghExecutable)` in `dashboard/local-server.mjs`, which invokes `gh api user --jq '{login: .login, name: .name, avatarUrl: .avatar_url}'` and passes the result through a new `normalizeLocalViewer(viewer)` validator/sanitizer. `normalizeLocalViewer` enforces that `login` matches the GitHub username regex, that `avatarUrl` is a valid `https` URL without embedded credentials, and falls back to `login` for `name` when absent. Any failure (exec failure, invalid data) causes `loadLocalViewer` to return `null`.
- `startDashboardServer` accepts a `loadViewer` option (defaulting to `loadLocalViewer`), computes `viewerContent` once at startup alongside the existing `sourcesContent`/`sourceManifestContent`, and serves it via a new `/viewer.json` endpoint.
- The client (`dashboard/site/index.html`) fetches `./viewer.json` only when the `local-preview` query param is present, falling back to `null` on failure or a non-OK response, and passes the result as a `viewer` prop into `renderDashboard`.
- In `dashboard/site/src/presenter.js`, the sidebar navigation list now filters out the `configuration` page from the primary nav; access to configuration moves into a new `<details class="account-menu">` component in the top bar. This component renders a summary/avatar button (viewer's GitHub avatar image, or a person-icon fallback when no viewer is present) and a popover containing a "Settings" link (shown only if a configuration page exists) plus theme toggles. The prior single theme-toggle button is replaced by a per-value `[data-theme-value]` toggle scheme. Click-outside and Escape-key handlers close the menu.
- Corresponding CSS is added in `dashboard/site/src/styles.js` for `.account-menu`, `.account-menu-avatar`, `.account-menu-avatar-image`, `.account-menu-popover`, and `.account-menu-settings`.

## Alternatives Considered

- **Fetch viewer identity directly from the client via a GitHub API call**, rather than resolving it server-side through the local `gh` CLI. Not chosen: the implementation instead computes `viewerContent` server-side at startup in `local-server.mjs` and serves it as a static `/viewer.json` endpoint, avoiding client-side GitHub API credentials/exposure.
- **Keep configuration as a standalone sidebar navigation entry** alongside a separate theme-toggle button, rather than consolidating both into a single account-menu component. Not chosen: the sidebar nav list now filters out the `configuration` page, and access to it is relocated into the new `account-menu` popover alongside theme toggles.

## Consequences

**Positive:**
- Viewer identity is resolved once at server startup and exposed through a single sanitized `/viewer.json` payload, with `normalizeLocalViewer` guarding against malformed logins, non-https avatar URLs, or URLs containing embedded credentials before the data reaches the client.
- The account-menu component centralizes account-related actions (viewing identity, accessing settings, toggling theme) in one top-bar location, reducing the primary sidebar navigation to core content pages.
- The viewer fetch is opt-in (`local-preview` query param) and fails closed to `null` on error, so non-local or failed contexts degrade gracefully to the person-icon fallback rather than breaking the UI.

**Negative:**
- The `configuration` page is no longer directly reachable from the primary sidebar navigation; users must open the account menu to reach "Settings," changing an existing navigation path.
- The `/viewer.json` endpoint and `loadLocalViewer` depend on the `gh` CLI being authenticated and available in the local server's environment; specifics of behavior in environments where `gh` is unavailable or unauthenticated beyond "returns null" are Not inferable from current pull request evidence.
- Broader UX or accessibility impact of the click-outside/Escape-key popover interaction pattern is Not inferable from current pull request evidence.
