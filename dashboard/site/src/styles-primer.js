import { baseStyles } from './styles-base.js';
import { shellStyles } from './styles-shell.js';
import { viewStyles } from './styles-views.js';
import { chartStyles } from './styles-charts.js';
import { componentStyles } from './styles-components.js';
import { inboxStyles } from './styles-inbox.js';
import { overviewStyles } from './styles-overview.js';
import { operationStyles } from './styles-operations.js';
import { contentStyles } from './styles-content.js';
import { queryEditorStyles } from './styles-query-editor.js';
import { responsiveStyles } from './styles-responsive.js';
import { accessibilityStyles } from './styles-accessibility.js';

// Preserve cascade order, including the final responsive and accessibility overrides.
export const primerStyles = [
  baseStyles,
  shellStyles,
  viewStyles,
  chartStyles,
  componentStyles,
  inboxStyles,
  overviewStyles,
  operationStyles,
  contentStyles,
  queryEditorStyles,
  responsiveStyles,
  accessibilityStyles
].join('');
