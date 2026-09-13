export interface LogEntry {
  id: string;
  timestamp: string;
  service: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
