import { env } from './config.ts';
import { Telemetry } from './telemetry.ts';

/**
 * The live, process-wide telemetry instance shared by the dispatcher (which
 * records swaps, errors, and in-flight state) and the HTTP layer (which
 * records per-request token/timing data and serves `/status`, `/usage`,
 * `/metrics`).
 *
 * Kept in its own module so `telemetry.ts` stays env-free and unit-testable —
 * importing the class there must not drag in config loading.
 */
export const telemetry = new Telemetry({ usageMax: env.USAGE_RECORDS_MAX });
