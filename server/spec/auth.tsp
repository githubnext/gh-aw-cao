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
  /** Hosted profile only. Ordinary login requests read:org read:user for classic OAuth Apps, or offline_access for GitHub Apps. hosted_cli=1 explicitly starts repository consent only when hosted CLI is enabled and the existing server-side session belongs to a configured administrator with a known GitHub account ID. Classic OAuth adds repo only for that flow. Its signed state binds the initiating session, account ID, login and ten-minute expiry; the callback must retain that subject and current administrator authorization. The query parameter alone grants no authority. */
  @route("/auth/login")
  @get op login(@query select_account?: string, @query hosted_cli?: "1"):
    { @statusCode code: 302; @header location: string } | BadRequest | Unauthorized | Forbidden | Unavailable;

  /** Hosted profile only. Exchange the GitHub OAuth code and signed state; sets the HttpOnly session and CSRF cookies, then redirects home. An administrator-consent callback requires its original active session, matching GitHub account ID and login, current administrator allowlisting, and verified factor evidence. Mismatched or unauthorized callbacks are rejected and issued credentials are revoked or queued for revocation. Failure pages are HTML. */
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
