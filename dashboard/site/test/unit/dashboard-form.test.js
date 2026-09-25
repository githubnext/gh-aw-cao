import { beforeEach, expect, it, vi } from 'vitest';
import { renderDashboardForm } from '../../src/components/dashboard-form.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

it('renders accessible slider, checkbox, and radio fields in declaration order', () => {
  const form = renderDashboardForm({
    title: 'Performance simulator',
    description: 'Explore scenario inputs.',
    update: { strategy: 'debounce', 'delay-ms': 200 },
    fields: [
      { id: 'workers', label: 'Workers', control: 'slider', default: 4, min: 1, max: 10, step: 1 },
      { id: 'review', label: 'Include review', control: 'checkbox', default: true },
      {
        id: 'profile',
        label: 'Profile',
        control: 'radio',
        default: 'balanced',
        options: [
          { value: 'balanced', label: 'Balanced' },
          { value: 'fast', label: 'Fast' }
        ]
      }
    ]
  }, undefined, () => {});
  document.body.append(form);

  expect(form.querySelectorAll('.dashboard-parameter-field')).toHaveLength(3);
  expect(form.querySelector('input[type="range"]')?.getAttribute('aria-describedby')).toBeNull();
  expect(form.querySelector('fieldset legend')?.textContent).toBe('Profile');
  expect(/** @type {HTMLInputElement} */ (form.querySelector('input[type="checkbox"]')).checked).toBe(true);
});

it('debounces rapid slider changes and emits the latest complete form state', () => {
  const onChange = vi.fn();
  const form = renderDashboardForm({
    update: { strategy: 'debounce', 'delay-ms': 200 },
    fields: [
      { id: 'workers', label: 'Workers', control: 'slider', default: 2, min: 1, max: 10, step: 1 },
      { id: 'review', label: 'Include review', control: 'checkbox', default: true }
    ]
  }, undefined, onChange);
  document.body.append(form);
  const slider = /** @type {HTMLInputElement} */ (form.querySelector('input[type="range"]'));

  slider.value = '3';
  slider.dispatchEvent(new Event('input'));
  slider.value = '7';
  slider.dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(199);
  expect(onChange).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith({ workers: 7, review: true });
});

it('does not emit scheduled work after the form is detached', () => {
  const onChange = vi.fn();
  const form = renderDashboardForm({
    fields: [{ id: 'workers', label: 'Workers', control: 'slider', default: 2, min: 1, max: 10, step: 1 }]
  }, undefined, onChange);
  document.body.append(form);
  const slider = /** @type {HTMLInputElement} */ (form.querySelector('input'));
  slider.value = '8';
  slider.dispatchEvent(new Event('input'));
  form.remove();
  vi.runAllTimers();
  expect(onChange).not.toHaveBeenCalled();
});
