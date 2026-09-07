# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.js >> DLS-PAGE-014 DLS-PAGE-015 built-in packages page renders report-style mode filters, AIC utilization, and run trends in browser
- Location: test/e2e/smoke.spec.js:1397:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Ambient Context', level: 1 })
Expected: visible
Error: strict mode violation: getByRole('heading', { name: 'Ambient Context', level: 1 }) resolved to 2 elements:
    1) <h1 tabindex="-1" id="page-title" data-breadcrumb-page="">Ambient Context</h1> aka getByLabel('Ambient Context', { exact: true }).getByRole('heading', { name: 'Ambient Context' })
    2) <h1>Ambient Context</h1> aka getByLabel('Ambient Context README').getByRole('heading', { name: 'Ambient Context' })

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('heading', { name: 'Ambient Context', level: 1 })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - link "Skip to main content" [ref=e4] [cursor=pointer]:
    - /url: "#main-content"
  - generic [ref=e5]:
    - complementary "Central Agentic Ops navigation" [ref=e6]:
      - generic [ref=e7]:
        - link "GitHub" [ref=e8] [cursor=pointer]:
          - /url: "#page-packages"
        - button "Collapse navigation" [expanded] [ref=e13] [cursor=pointer]
      - navigation "Primary" [ref=e16]:
        - link "Packages" [ref=e17] [cursor=pointer]:
          - /url: "#page-packages"
        - link "Value & outcomes" [ref=e21] [cursor=pointer]:
          - /url: "#page-operational-value"
        - link "Package" [ref=e25] [cursor=pointer]:
          - /url: "#page-package-insights"
        - link "Package" [ref=e29] [cursor=pointer]:
          - /url: "#page-package-detail"
        - link "Package" [ref=e33] [cursor=pointer]:
          - /url: "#page-package-dispatches"
        - link "Package" [ref=e37] [cursor=pointer]:
          - /url: "#page-package-reports"
    - generic [ref=e41]:
      - banner [ref=e42]:
        - generic [ref=e43]:
          - generic [ref=e44]:
            - generic [ref=e45]:
              - heading "Ambient Context" [active] [level=1] [ref=e46]
              - generic [ref=e47]: Review
            - paragraph [ref=e50]: Orchestrator and worker workflows in the Ambient Context package.
          - generic [ref=e51]:
            - generic "Dashboard filters" [ref=e52]:
              - button "Horizon 1 week. Show time and mode filters" [ref=e55] [cursor=pointer]
            - button "Switch to dark mode" [ref=e58] [cursor=pointer]
      - main [ref=e61]:
        - generic [ref=e65]:
          - generic [ref=e67]:
            - navigation "Ambient Context views" [ref=e68]:
              - link "Insights" [ref=e69] [cursor=pointer]:
                - /url: "#page-package-insights?package=ambient-context"
              - link "Workflows" [ref=e73] [cursor=pointer]:
                - /url: "#page-package-detail?package=ambient-context"
              - link "Dispatches" [ref=e77] [cursor=pointer]:
                - /url: "#page-package-dispatches?package=ambient-context"
              - link "Reports" [ref=e81] [cursor=pointer]:
                - /url: "#page-package-reports?package=ambient-context"
            - generic [ref=e85]:
              - generic [ref=e91]:
                - generic [ref=e92]:
                  - heading "Ambient Context" [level=2] [ref=e93]
                  - generic [ref=e94]: Package
                - paragraph [ref=e95]: Operational workflows in the Ambient Context package.
              - generic [ref=e96]:
                - article "Ambient Context README" [ref=e97]:
                  - heading "Ambient Context" [level=1] [ref=e98]
                  - paragraph [ref=e99]: Operational workflows in the Ambient Context package.
                  - paragraph [ref=e100]: Package README content is unavailable in this inventory.
                - complementary "Ambient Context package information" [ref=e101]:
                  - generic [ref=e102]:
                    - heading "About" [level=2] [ref=e103]
                    - paragraph [ref=e104]: Operational workflows in the Ambient Context package.
                    - generic [ref=e105]:
                      - generic [ref=e106]:
                        - term [ref=e107]: Workflows
                        - definition [ref=e108]: "2"
                      - generic [ref=e109]:
                        - term [ref=e110]: Owner
                        - definition [ref=e111]: Unknown
                      - generic [ref=e112]:
                        - term [ref=e113]: Rollout
                        - definition [ref=e114]: review
                  - group [ref=e115]:
                    - generic "Resources Show details" [ref=e116] [cursor=pointer]:
                      - generic [ref=e117]: Resources
                      - generic [ref=e118]: Show details
          - region [ref=e120]:
            - heading "Orchestrator and workers" [level=3] [ref=e121]
            - generic [ref=e122]:
              - generic [ref=e123]:
                - generic [ref=e124]:
                  - generic [ref=e125]: Filter Orchestrator and workers
                  - searchbox "Filter Orchestrator and workers" [ref=e126]
                - status [ref=e127]: Showing 2 of 2 results
              - region "Filter Orchestrator and workers results" [ref=e128]:
                - table [ref=e129]:
                  - rowgroup [ref=e130]:
                    - row [ref=e131]:
                      - columnheader [ref=e132]:
                        - button "Role ↕" [ref=e133] [cursor=pointer]
                      - columnheader [ref=e134]:
                        - button "Workflow ↕" [ref=e135] [cursor=pointer]
                      - columnheader [ref=e136]:
                        - button "Definition ↕" [ref=e137] [cursor=pointer]
                      - columnheader [ref=e138]:
                        - button "Mode ↕" [ref=e139] [cursor=pointer]
                      - columnheader [ref=e140]:
                        - button "Registration ↕" [ref=e141] [cursor=pointer]
                      - columnheader [ref=e142]:
                        - button "Runs ↕" [ref=e143] [cursor=pointer]
                      - columnheader [ref=e144]:
                        - button "Total AIC ↕" [ref=e145] [cursor=pointer]
                    - row [ref=e146]:
                      - columnheader [ref=e147]:
                        - list "Most common values" [ref=e148]:
                          - listitem [ref=e149]:
                            - generic "orchestrator" [ref=e150]
                            - strong [ref=e151]: 50%
                          - listitem [ref=e152]:
                            - generic "worker" [ref=e153]
                            - strong [ref=e154]: 50%
                      - columnheader [ref=e155]:
                        - list "Most common values" [ref=e156]:
                          - listitem [ref=e157]:
                            - generic "Ambient Context" [ref=e158]
                            - strong [ref=e159]: 50%
                          - listitem [ref=e160]:
                            - generic "Ambient Context Worker" [ref=e161]
                            - strong [ref=e162]: 50%
                      - columnheader [ref=e163]:
                        - list "Most common values" [ref=e164]:
                          - listitem [ref=e165]:
                            - generic ".github/workflows/ambient-context-worker.md" [ref=e166]
                            - strong [ref=e167]: 50%
                          - listitem [ref=e168]:
                            - generic ".github/workflows/ambient-context.md" [ref=e169]
                            - strong [ref=e170]: 50%
                      - columnheader [ref=e171]:
                        - list "Most common values" [ref=e172]:
                          - listitem [ref=e173]:
                            - generic "review" [ref=e174]
                            - strong [ref=e175]: 100%
                      - columnheader [ref=e176]:
                        - list "Most common values" [ref=e177]:
                          - listitem [ref=e178]:
                            - generic "unknown" [ref=e179]
                            - strong [ref=e180]: 100%
                      - columnheader [ref=e181]:
                        - generic [ref=e182]:
                          - img "Runs distribution, 2 values" [ref=e183]
                          - generic [ref=e186]:
                            - generic [ref=e187]:
                              - term [ref=e188]: Mean
                              - definition [ref=e189]: "2.5"
                            - generic [ref=e190]:
                              - term [ref=e191]: Stddev
                              - definition [ref=e192]: "3.54"
                      - columnheader "No values" [ref=e193]
                  - rowgroup [ref=e194]:
                    - row [ref=e195]:
                      - cell "Orchestrator" [ref=e196]
                      - cell "Ambient Context" [ref=e197]
                      - cell ".github/workflows/ambient-context.md" [ref=e198]
                      - cell "review" [ref=e199]
                      - cell "unknown" [ref=e201]
                      - cell "0" [ref=e203]
                      - cell "—" [ref=e204]
                    - row [ref=e205]:
                      - cell "Worker" [ref=e206]
                      - cell "Ambient Context Worker" [ref=e207]
                      - cell ".github/workflows/ambient-context-worker.md" [ref=e208]
                      - cell "review" [ref=e209]
                      - cell "unknown" [ref=e211]
                      - cell "5" [ref=e213]
                      - cell "—" [ref=e214]
      - contentinfo [ref=e215]:
        - generic [ref=e216]:
          - generic [ref=e217]: Last updated
          - time [ref=e218]: Aug 29, 2026, 8:01 PM UTC
          - generic [ref=e219]: · Generated deterministically from dashboard data.
        - button "Reload the dashboard to refresh cached data" [ref=e220] [cursor=pointer]:
          - generic [ref=e223]: Refresh
```

# Test source

```ts
  1604 |                   title: 'Reports',
  1605 |                   data: { source: 'package-reports', 'route-field': 'package' },
  1606 |                   mark: 'table',
  1607 |                   controls: 'interactive',
  1608 |                   encoding: {
  1609 |                     columns: [
  1610 |                       { field: 'outcome-title', type: 'nominal', title: 'Report', display: 'outcome-link' },
  1611 |                       { field: 'outcome-status', type: 'nominal', title: 'Status', display: 'status' },
  1612 |                       { field: 'rollout-mode', type: 'nominal', title: 'Mode', display: 'mode' },
  1613 |                       { field: 'outcome-category', type: 'nominal', title: 'Type' },
  1614 |                       { field: 'observed-at', type: 'temporal', title: 'Updated' }
  1615 |                     ]
  1616 |                   }
  1617 |                 }
  1618 |               ]
  1619 |             }
  1620 |           ]
  1621 |         }
  1622 |       };
  1623 |       const sources = {
  1624 |         workflows: {
  1625 |           source: 'workflows',
  1626 |           rows: [
  1627 |             { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 250, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
  1628 |             { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 800, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
  1629 |             { package: 'aw-doctor', 'package-name': 'AW Doctor', 'package-icon': 'gear', workflow: '.github/workflows/aw-doctor.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 250, 'package-aic-allowance': 1250, 'package-inventory-warnings': 1 }
  1630 |           ],
  1631 |           metadata
  1632 |         },
  1633 |         runs: {
  1634 |           source: 'runs',
  1635 |           rows: [
  1636 |             { workflow: '.github/workflows/ambient-context-worker.md', run: '3', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T18:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/3', label: 'Run 3' } },
  1637 |             { workflow: '.github/workflows/ambient-context-worker.md', run: '5', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T17:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/5', label: 'Run 5' } },
  1638 |             { workflow: '.github/workflows/ambient-context-worker.md', run: '6', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T16:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/6', label: 'Run 6' } },
  1639 |             { workflow: '.github/workflows/ambient-context-worker.md', run: '7', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T15:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/7', label: 'Run 7' } },
  1640 |             { workflow: '.github/workflows/ambient-context-worker.md', run: '8', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T14:00:00Z', 'run-conclusion': 'failure', 'failure-job': 'pre_activation', 'failure-message': 'Target authority missing: add .github/workflows/cao.json to the target default branch for live mode', 'failure-step': 'Run CAO control precompute', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/8', label: 'Run 8' } },
  1641 |             { workflow: '.github/workflows/aw-doctor.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' },
  1642 |             { workflow: '.github/workflows/aw-doctor.md', run: '2', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'live' }
  1643 |           ],
  1644 |           metadata
  1645 |         },
  1646 |         usage: {
  1647 |           source: 'usage',
  1648 |           rows: [
  1649 |             { workflow: '.github/workflows/aw-doctor.md', run: '1', invocation: 'a', aic: 23.9, 'rollout-mode': 'review' }
  1650 |           ],
  1651 |           metadata: { ...metadata, completeness: 'partial' }
  1652 |         },
  1653 |         findings: {
  1654 |           source: 'findings',
  1655 |           rows: [
  1656 |             { workflow: '.github/workflows/aw-doctor.md', run: '2', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:05:00Z' }
  1657 |           ],
  1658 |           metadata
  1659 |         },
  1660 |         outcomes: {
  1661 |           source: 'outcomes',
  1662 |           rows: [
  1663 |             { package: 'ambient-context', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', run: '3', 'run-conclusion': 'success', 'safe-output': 'ambient-review', 'outcome-title': 'Review ambient context proposal', 'outcome-summary': 'A review proposal is ready.', 'outcome-category': 'issue', 'outcome-status': 'open', 'outcome-state': 'pending', 'rollout-mode': 'review', 'published-at': '2026-08-29T18:00:00Z', 'observed-at': '2026-08-29T18:05:00Z' },
  1664 |             { package: 'ambient-context', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', run: '4', 'run-conclusion': 'success', 'safe-output': 'ambient-live', 'outcome-title': 'Reconcile ambient context', 'outcome-summary': 'Updated durable guidance.', 'outcome-category': 'pull-request', 'outcome-status': 'closed', 'outcome-state': 'lifecycle-close', 'rollout-mode': 'live', 'published-at': '2026-08-28T18:00:00Z', 'observed-at': '2026-08-28T18:05:00Z' },
  1665 |             { package: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '1', 'run-conclusion': 'success', 'safe-output': 'maintenance-review', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' },
  1666 |             { package: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '2', 'run-conclusion': 'failure', 'safe-output': 'maintenance-live', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:00:00Z' }
  1667 |           ],
  1668 |           metadata
  1669 |         },
  1670 |         'operational-values': {
  1671 |           source: 'operational-values',
  1672 |           rows: [],
  1673 |           metadata
  1674 |         }
  1675 |       };
  1676 | 
  1677 |       document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
  1678 |     </script>
  1679 |   `);
  1680 | 
  1681 |   await expect(page.getByRole('heading', { name: 'Packages', level: 1 })).toBeVisible();
  1682 |   await expect(page.locator('.package-utilization-card')).toHaveCount(2);
  1683 |   await expect(page.locator('[data-package-id="aw-doctor"]')).toContainText('9.6%');
  1684 |   await expect(page.locator('[data-package-id="aw-doctor"] .octicon-gear')).toBeVisible();
  1685 |   await expect(page.locator('[data-package-id="ambient-context"]')).toContainText('No AIC usage was reported');
  1686 |   await expect(page.getByRole('heading', { name: 'All output by package', level: 3 })).toBeVisible();
  1687 |   await expect(page.locator('.package-trend-panel + .package-summary')).toBeVisible();
  1688 |   const awDoctorSummary = page.locator('.package-summary-table tbody tr').filter({ hasText: 'AW Doctor' });
  1689 |   await expect(awDoctorSummary).toContainText('AW Doctor');
  1690 |   await expect(awDoctorSummary.locator('.octicon-gear')).toBeVisible();
  1691 |   await expect(awDoctorSummary.locator('td')).toHaveText(['2', '1', '1', '1', '1', '23.9', 'Aug 29, 2026, 10:05 AM']);
  1692 |   await expect(page.getByRole('heading', { name: 'All runs over time', level: 3 })).toBeVisible();
  1693 |   await expect(page.locator('.package-chart-point')).toHaveCount(30);
  1694 |   await expect(page.locator('[data-package-id="ambient-context"] a')).toHaveAttribute('href', '#page-package-insights?package=ambient-context');
  1695 | 
  1696 |   await page.locator('[data-package-id="ambient-context"] a').click();
  1697 |   await expect(page).toHaveURL(/#page-package-insights\?package=ambient-context$/);
  1698 |   await expect(page.getByRole('heading', { name: 'Ambient Context', level: 1 })).toBeVisible();
  1699 |   await expect(page.getByText('No workflow observations yet')).toBeVisible();
  1700 | 
  1701 |   await page.evaluate(() => {
  1702 |     window.location.hash = '#page-package-detail?package=ambient-context';
  1703 |   });
> 1704 |   await expect(page.getByRole('heading', { name: 'Ambient Context', level: 1 })).toBeVisible();
       |                                                                                  ^ Error: expect(locator).toBeVisible() failed
  1705 |   await expect(page.locator('[data-page-mode]')).toHaveText('Review');
  1706 |   await expect(page.locator('[data-nav-page-id="packages"]')).toHaveAttribute('aria-current', 'page');
  1707 |   await expect(page.getByRole('navigation', { name: 'Ambient Context views' })).toContainText('InsightsWorkflowsDispatchesReports');
  1708 |   await expect(page.getByRole('heading', { name: 'Orchestrator and workers', level: 3 })).toBeVisible();
  1709 |   const packageWorkflowRows = page.locator('[data-page-id="package-detail"] .custom-table tbody tr');
  1710 |   await expect(packageWorkflowRows).toHaveCount(2);
  1711 |   await expect(page.locator('[data-page-id="package-detail"] .custom-table thead tr').first().locator('th')).toHaveText([
  1712 |     'Role',
  1713 |     'Workflow',
  1714 |     'Definition',
  1715 |     'Mode',
  1716 |     'Registration',
  1717 |     'Runs',
  1718 |     'Total AIC'
  1719 |   ]);
  1720 |   await expect(packageWorkflowRows.first()).toContainText('OrchestratorAmbient Context');
  1721 |   await expect(packageWorkflowRows.first().locator('td').nth(5)).toHaveText('0');
  1722 |   await expect(packageWorkflowRows.first().locator('td').nth(6)).toHaveText('—');
  1723 |   await expect(packageWorkflowRows.nth(1)).toContainText('WorkerAmbient Context Worker');
  1724 | 
  1725 |   await page.getByRole('navigation', { name: 'Ambient Context views' }).getByRole('link', { name: 'Dispatches' }).click();
  1726 |   await expect(page).toHaveURL(/#page-package-dispatches\?package=ambient-context$/);
  1727 |   const failureReasonChart = page.getByRole('heading', { name: 'Why these dispatches failed', level: 3 }).locator('..');
  1728 |   await expect(failureReasonChart.locator('.pie-chart-widget')).toHaveAttribute('data-chart-widget', 'pie');
  1729 |   await expect(failureReasonChart.locator('.pie-chart-total-value')).toHaveText('5');
  1730 |   await expect(failureReasonChart.locator('.chart-legend-pie li')).toHaveCount(2);
  1731 |   await expect(failureReasonChart.locator('.chart-legend-pie')).toContainText('GitHub API capacity insufficient4');
  1732 |   await expect(failureReasonChart.locator('.chart-legend-pie')).toContainText('Target authority missing: add .github/workflows/cao.json to the target default branch for live mode1');
  1733 |   const failedDispatchSection = page.getByRole('heading', { name: 'Failed dispatches', level: 3 }).locator('..');
  1734 |   const failedDispatchRows = failedDispatchSection.locator('tbody tr');
  1735 |   await expect(failedDispatchRows).toHaveCount(5);
  1736 |   await expect(failedDispatchSection.locator('thead tr').first().locator('th')).toHaveText([
  1737 |     'Action',
  1738 |     'Why',
  1739 |     'Started',
  1740 |     'Workflow',
  1741 |     'Run title',
  1742 |     'Runtime repository'
  1743 |   ]);
  1744 |   await expect(failedDispatchRows.first().locator('[data-field="status-detail"]')).toHaveText('GitHub API capacity insufficient; reset 1 hour ago');
  1745 |   await expect(failedDispatchRows.last().locator('[data-field="status-detail"]')).toHaveText('Target authority missing: add .github/workflows/cao.json to the target default branch for live mode');
  1746 |   await expect(failedDispatchRows.first().locator('[data-field="status-detail"]')).toHaveAttribute('data-status', 'failure');
  1747 |   await expect(failedDispatchRows.locator('[data-field="status-detail"] a')).toHaveCount(5);
  1748 |   await expect(failedDispatchRows.locator('.table-intent-button')).toHaveCount(5);
  1749 |   const intentButton = failedDispatchRows.first().getByRole('button', { name: 'Review debug prompt' });
  1750 |   await expect(intentButton).toContainText('Review debug prompt');
  1751 |   await intentButton.click();
  1752 |   const intentDialog = page.getByRole('dialog', { name: 'Review debug prompt prompt preview' });
  1753 |   await expect(intentDialog).toBeVisible();
  1754 |   await expect(intentDialog.locator('.table-intent-preview')).toContainText('Debug this failed workflow dispatch.');
  1755 |   await expect(intentDialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  1756 |   await intentDialog.getByRole('button', { name: 'Close prompt preview' }).click();
  1757 |   await expect(intentDialog).toBeHidden();
  1758 |   await expect(intentButton).toBeFocused();
  1759 |   await expect(failedDispatchRows.first().locator('[data-field="status-detail"] a')).toHaveAttribute('href', 'https://github.com/githubnext/gh-aw-cao/actions/runs/3');
  1760 |   const allDispatchRows = page.getByRole('heading', { name: 'All dispatches', level: 3 }).locator('..').locator('tbody tr');
  1761 |   await expect(allDispatchRows).toHaveCount(5);
  1762 | 
  1763 |   await page.getByRole('navigation', { name: 'Ambient Context views' }).getByRole('link', { name: 'Reports' }).click();
  1764 |   await expect(page).toHaveURL(/#page-package-reports\?package=ambient-context$/);
  1765 |   await expect(page.getByRole('heading', { name: 'Reports', level: 3 })).toBeVisible();
  1766 |   const packageReportRows = page.locator('[data-page-id="package-reports"] .custom-table tbody tr');
  1767 |   await expect(packageReportRows).toHaveCount(2);
  1768 |   await page.getByRole('searchbox', { name: 'Filter Reports' }).fill('Reconcile');
  1769 |   const visiblePackageReportRows = page.locator('[data-page-id="package-reports"] .custom-table tbody tr:visible');
  1770 |   await expect(visiblePackageReportRows).toHaveCount(1);
  1771 |   await expect(visiblePackageReportRows).toContainText('Reconcile ambient context');
  1772 | });
  1773 | 
  1774 | test('DLS-PAGE-017 renders an editable filter bar and applies changes automatically', async ({ page }) => {
  1775 |   const presenterModuleUrl = buildPresenterModuleUrl();
  1776 | 
  1777 |   await page.setContent(`
  1778 |     <div id="root"></div>
  1779 |     <script type="module">
  1780 |       import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
  1781 | 
  1782 |       const dashboardDocument = {
  1783 |         languageVersion: '0.1.0',
  1784 |         dashboard: {
  1785 |           id: 'filter-bar-render',
  1786 |           title: 'Central Agentic Ops',
  1787 |           pages: [{
  1788 |             id: 'cost',
  1789 |             kind: 'custom',
  1790 |             title: 'Cost & efficiency',
  1791 |             views: [{
  1792 |               id: 'usage-count',
  1793 |               data: { source: 'usage' },
  1794 |               mark: 'metric',
  1795 |               encoding: { value: { field: 'invocation', aggregate: 'count' } }
  1796 |             }]
  1797 |           }]
  1798 |         }
  1799 |       };
  1800 |       const sources = {
  1801 |         usage: {
  1802 |           source: 'usage',
  1803 |           rows: [
  1804 |             { invocation: 'usage-1', aic: 2, 'rollout-mode': 'review' },
```