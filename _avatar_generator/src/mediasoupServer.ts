// src/mediasoupServer.ts
import * as mediasoup from "mediasoup";
import type {
  Worker,
  Router,
  WebRtcTransport,
  WebRtcTransportOptions,
  Producer,
  Consumer,
  PlainTransport,
  RtpParameters,
} from "mediasoup/node/lib/types";
import express from "express";
import { ChildProcess, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { Server as HTTPServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import sdpTransform from 'sdp-transform';
import { config } from "./config";
import { Logger } from "./lib/logger";
import { Socket } from "socket.io";
import { HeyGenAvatar } from "./heygenAvatar";
import * as fs from 'fs';


// At the top of the file with other imports
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class MediasoupServer {
  private logger: Logger;
  private worker: Worker | null = null;
  private router: Router | null = null;
  private incomingTransport: WebRtcTransport | null = null;
  private producers: Map<string, Producer>;
  private consumers: Map<string, Consumer>;
  private app: express.Express;
  private httpsServer: HTTPServer;
  private io: SocketIOServer;
  private heyGenAvatar: HeyGenAvatar;
  private transports: Map<string, WebRtcTransport> = new Map();
  private remoteSdp: sdpTransform.SessionDescription | null = null;
  private ffmpegProcesses: Map<string, ChildProcess> = new Map();
  private usedPorts: Set<number> = new Set();


  constructor() {
    this.logger = new Logger();
    this.producers = new Map();
    this.consumers = new Map();
    this.heyGenAvatar = new HeyGenAvatar(this);
    this.app = express();
    this.httpsServer = new HTTPServer(this.app);
    this.io = new SocketIOServer(this.httpsServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      allowEIO3: true,
      transports: ["websocket", "polling"],
    });
  }


  public setRemoteSdp(sdp: sdpTransform.SessionDescription) {
    this.remoteSdp = sdp;
  }
  public getHeyGenAvatar(): HeyGenAvatar {
    return this.heyGenAvatar;
  }

  public addTransport(transport: WebRtcTransport) {
    this.transports.set(transport.id, transport);
  }

  public getTransportById(id: string): WebRtcTransport | undefined {
    return this.transports.get(id);
  }

  public getIncomingTransport(): WebRtcTransport | null {
    return this.incomingTransport;
  }

  public getRtpParameters(mediaSection: sdpTransform.MediaDescription): mediasoup.types.RtpParameters {
    return this.extractRtpParameters(mediaSection);
  }


  /**
   * Initializes the Mediasoup server.
   */
  public async init() {
    await this.runMediasoupWorker();
    await this.createRouter();
    await this.createIncomingTransport();
    this.setupSocketIO();
    // await this.heyGenAvatar.createNewSession();
    // this.io.emit('mediasoupReady');
    this.setupExpressRoutes();
    this.httpsServer.listen(config.get('server.port'), () => {
      this.logger.info(`Express server listening on port ${config.get('server.port')}`);
    });
  }

  /**
   * Runs the Mediasoup worker.
   */
  private async runMediasoupWorker() {
    this.logger.info("Initializing Mediasoup Worker...");
    this.worker = await mediasoup.createWorker({
      logLevel: config.get('mediasoup.workerSettings.logLevel') as any,
      logTags: config.get('mediasoup.workerSettings.logTags') as any,
      rtcMinPort: config.get('mediasoup.workerSettings.rtcMinPort'),
      rtcMaxPort: config.get('mediasoup.workerSettings.rtcMaxPort'),
      dtlsCertificateFile: config.get('mediasoup.workerSettings.dtlsCertificateFile'),
      dtlsPrivateKeyFile: config.get('mediasoup.workerSettings.dtlsPrivateKeyFile'),
      disableLiburing: config.get('mediasoup.workerSettings.disableLiburing'),
    });

    this.worker.on("died", () => {
      this.logger.error(
        `Mediasoup Worker died, exiting in 2 seconds... [pid:${this.worker?.pid}]`
      );
      setTimeout(() => process.exit(1), 2000);
    });

    this.logger.info(`Mediasoup Worker initialized [pid:${this.worker.pid}]`);
  }

  /**
   * Creates a Mediasoup router.
   */
  private async createRouter() {
    if (!this.worker) {
      throw new Error("Mediasoup Worker not initialized");
    }

    this.router = await this.worker.createRouter({
      mediaCodecs: config.get('mediasoup.router.mediaCodecs') as mediasoup.types.RtpCodecCapability[],
    });

    this.logger.info("Mediasoup Router created");
  }

  /**
   * Creates an incoming transport to receive streams from HeyGen.
   */
  private async createIncomingTransport() {
    if (!this.router) {
        throw new Error("Mediasoup Router not initialized");
    }

    const transportOptions: WebRtcTransportOptions = {
        listenIps: [
            {
                ip: '0.0.0.0',
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1'
            }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true
    };

    this.incomingTransport = await this.router.createWebRtcTransport(transportOptions);

    // State monitoring
    this.incomingTransport.observer.on('close', () => {
        this.logger.info('Transport closed');
    });

    this.incomingTransport.observer.on('dtlsstatechange', (dtlsState) => {
        this.logger.info('Transport DTLS state:', dtlsState);
    });

    this.incomingTransport.observer.on('icestatechange', (iceState) => {
        this.logger.info('Transport ICE state:', iceState);
    });

    this.incomingTransport.observer.on('sctpstatechange', (sctpState) => {
        this.logger.info('Transport SCTP state:', sctpState);
    });

    // Log initial transport info
    // this.logger.debug('WebRTC Transport created:', {
    //     id: this.incomingTransport.id,
    //     iceParameters: this.incomingTransport.iceParameters,
    //     iceCandidates: this.incomingTransport.iceCandidates,
    //     dtlsParameters: this.incomingTransport.dtlsParameters,
    //     iceState: this.incomingTransport.iceState,
    //     dtlsState: this.incomingTransport.dtlsState
    // });

    return this.incomingTransport;
}



  /**
   * Sets up Express routes for serving the client and handling API requests.
   */
  private setupExpressRoutes() {

      // Add CSP middleware first
    this.app.use((req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "media-src 'self' blob: mediastream:; " +
        "connect-src 'self' ws: wss:; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "worker-src blob:; " +
        "child-src blob:"
      );
      next();
    });

    // Endpoint to handle speak requests from the client
    this.app.post('/speak', express.json(), async (req, res) => {
      const { text } = req.body;
      if (!text) {
        res.status(400).send('Text is required');
        return;
      }

      try {
        await this.heyGenAvatar.speak(text);
        this.logger.info(`Sending speak command: "${text}"`);
        res.status(200).send('Speak command sent');
      } catch (error) {
        this.logger.error(
          `Error sending speak command: ${(error as Error).message}`
        );
        res.status(500).send('Failed to send speak command');
      }
    });

    this.logger.info('Express routes setup complete');
  }

  /**
   * Adds a producer to the producers map and notifies clients.
   * @param producer The producer to add.
   */
  public addProducer(producer: Producer) {
    this.producers.set(producer.id, producer);
    this.logger.info(`Producer added [id:${producer.id}, kind:${producer.kind}]`);

    // Notify all connected clients about the new producer
    this.io.emit("newProducer", producer.id);
    this.logger.info(`Emitted newProducer event for producer ID: ${producer.id}`);
  }

  public async createProducer(track: MediaStreamTrack, rtpParameters: mediasoup.types.RtpParameters) {
    if (!this.incomingTransport) {
      throw new Error('Incoming transport not initialized');
    }

    this.logger.info('Creating producer for track:', {
      kind: track.kind,
      id: track.id,
      rtpParameters
    });

    const producer = await this.incomingTransport!.produce({
      kind: track.kind as mediasoup.types.MediaKind,
      rtpParameters,
      appData: {},
      paused: false,
      keyFrameRequestDelay: 0
    });
  
    // Enable RTP trace events
    await producer.enableTraceEvent(['rtp', 'keyframe', 'nack', 'pli', 'fir']);
  
    // Monitor RTP streams
    producer.on('trace', (trace) => {
      if (trace.type === 'rtp') {
        this.logger.info(`Producer ${producer.id} received RTP packet:`, {
          payloadType: trace.info.payloadType,
          sequenceNumber: trace.info.sequenceNumber,
          timestamp: trace.info.timestamp,
          size: trace.info.size
        });
      }
    });  
    // Monitor producer score
    producer.observer.on('score', (score) => {
      this.logger.info(`Producer ${producer.id} score:`, score);
    });
  
    setInterval(async () => {
      const stats = await producer.getStats();
      this.logger.info(`Producer ${producer.id} stats:`, stats);
    }, 5000);


    // Add detailed transport monitoring
    this.incomingTransport.on('dtlsstatechange', (dtlsState) => {
        this.logger.info(`Incoming transport DTLS state changed to ${dtlsState}`);
    });

    this.incomingTransport.observer.on('close', () => {
        this.logger.info('Incoming transport closed');
    });

    // Log transport details
    // const transportDump = await this.incomingTransport.dump();
    // this.logger.debug('Incoming transport dump:', transportDump);


    this.addProducer(producer);
    this.logger.info(`Producer created successfully [id:${producer.id}, kind:${producer.kind}]`);

    return producer;
  }

  public async receiveTrack(track: MediaStreamTrack) {
    if (!this.router || !this.incomingTransport || !this.remoteSdp) {
        throw new Error('Required components not initialized');
    }

    try {
        // Find the matching media section for the track
        const mediaSection = this.remoteSdp.media.find(m => m.type === track.kind);
        if (!mediaSection) {
            throw new Error(`No media section found for ${track.kind} track`);
        }

        // 1. Create producer
        const producer = await this.createProducer(track, this.extractRtpParameters(mediaSection));
        
        // 2. Create plain transport
        const plainTransport = await this.createPlainTransport();
        const { tuple, rtcpTuple } = plainTransport;
        
        // 3. Create FFmpeg-compatible RTP capabilities
        const rtpCapabilities = this.createFFmpegRtpCapabilities();

        // 4. Create consumer
        const consumer = await plainTransport.consume({
            producerId: producer.id,
            rtpCapabilities,
            paused: true
        });

        // 5. Get consumer's RTP parameters
        const { rtpParameters } = consumer;
        this.logger.info('Consumer RTP parameters:', {
            ssrc: rtpParameters.encodings?.[0].ssrc,
            codec: rtpParameters.codecs[0]
        });

        // 6. Create FFmpeg command with proper RTP parameters
        const sdp = this.createSDPForFFmpeg({
            rtpParameters,
            localIp: tuple.localIp,
            localPort: tuple.localPort
        });

        const sdpPath = path.join(__dirname, '../recordings', `${consumer.id}.sdp`);
        await fs.promises.writeFile(sdpPath, sdp);

        // 7. Start FFmpeg with correct parameters
        const ffmpegArgs = [
            '-protocol_whitelist', 'file,rtp,udp',
            '-i', sdpPath,
            '-fflags', '+genpts',
        ];

        if (track.kind === 'video') {
            ffmpegArgs.push(
                '-c:v', 'copy',
                '-an'
            );
        } else {
            ffmpegArgs.push(
                '-c:a', 'copy',
                '-vn'
            );
        }

        const outputPath = path.join(__dirname, '../recordings', `${consumer.id}.webm`);
        ffmpegArgs.push('-y', outputPath);

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        this.ffmpegProcesses.set(consumer.id, ffmpeg);

        ffmpeg.stderr.on('data', (data) => {
            this.logger.debug('FFmpeg:', data.toString());
        });

        // 8. Wait for FFmpeg to start
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 9. Connect transport
        await plainTransport.connect({
            ip: tuple.localIp,
            port: tuple.localPort,
            rtcpPort: rtcpTuple?.localPort
        });

        // 10. Resume consumer
        await consumer.resume();

        // Add monitoring...
        return { plainTransport, consumer };

    } catch (error) {
        this.logger.error(`Error in receiveTrack: ${error}`);
        throw error;
    }
}


  private extractRtpParameters(mediaSection: sdpTransform.MediaDescription): mediasoup.types.RtpParameters {
    const rtpParameters: mediasoup.types.RtpParameters = {
      mid: mediaSection.mid?.toString(),
      codecs: [],
      headerExtensions: [],
      encodings: [],
      rtcp: {
        cname: mediaSection.ssrcs?.find(s => s.attribute === 'cname')?.value || '',
      },
    };

    if (!mediaSection.rtp || !mediaSection.rtp.length) {
      throw new Error(`No RTP parameters found for ${mediaSection.rtp[0].codec} track`);
    }

    // Add codecs
    for (const codec of mediaSection.rtp) {
      const fmtp = mediaSection.fmtp?.find((f) => f.payload === codec.payload);
      const parameters = fmtp ? sdpTransform.parseParams(fmtp.config) : {};

      rtpParameters.codecs.push({
        mimeType: `${this.remoteSdp?.media.find(m => m === mediaSection)?.type}/${codec.codec}`,
        payloadType: codec.payload,
        clockRate: codec.rate || 0,
        channels: codec.encoding || 1,
        parameters,
        rtcpFeedback: mediaSection.rtcpFb
          ?.filter((fb) => fb.payload === codec.payload)
          .map((fb) => ({
            type: fb.type,
            parameter: fb.subtype || '',
          })) || [],
      });
    }

    // Add header extensions
    rtpParameters.headerExtensions = (mediaSection.ext || []).map((ext) => ({
      uri: ext.uri as mediasoup.types.RtpHeaderExtensionUri,
      id: ext.value,
      encrypt: false,
      parameters: {},
    }));

    // Add encodings
    rtpParameters.encodings = [
      {
        ssrc: mediaSection.ssrcs?.[0]?.id ? Number(mediaSection.ssrcs[0].id) : undefined,
      },
    ];

    return rtpParameters;
  }
  private setupSocketIO() {
    this.io.on('connection', (socket: Socket) => {
      this.logger.info(`Client connected: ${socket.id}`);

      socket.on('startStream', async () => {
        this.logger.info('Client requested stream start');
        await this.heyGenAvatar.createNewSession();
        socket.emit('streamReady');
      });

      // Handle getRouterRtpCapabilities
      socket.on('getRouterRtpCapabilities', (callback) => {
        callback(this.router?.rtpCapabilities);
      });
      

      // Send router RTP capabilities to the client
      socket.emit('routerRtpCapabilities', this.router?.rtpCapabilities);
  
      // socket.on('createWebRtcTransport', async (data, callback) => {
      //   try {
      //     if (!this.router) throw new Error('Router not initialized');
  
      //     const transportOptions: WebRtcTransportOptions = {
      //       listenIps: config.get('mediasoup.webRtcTransport.listenIps').map((ip: { ip: string; announcedIp: string | null }) => ({
      //         ip: ip.ip,
      //         announcedIp: ip.announcedIp || undefined,
      //       })),
      //       enableUdp: config.get('mediasoup.webRtcTransport.enableUdp'),
      //       enableTcp: config.get('mediasoup.webRtcTransport.enableTcp'),
      //       preferUdp: config.get('mediasoup.webRtcTransport.preferUdp'),
      //       initialAvailableOutgoingBitrate:
      //         config.get('mediasoup.webRtcTransport.initialAvailableOutgoingBitrate'),
      //     };  
      //     const transport = await this.router.createWebRtcTransport(transportOptions);
  
      //     this.logger.info(`Created WebRtcTransport [id:${transport.id}] for client`);
  
      //     transport.on('dtlsstatechange', (dtlsState) => {
      //       if (dtlsState === 'closed') {
      //         this.logger.info(`Transport closed [id:${transport.id}]`);
      //         transport.close();
      //       }
      //     });
  
      //     transport.on('@close', () => {
      //       this.logger.info(`Transport closed [id:${transport.id}]`);
      //     });
  
      //     this.transports.set(transport.id, transport);
  
      //     callback({
      //       id: transport.id,
      //       iceParameters: transport.iceParameters,
      //       iceCandidates: transport.iceCandidates,
      //       dtlsParameters: transport.dtlsParameters,
      //     });
      //   } catch (error) {
      //     this.logger.error(`Error creating WebRtcTransport: ${(error as Error).message}`);
      //     callback({ error: (error as Error).message });
      //   }
      // });
  
      socket.on('transportConnect', async ({ transportId, dtlsParameters }, callback) => {
        try {
          const transport = this.transports.get(transportId);
          if (!transport) throw new Error(`Transport not found with id: ${transportId}`);
  
          await transport.connect({ dtlsParameters });
  
          callback({ status: 'success' });
        } catch (error) {
          this.logger.error(`Error connecting transport: ${(error as Error).message}`);
          callback({ error: (error as Error).message });
        }
      });
  
      socket.on('consume', async ({ rtpCapabilities, producerId, transportId }, callback) => {
        try {
          if (!this.router) {
            throw new Error('Router not initialized');
          }
          if (!this.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('Cannot consume');
          }
  
          const transport = this.transports.get(transportId);
          if (!transport) throw new Error(`Transport not found with id: ${transportId}`);
  
          const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
          });
  
          this.logger.info(`Consumer created: ${consumer.id}`);
          this.consumers.set(consumer.id, consumer);
  
          consumer.on('transportclose', () => {
            this.consumers.delete(consumer.id);
          });
  
          consumer.on('producerclose', () => {
            this.consumers.delete(consumer.id);
            consumer.close();
          });
  
          callback({
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          });
        } catch (error) {
          this.logger.error(`Error during consume: ${(error as Error).message}`);
          callback({ error: (error as Error).message });
        }
      });
  
      socket.on('consumerResume', async ({ consumerId }, callback) => {
        try {
          const consumer = this.consumers.get(consumerId);
          if (!consumer) throw new Error(`Consumer not found with id: ${consumerId}`);
  
          await consumer.resume();
          callback({ status: 'success' });
        } catch (error) {
          this.logger.error(`Error resuming consumer: ${(error as Error).message}`);
          callback({ error: (error as Error).message });
        }
      });

      // Handle getProducers
      socket.on('getProducers', (callback) => {
        // Send all current producer IDs to the client
        const producerIds = Array.from(this.producers.values()).map(producer => producer.id);
        callback(producerIds);
      });      
  
      socket.on('disconnect', () => {
        this.logger.info(`Client disconnected: ${socket.id}`);
        // Clean up resources if necessary
      });
    });
  }

  private async createPlainTransport(): Promise<PlainTransport> {
    if (!this.router) {
        throw new Error('Router not initialized');
    }

    try {
        const transport = await this.router.createPlainTransport({
            listenIp: {
                ip: '127.0.0.1',
                announcedIp: '127.0.0.1'
            },
            rtcpMux: false,     // Disable RTCP multiplexing to use separate ports
            comedia: false,     // Disable COMEDIA mode since we're explicitly connecting
            enableSctp: false,
            enableSrtp: false
        });

        this.logger.info('Plain transport created:', {
            id: transport.id,
            tuple: transport.tuple,
            rtcpTuple: transport.rtcpTuple
        });

        return transport;
    } catch (error) {
        this.logger.error('Error creating plain transport:', error);
        throw error;
    }
}

private async setupFFmpegConsumer(producerId: string) {
    if (!this.router) {
        throw new Error('Router not initialized');
    }

    const producer = this.producers.get(producerId);
    if (!producer) {
        throw new Error(`Producer not found: ${producerId}`);
    }

    // Create transport with random port
    const transport = await this.createPlainTransport();
    
    // Create FFmpeg-compatible RTP capabilities
    const ffmpegRtpCapabilities = {
        codecs: [
            {
                kind: producer.kind,
                mimeType: producer.rtpParameters.codecs[0].mimeType,
                preferredPayloadType: producer.rtpParameters.codecs[0].payloadType,
                clockRate: producer.rtpParameters.codecs[0].clockRate,
                channels: producer.rtpParameters.codecs[0].channels,
                parameters: producer.rtpParameters.codecs[0].parameters,
                rtcpFeedback: []
            }
        ],
        headerExtensions: []
    };

    // Create consumer with FFmpeg-compatible capabilities
    const consumer = await transport.consume({
        producerId,
        rtpCapabilities: ffmpegRtpCapabilities,
        paused: true
    });

    this.logger.info('Producer RTP Parameters:', producer.rtpParameters);
    this.logger.info('Consumer RTP Parameters:', consumer.rtpParameters);
    this.logger.info('Transport Tuple:', transport.tuple);

    // Resume the consumer
    await consumer.resume();
    this.logger.info('Consumer resumed');

    return {
        consumer,
        transport,
        rtpParameters: consumer.rtpParameters,
        remoteRtpPort: transport.tuple.localPort
    };
}

private async startFFmpegRecording(ffmpegEndpoint: {
    consumer: Consumer,
    transport: PlainTransport,
    rtpParameters: RtpParameters,
    remoteRtpPort: number
}) {
    const { consumer, transport, rtpParameters } = ffmpegEndpoint;
    const port = transport.tuple.localPort;
    const RECORDING_DURATION = 15;
    
    const recordingsDir = path.resolve(__dirname, '../recordings');
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    
    const outputPath = path.resolve(recordingsDir, `${consumer.id}.webm`);
    
    // Create SDP file for FFmpeg
    const sdpContent = this.createSDPForFFmpeg({
        rtpParameters,
        localIp: '127.0.0.1',
        localPort: port
    });
    
    const sdpPath = path.resolve(recordingsDir, `${consumer.id}.sdp`);
    await fs.promises.writeFile(sdpPath, sdpContent);
    
    this.logger.info('Created SDP file:', sdpContent);

    // Build FFmpeg command using SDP file
    const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'debug',
        '-protocol_whitelist', 'file,rtp,udp',
        '-i', sdpPath,
        '-fflags', '+genpts',
        '-reset_timestamps', '1'
    ];

    // Add codec-specific arguments
    if (consumer.kind === 'video') {
        ffmpegArgs.push(
            '-c:v', 'copy',
            '-an'  // No audio
        );
    } else {
        ffmpegArgs.push(
            '-c:a', 'copy',
            '-vn'  // No video
        );
    }

    ffmpegArgs.push(
        '-f', 'webm',
        '-t', RECORDING_DURATION.toString(),
        '-y',
        outputPath
    );

    this.logger.info('Starting FFmpeg with command:', 'ffmpeg', ffmpegArgs.join(' '));

    return new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        this.ffmpegProcesses.set(consumer.id, ffmpeg);

        let errorOutput = '';
        let hasReceivedData = false;

        ffmpeg.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('Error')) {
                this.logger.error('FFmpeg error:', message);
                errorOutput += message;
            } else {
                this.logger.debug('FFmpeg output:', message);
                if (message.includes('Input #0')) {
                    hasReceivedData = true;
                }
            }
        });

        ffmpeg.on('error', (error) => {
            this.logger.error('FFmpeg spawn error:', error);
            reject(error);
        });

        ffmpeg.on('close', async (code) => {
            this.ffmpegProcesses.delete(consumer.id);
            
            try {
                const stats = await fs.promises.stat(outputPath);
                this.logger.info(`Recording file stats: ${JSON.stringify(stats)}`);
                
                if (stats.size === 0) {
                    this.logger.error('Output file is empty');
                    reject(new Error('Output file is empty'));
                    return;
                }
            } catch (error) {
                this.logger.error(`Error checking output file: ${error}`);
            }

            if (code === 0 || code === 255) {
                this.logger.info(`Recording completed successfully: ${outputPath}`);
                resolve();
            } else {
                this.logger.error(`FFmpeg process exited with code ${code}`);
                this.logger.error('FFmpeg error output:', errorOutput);
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        // Set a timeout to stop recording
        setTimeout(() => {
            const process = this.ffmpegProcesses.get(consumer.id);
            if (process) {
                process.kill('SIGTERM');
            }
        }, (RECORDING_DURATION + 1) * 1000);

        // Monitor if we're receiving data
        setTimeout(() => {
            if (!hasReceivedData) {
                this.logger.error('No data received after 5 seconds');
                ffmpeg.kill('SIGTERM');
                reject(new Error('No data received'));
            }
        }, 5000);
    });
}

private createSDPForFFmpeg({ rtpParameters, localIp, localPort }: {
    rtpParameters: mediasoup.types.RtpParameters;
    localIp: string;
    localPort: number;
}): string {
    const codec = rtpParameters.codecs[0];
    const encoding = rtpParameters.encodings?.[0];

    const sdp = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=FFmpeg',
        'c=IN IP4 ' + localIp,
        't=0 0',
        `m=${codec.mimeType.split('/')[0]} ${localPort} RTP/AVP ${codec.payloadType}`,
        'a=recvonly',
        `a=rtpmap:${codec.payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}`,
    ];

    if (encoding?.ssrc) {
        sdp.push(`a=ssrc:${encoding.ssrc} cname:ffmpeg`);
    }

    return sdp.join('\n') + '\n';
}

  private getAvailablePort(): number {
    let port = 10000;
    while (this.usedPorts.has(port)) {
        port++;
    }
    this.usedPorts.add(port);
    return port;
}

private createFFmpegRtpCapabilities(): mediasoup.types.RtpCapabilities {
    if (!this.router) {
        throw new Error('Router not initialized');
    }

    const routerCapabilities = this.router.rtpCapabilities;

    // Create subset of router capabilities that FFmpeg supports
    const ffmpegCapabilities: mediasoup.types.RtpCapabilities = {
        codecs: routerCapabilities.codecs!.filter(codec => {
            // FFmpeg supported codecs
            return ['video/VP8', 'video/H264', 'audio/opus'].includes(codec.mimeType);
        }).map(codec => ({
            ...codec,
            // Keep the same preferredPayloadType and parameters
            preferredPayloadType: codec.preferredPayloadType,
            parameters: codec.parameters,
            // FFmpeg doesn't need RTCP feedback
            rtcpFeedback: []
        })),
        headerExtensions: routerCapabilities.headerExtensions!.filter(ext => {
            // Keep essential RTP header extensions
            return [
                'urn:ietf:params:rtp-hdrext:sdes:mid',
                'urn:ietf:params:rtp-hdrext:ssrc-audio-level'
            ].includes(ext.uri);
        })
    };

    this.logger.info('Created FFmpeg RTP capabilities from router:', ffmpegCapabilities);
    return ffmpegCapabilities;
}

// Add a method to clean up FFmpeg processes
private async cleanupFFmpegProcesses() {
    for (const [consumerId, process] of this.ffmpegProcesses) {
        try {
            process.kill('SIGTERM');
            this.logger.info(`Terminated FFmpeg process for consumer ${consumerId}`);
        } catch (error) {
            this.logger.error(`Error terminating FFmpeg process: ${error}`);
        }
    }
    this.ffmpegProcesses.clear();
    this.usedPorts.clear();
}

// Update the shutdown method
public async shutdown() {
    this.logger.info('Shutting down gracefully...');
    await this.cleanupFFmpegProcesses();
    // ... rest of shutdown logic ...
}

}