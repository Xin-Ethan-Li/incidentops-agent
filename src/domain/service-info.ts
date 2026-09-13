export interface ServiceInfo {
  name: string;
  version: string;
  dependencies: string[]; // Dependency identifiers, including external systems.
  lastDeploymentAt: string;
}
