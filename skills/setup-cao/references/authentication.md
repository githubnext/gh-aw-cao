# Setup authentication

Load this reference only when selecting or troubleshooting an authentication
profile after exact repository scope is known.

| Verified scope | Compatible profile |
| --- | --- |
| Private or privileged repositories under one organization | `github-app` |
| Repositories across organizations in one enterprise | `enterprise-app` |
| Approved owner-scoped credentials where Apps are unavailable | `token` |

Every profile must cover the full selected read scope. Prefer private GitHub
Apps for durable automation. An organization App cannot cover another owner;
enterprise Apps require the selected organizations to belong to one enterprise.
Use independent control planes for unrelated organizations or enterprises.

Use owner-scoped fine-grained PAT pairs only when organization policy permits
them, the required APIs support them, and Apps are unavailable. The operator
must have access to every selected repository and approve one read/write pair
per resource owner. Never use a classic PAT.

Preview App or PAT setup before mutation where the command supports `--dry-run`.
Private keys and tokens must enter only through GitHub or a secure interactive
prompt, never files, chat, arguments, workflow inputs, or commits.

Target-repository authentication and model-provider authentication are
independent. A GitHub App or PAT does not authenticate Copilot or another model
provider. Organization billing checks are optional during setup and must not
become a prerequisite when the operator cannot inspect billing.

For exact commands, permissions, variables, secrets, multi-owner mapping, and
data-residency behavior, use
[Control Plane Authentication Profiles](../../../docs/control-plane-authentication.md).

