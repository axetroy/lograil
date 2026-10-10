import type { LogLevelName } from '../types.js';

/**
 * Map a lograil level name to the conventional severity used by OS-native
 * sinks. `trace` has no syslog equivalent, so it folds into `debug`.
 */
export function levelToSyslogPriority(levelName: LogLevelName): number {
  switch (levelName) {
    case 'trace':
    case 'debug':
      return 7; // LOG_DEBUG
    case 'info':
      return 6; // LOG_INFO
    case 'warn':
      return 4; // LOG_WARNING
    case 'error':
      return 3; // LOG_ERR
    case 'fatal':
      return 2; // LOG_CRIT
    default:
      return 6;
  }
}
