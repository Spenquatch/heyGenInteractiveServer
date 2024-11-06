// src/main.ts
import { MediasoupServer } from './mediasoupServer';
import { Logger } from './lib/logger';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const logger = new Logger();
const mediasoupServer = new MediasoupServer();

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Command menu
function showMenu() {
    console.log('\n=== HeyGen Avatar Control ===');
    console.log('1. Start HeyGen Connection');
    console.log('2. Send Text to Avatar');
    console.log('3. Stop Connection');
    console.log('q. Quit');
    console.log('=========================\n');
    rl.question('Select an option: ', handleCommand);
}

// Handle user commands
async function handleCommand(cmd: string) {
    try {
        switch (cmd.toLowerCase()) {
            case '1':
                logger.info('Starting HeyGen connection...');
                await mediasoupServer.getHeyGenAvatar().startStream();
                break;
            
            case '2':
                rl.question('Enter text for avatar: ', async (text) => {
                    await mediasoupServer.getHeyGenAvatar().speak(text);
                    showMenu();
                });
                return; // Don't show menu yet - wait for text input
            
            case '3':
                logger.info('Stopping connection...');
                await mediasoupServer.getHeyGenAvatar().terminateSession();
                break;
            
            case 'q':
                logger.info('Shutting down...');
                await mediasoupServer.getHeyGenAvatar().terminateSession();
                rl.close();
                process.exit(0);
                return;
            
            default:
                logger.warn('Invalid command');
        }
    } catch (error) {
        logger.error('Command error:', error);
    }
    showMenu();
}

// Initialize server and start menu
mediasoupServer
    .init()
    .then(() => {
        logger.info('Mediasoup server initialized');
        logger.info('Express server listening on port 3000');
        showMenu();
    })
    .catch((error) => {
        logger.error('Failed to initialize Mediasoup server:', error);
        process.exit(1);
    });

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await mediasoupServer.getHeyGenAvatar().terminateSession();
    rl.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    await mediasoupServer.getHeyGenAvatar().terminateSession();
    rl.close();
    process.exit(0);
});
