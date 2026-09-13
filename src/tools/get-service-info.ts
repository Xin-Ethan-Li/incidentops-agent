import type { ServiceInfo } from '../domain/service-info.js';
import { services } from '../fixtures/index.js';
import { ToolError } from './tool-error.js';
import { validateService } from './validate-input.js';

export interface GetServiceInfoInput { service: string }

/** get_service_info: return metadata only; unknown services are errors. */
export function getServiceInfo(input: GetServiceInfoInput): ServiceInfo {
  validateService(input?.service);
  const service = services.find(item => item.name === input.service);
  if (!service) throw new ToolError('SERVICE_NOT_FOUND', `Unknown service: ${input.service}`);
  return { ...service, dependencies: [...service.dependencies] };
}
