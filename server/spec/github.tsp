import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

/** Safe repository metadata; upstream credentials and unrestricted GitHub payloads are never returned. */
@example(#{
  full_name: "githubnext/gh-aw-cao",
  description: "Central Agentic Ops",
  html_url: "https://github.com/githubnext/gh-aw-cao",
  default_branch: "main",
  stargazers_count: 10,
  forks_count: 2,
  open_issues_count: 3,
  archived: false,
  visibility: "public"
})
model GitHubRepository {
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: int64;
  forks_count: int64;
  open_issues_count: int64;
  archived: boolean;
  visibility: string;
}

/** The latest published release, not an inferred version or a list of assets. */
@example(#{
  tag_name: "v1.0.0",
  name: "Version 1",
  html_url: "https://github.com/githubnext/gh-aw-cao/releases/tag/v1.0.0",
  published_at: "2026-10-01T00:00:00Z",
  draft: false,
  prerelease: false
})
model GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

model GitHubCacheHeaders {
  @header("ETag") etag: string;
  @header("Cache-Control") cacheControl: string;
  /** Seconds since the server last validated this resource with GitHub. */
  @header("Age") age?: int32;
  /** A stale response is never assigned a new freshness window. */
  @header("Warning") warning?: string;
  /** Minimum delay before attempting to revalidate an unavailable live source. */
  @header("Retry-After") retryAfter?: string;
}

model GitHubResourceResponse<T> {
  ...GitHubCacheHeaders;
  @statusCode statusCode: 200;
  @body body: T;
}

model GitHubNotModified {
  ...GitHubCacheHeaders;
  @statusCode statusCode: 304;
}

model GitHubRetry<Code extends int32> extends Failure<Code> {
  @header("Retry-After") retryAfter?: string;
}

@tag("GitHub resources")
@useAuth(DashboardAuth)
namespace GitHubResources {
  /**
   * Read-only, repository-scoped GitHub metadata through CAO. Local deployments
   * use the server's gh CLI credential; hosted deployments use a GitHub App.
   * Missing credentials or unavailable live access return 503, never a browser
   * redirect to GitHub. Static Pages deployments have no live endpoint.
   * Responses are private caches with a five-minute freshness window and
   * stale-while-revalidate support. Send If-None-Match to reuse cached data.
   */
  @route("/api/v1/github/repos/{owner}/{repo}")
  @get op repository(
    @path owner: string,
    @path repo: string,
    @header("If-None-Match") ifNoneMatch?: string
  ): GitHubResourceResponse<GitHubRepository> | GitHubNotModified
    | BadRequest | Unauthorized | Forbidden | NotFound
    | GitHubRetry<429> | GitHubRetry<503>;

  /** Same access and conditional-cache behavior as repository metadata; 404 means no accessible latest release. */
  @route("/api/v1/github/repos/{owner}/{repo}/releases/latest")
  @get op latestRelease(
    @path owner: string,
    @path repo: string,
    @header("If-None-Match") ifNoneMatch?: string
  ): GitHubResourceResponse<GitHubRelease> | GitHubNotModified
    | BadRequest | Unauthorized | Forbidden | NotFound
    | GitHubRetry<429> | GitHubRetry<503>;
}
