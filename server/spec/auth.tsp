import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

@example(#{login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1"})
model Account {
  login: string;
  avatarUrl: string;
}

@tag("Hosted authentication")
namespace Auth {
  /** Hosted profile only. Start the GitHub OAuth flow; responds with a redirect to GitHub and sets a short-lived state cookie. */
  @route("/auth/login")
  @get op login(@query select_account?: string):
    { @statusCode code: 302; @header location: string } | BadRequest | Unavailable;

  /** Hosted profile only. Exchange the GitHub OAuth code and state; sets the HttpOnly session and CSRF cookies, then redirects home. Failure pages are HTML. */
  @route("/auth/callback")
  @get op callback(@query code?: string, @query state?: string):
    { @statusCode code: 302; @header location: string } | BadRequest | Forbidden | Unavailable;

  /** Hosted profile only. A public, static HTML confirmation page. */
  @route("/auth/logged-out")
  @get op loggedOut(): { @header contentType: "text/html; charset=utf-8"; @body body: string };

  /** Hosted profile only. An authenticated GitHub account (not OAuth tokens). */
  @useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "cao_session">)
  @route("/api/auth/session")
  @get op session(): Account | Unauthorized;

  /** Hosted profile only. Revokes the server-side session and clears cookies. Requires the X-CSRF-Token returned in the cao_csrf cookie. */
  @useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "cao_session">)
  @route("/auth/logout")
  @post op logout(@header("X-CSRF-Token") csrfToken: string):
    { @statusCode code: 204 } | Unauthorized | Forbidden | Unavailable;

  /** Hosted profile only. Revokes the current session and returns the explicit account-selection login path. */
  @useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "cao_session">)
  @route("/auth/switch-account")
  @post op switchAccount(@header("X-CSRF-Token") csrfToken: string):
    { loginUrl: string } | Unauthorized | Forbidden | Unavailable;
}
