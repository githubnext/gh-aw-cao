# Ops Publish Add-on

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

The Ops Publish add-on turns an explicit human review action into one deterministic target write. Applying `ops:publish-to-target` to an eligible review issue recreates that issue in its target repository, records publication provenance, and closes the review issue. It does not invoke an AI model or rerun the originating Agentic Workflow.

Ops Publish deliberately recreates issues instead of using GitHub issue transfer. Transfers work only between repositories owned by the same account, and private issues cannot be transferred to public repositories.

## Supported Output

The add-on supports bot-authored `create_issue` safe outputs from workers declared in the control repository's central `.github/workflows/cao.json` manifest. The resolved package and worker list is used when validating the originating run, so newly configured workers do not require publisher code changes.

Pull requests, comments, and artifact-backed review bundles are not publishable by this add-on. Applying the label to those items has no supported publication path.

## Security Model

The review issue body is content, not routing authority. Before publishing, the workflow:

1. requires the labeler to appear in `control-plane.publishing.reviewers`;
2. requires a bot-authored, open issue with generated workflow-run provenance;
3. requires that run's repository to appear in `control-plane.publishing.control-repositories`;
4. fetches the cited run and requires a successful review-mode dispatch from a supported worker on the control repository's default branch;
5. requires the review issue to have been created during that workflow run;
6. derives the target repository and package from trusted run metadata;
7. enforces `control-plane.scope.allowed-owners` and, when set, `control-plane.scope.allowed-repositories`;
8. requires the target's exact default-branch commit to assign that package to the cited control repository in `.github/workflows/cao.json`;
9. checks for an existing publication marker before creating an issue.

The source issue may be edited during human review. Applying `ops:publish-to-target` binds approval to its title and body at that moment; a later edit fails publication until a reviewer removes and reapplies the label. Editing it cannot change the target, package, or control repository selected by the validated workflow run. The originating worker run must come from the control repository's default branch.

## Install

Copy the conventional workflow and script into the private control-plane or review repository that receives review issues:

```bash
review_repository=/path/to/review-repository
mkdir -p "$review_repository/.github/workflows/shared" "$review_repository/ops-publish"
cp ops-publish/ops-publish.yml "$review_repository/.github/workflows/ops-publish.yml"
cp ops-publish/ops-publish.mjs "$review_repository/ops-publish/"
cp .github/workflows/shared/control.mjs .github/workflows/shared/policy.mjs "$review_repository/.github/workflows/shared/"
```

These files are conventional repository automation and are not part of an Agentic Workflow package. Pin the catalog checkout to a reviewed release or commit before copying them.

## Configure

Enable publishing, scope its targets, and name its reviewers in the review repository's `.github/workflows/cao.json`:

```json
{
  "version": 1,
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"]
    },
    "publishing": {
      "enabled": true,
      "control-repositories": ["acme/central-agentic-ops"],
      "reviewers": ["octocat", "hubot"]
    }
  }
}
```

Create the approval label:

```bash
gh label create "ops:publish-to-target" \
  --repo "acme/central-agentic-ops" --color "1f883d" \
  --description "Publish this reviewed operations issue to its validated target"
```

Configure `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` for control-run validation, and `GH_AW_GITHUB_WRITE_APP_ID` and `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` for target publication. The workflow mints separate, repository-scoped installation tokens from the corresponding Apps. For PAT fallback, use dedicated fine-grained secrets: `CENTRAL_AGENTIC_OPS_PUBLISH_CONTROL_TOKEN` with Actions read access only to allowed control repositories, and `CENTRAL_AGENTIC_OPS_PUBLISH_TARGET_TOKEN` with Contents read plus Issues write access only to allowed target repositories. The workflow token handles only the review issue and can read a control run when the add-on and control plane share a repository.

## Operate

Review and edit the private proposal, then apply `ops:publish-to-target`. A successful run creates or finds the corresponding target issue, comments with its URL on the review issue, and closes the review issue as completed. Removing the label before the publication step causes the run to fail closed.

The workflow serializes attempts per review issue. On retry, it scans target issues newer than the review proposal for its deterministic source marker so a target issue created by a partially completed earlier attempt is reused rather than duplicated.
