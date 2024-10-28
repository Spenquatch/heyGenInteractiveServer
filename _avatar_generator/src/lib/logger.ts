export class Logger {
    info(message: string, ...args: any[]) {
      console.info(`[INFO] ${message}`, ...args);
    }
  
    warn(message: string, ...args: any[]) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  
    error(message: string, ...args: any[]) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  }
  