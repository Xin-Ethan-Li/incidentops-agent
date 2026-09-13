export interface MetricSeries {
  service: string;
  name: string;
  unit: string;
  points: { timestamp: string; value: number }[];
}
