---
checkout:
  repository: ${{ inputs.target_repo }}
  github-token: ${{ secrets.GH_AW_GITHUB_READ_PAT || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
  path: target
  current: true
---