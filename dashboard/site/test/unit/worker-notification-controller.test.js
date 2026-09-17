import { describe, expect, it, vi } from 'vitest';
import { createWorkerNotificationController } from '../../src/worker-notification-controller.js';

function notificationHarness(cancelRequest = vi.fn(() => true)) {
  /** @type {Array<{ dismiss: ReturnType<typeof vi.fn>, update: ReturnType<typeof vi.fn> }>} */
  const handles = [];
  const publish = vi.fn((_notification) => {
    const handle = { dismiss: vi.fn(), update: vi.fn() };
    handles.push(handle);
    return handle;
  });
  return {
    controller: createWorkerNotificationController({ cancelRequest, publish }),
    cancelRequest,
    handles,
    publish
  };
}

describe('worker notification controller', () => {
  it('publishes anonymous notifications and updates identified notifications in place', () => {
    const { controller, handles, publish } = notificationHarness();

    controller.handle({ message: 'Dashboard refreshed.', tone: 'success' });
    controller.handle({ id: 'ingestion', message: 'Ingesting data.', duration: 0 });
    controller.handle({ id: 'ingestion', message: '42 records processed.', duration: 0 });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(handles[1]?.update).toHaveBeenCalledWith(expect.objectContaining({
      message: '42 records processed.'
    }));
  });

  it('owns cancellation, dismissal, and reset for worker notifications', () => {
    const { controller, cancelRequest, handles, publish } = notificationHarness();
    controller.handle({
      id: 'ingestion',
      message: 'Ingesting data.',
      duration: 0,
      action: {
        label: 'Cancel',
        operation: 'cancel-data-ingestion',
        placement: 'details',
        requestId: 7
      }
    });
    const firstNotification = handles[0];
    const initial = /** @type {{ action?: { run?: () => void, placement?: string } }} */ (
      publish.mock.calls[0]?.[0]
    );
    expect(initial.action?.placement).toBe('details');
    initial.action?.run?.();
    expect(cancelRequest).toHaveBeenCalledWith(7);
    expect(firstNotification?.update).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Data ingestion cancelled.',
      tone: 'warning',
      dismissOnCollapse: true
    }));
    controller.handle({ id: 'ingestion', message: 'Late worker progress.', duration: 0 });
    expect(firstNotification?.update).toHaveBeenCalledOnce();

    controller.handle({ id: 'ingestion', dismiss: true });
    expect(firstNotification?.dismiss).not.toHaveBeenCalled();

    controller.handle({ id: 'other', message: 'Working.', duration: 0 });
    controller.reset();
    expect(handles[1]?.dismiss).toHaveBeenCalledOnce();
    expect(cancelRequest).toHaveBeenCalledOnce();
  });

  it('ignores malformed messages and keeps a notification active when cancellation fails', () => {
    const { controller, handles, publish } = notificationHarness(vi.fn(() => false));

    controller.handle(null);
    controller.handle([]);
    controller.handle({ message: 42 });
    expect(publish).not.toHaveBeenCalled();

    controller.handle({
      id: 'ingestion',
      message: 'Ingesting data.',
      action: { operation: 'cancel-data-ingestion', requestId: 9 }
    });
    const initial = /** @type {{ action?: { label?: string, run?: () => void } }} */ (
      publish.mock.calls[0]?.[0]
    );
    expect(initial.action?.label).toBe('Cancel');
    initial.action?.run?.();
    expect(handles[0]?.update).not.toHaveBeenCalled();

    controller.handle({ id: 'ingestion', message: 'Still working.' });
    expect(handles[0]?.update).toHaveBeenCalledWith({ message: 'Still working.' });
    controller.handle({ id: 'ingestion', dismiss: true });
    expect(handles[0]?.dismiss).toHaveBeenCalledOnce();
  });
});
