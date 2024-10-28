// src/main.ts
import { MediasoupServer } from './mediasoupServer';
import { Logger } from './lib/logger';
import dotenv from 'dotenv';

dotenv.config();

const logger = new Logger();
const mediasoupServer = new MediasoupServer();

mediasoupServer
  .init()
  .then(() => {
    logger.info('Mediasoup server initialized');
  })
  .catch((error) => {
    logger.error('Failed to initialize Mediasoup server:', error);
    process.exit(1);
  });

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  await mediasoupServer.getHeyGenAvatar().terminateSession();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await mediasoupServer.getHeyGenAvatar().terminateSession();
  process.exit(0);
});
