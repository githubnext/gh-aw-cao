import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DASHBOARD_HORIZON,
  dashboardHorizonHours,
  formatDashboardHorizon,
  formatDashboardHorizonHours,
  resolveDashboardHorizon
} from '../../src/horizon.js';

describe('dashboard horizon', () => {
  it('defaults to one week and converts configured ranges to collection hours', () => {
    expect(resolveDashboardHorizon({})).toBe(DEFAULT_DASHBOARD_HORIZON);
    expect(resolveDashboardHorizon({ defaults: { time: { range: '2d' } } })).toBe('2d');
    expect(dashboardHorizonHours('1w')).toBe(168);
    expect(formatDashboardHorizon('1w')).toBe('1 week');
    expect(formatDashboardHorizon('2d')).toBe('2 days');
    expect(formatDashboardHorizonHours(168)).toBe('1 week');
    expect(formatDashboardHorizonHours(48)).toBe('2 days');
    expect(formatDashboardHorizonHours(36)).toBe('36 hours');
    expect(() => formatDashboardHorizonHours(0)).toThrow('Invalid dashboard horizon hours: 0');
  });
});