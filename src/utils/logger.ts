import { pino } from 'pino';
import type { Logger, TransportTargetOptions } from 'pino';
import type { LoggingConfig } from '../config/types.js';

/**
 * Create a configured pino logger instance
 */
export function createLogger(config: LoggingConfig): Logger {
  const targets: TransportTargetOptions[] = [];
  
  // Console transport
  if (config.console) {
    targets.push({
      target: 'pino-pretty',
      level: config.level,
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });
  }
  
  // File transport
  if (config.filePath) {
    targets.push({
      target: 'pino/file',
      level: config.level,
      options: {
        destination: config.filePath,
        mkdir: true,
      },
    });
  }
  
  // If no targets, use stdout
  if (targets.length === 0) {
    return pino({ level: config.level });
  }
  
  return pino({
    level: config.level,
    transport: {
      targets,
    },
  });
}

/**
 * Create a child logger with module context
 */
export function createModuleLogger(parent: Logger, module: string): Logger {
  return parent.child({ module });
}

/**
 * Default console-only logger for bootstrap
 */
export const bootstrapLogger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});
