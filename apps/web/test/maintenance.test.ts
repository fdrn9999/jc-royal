import type { MaintenanceDto, ServiceStatusDto } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { maintenanceUnderWay } from '../src/lib/service';

const window: MaintenanceDto = { id: 'm1', startsAt: 1_000, endsAt: 5_000, blockLogin: false, messageKo: null, messageEn: null, active: false };
const status = (maintenance: MaintenanceDto | null): ServiceStatusDto => ({ now: 0, rev: 1, notices: [], refreshAt: null, maintenance });

describe('maintenanceUnderWay', () => {
  it('is the window between its start and its end, by the clock given (the server clock on a page)', () => {
    expect(maintenanceUnderWay(status(window), 999)).toBeNull();
    expect(maintenanceUnderWay(status(window), 1_000)).toBe(window);
    expect(maintenanceUnderWay(status(window), 4_999)).toBe(window);
    expect(maintenanceUnderWay(status(window), 5_000)).toBeNull();
  });

  it('goes by the times, not the `active` flag read when the status was fetched', () => {
    // Fetched before it began (active: false) and still on the page when it starts: the buttons pause on time.
    expect(maintenanceUnderWay(status({ ...window, active: false }), 2_000)).not.toBeNull();
    // Fetched while under way and still on the page after it ends: the buttons come back.
    expect(maintenanceUnderWay(status({ ...window, active: true }), 6_000)).toBeNull();
  });

  it('is null with no status yet or no maintenance', () => {
    expect(maintenanceUnderWay(null, 2_000)).toBeNull();
    expect(maintenanceUnderWay(status(null), 2_000)).toBeNull();
  });
});
