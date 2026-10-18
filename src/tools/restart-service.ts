import { getServiceInfo } from './get-service-info.js';

/** Deterministic simulation only: validates the service, with no process/infrastructure mutation. */
export function restartService(input: { service: string }) {
  const service = getServiceInfo(input);
  return { service: service.name, action: 'restart_service' as const, simulated: true, status: 'SIMULATED' as const };
}
