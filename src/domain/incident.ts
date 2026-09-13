/** Synthetic investigation request; contains symptoms, never the expected answer. */
export interface IncidentCase {
  id: string;
  title: string;
  service: string;
  description: string;
  timeWindow: { start: string; end: string }; // Fixed ISO 8601 UTC timestamps.
}
