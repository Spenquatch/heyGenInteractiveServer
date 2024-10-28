// src/mediasoupServer.ts
import * as mediasoup from "mediasoup";
import type {
  Worker,
  Router,
  WebRtcTransport,
  WebRtcTransportOptions,
  Producer,
  Consumer,
} from "mediasoup/node/lib/types";
import express from "express";
import { Server as HTTPServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import wrtc from 'wrtc';
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream, MediaStreamTrack } = wrtc;
import sdpTransform, { MediaDescription } from 'sdp-transform';
import { config } from "./config";
import { Logger } from "./lib/logger";
import { Socket } from "socket.io";
import { HeyGenAvatar } from "./heygenAvatar";

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
      listenIps: config.get('mediasoup.webRtcTransport.listenIps').map((ip: { ip: string; announcedIp: string | null }) => ({
        ip: ip.ip,
        announcedIp: ip.announcedIp || undefined,
      })),      
      enableUdp: config.get('mediasoup.webRtcTransport.enableUdp'),
      enableTcp: config.get('mediasoup.webRtcTransport.enableTcp'),
      preferUdp: config.get('mediasoup.webRtcTransport.preferUdp'),
      initialAvailableOutgoingBitrate:
      config.get('mediasoup.webRtcTransport.initialAvailableOutgoingBitrate'),
    };

    this.incomingTransport = await this.router.createWebRtcTransport(
      transportOptions
    );

    if (config.get('mediasoup.webRtcTransport.maxIncomingBitrate')) {
      try {
        await this.incomingTransport.setMaxIncomingBitrate(
          config.get('mediasoup.webRtcTransport.maxIncomingBitrate')
        );
      } catch (error) {
        this.logger.error(
          `Error setting maxIncomingBitrate: ${(error as Error).message}`
        );
      }
    }

    this.logger.info(
      `Incoming WebRtcTransport created [id:${this.incomingTransport.id}]`
    );
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

  public async receiveTrack(track: MediaStreamTrack) {
    if (!this.router) {
      throw new Error('Mediasoup Router not initialized');
    }
  
    if (!this.incomingTransport) {
      throw new Error('Incoming transport not initialized');
    }
  
    if (!this.remoteSdp) {
      throw new Error('Remote SDP not available');
    }
  
    this.logger.info(`Receiving track [kind:${track.kind}] from HeyGen`);
  
    // Extract media information from the remote SDP
    const mediaSections = this.remoteSdp.media.filter(
      (m) => m.type === track.kind
    );
  
    if (mediaSections.length === 0) {
      throw new Error(`No media section found for kind ${track.kind}`);
    }
  
    const media = mediaSections[0];
  
    // Generate RTP parameters
    const rtpParameters: mediasoup.types.RtpParameters = {
      mid: media.mid?.toString(),
      codecs: [],
      headerExtensions: [],
      encodings: [],
      rtcp: {
        cname: media.ssrcs?.find(s => s.attribute === 'cname')?.value || '',
      },
    };
  
    // Verify codecs exist
    if (!media.rtp || !media.rtp.length) {
      throw new Error(`No RTP parameters found for ${track.kind} track`);
    }
  
    // Codecs
    for (const codec of media.rtp) {
      const fmtp = media.fmtp?.find((f) => f.payload === codec.payload);
      const parameters = fmtp ? sdpTransform.parseParams(fmtp.config) : {};
  
      const supportedCodec = {
        mimeType: `${media.type}/${codec.codec}`,
        payloadType: codec.payload,
        clockRate: codec.rate || 0,
        channels: codec.encoding || 1,
        parameters,
        rtcpFeedback: media.rtcpFb
          ?.filter((fb) => fb.payload === codec.payload)
          .map((fb) => ({
            type: fb.type,
            parameter: fb.subtype || '',
          })) || [],
      };
  
      rtpParameters.codecs.push(supportedCodec);
    }
  
    // Verify codec support
    const isCodecSupported = rtpParameters.codecs.some(codec => 
      (track.kind === 'video' && codec.mimeType.toLowerCase() === 'video/vp8') ||
      (track.kind === 'audio' && codec.mimeType.toLowerCase() === 'audio/opus')
    );
  
    if (!isCodecSupported) {
      throw new Error(`Unsupported codec for ${track.kind} track`);
    }
  
    // Encodings
    rtpParameters.encodings = [
      {
        ssrc: media.ssrcs?.[0]?.id ? Number(media.ssrcs[0].id) : undefined,
      },
    ];
  
    // Header Extensions
    rtpParameters.headerExtensions = (media.ext || []).map((ext) => ({
      uri: ext.uri as mediasoup.types.RtpHeaderExtensionUri,
      id: ext.value,
      encrypt: false,
      parameters: {},
    }));
  
    // Produce the track
    const producer = await this.incomingTransport.produce({
      kind: track.kind as mediasoup.types.MediaKind,
      rtpParameters,
      appData: {},
      paused: false,
      keyFrameRequestDelay: 0
    });
  
    this.addProducer(producer);
    this.logger.info(`Track received and producer created successfully for ${track.kind}`);

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
  
      socket.on('createWebRtcTransport', async (data, callback) => {
        try {
          if (!this.router) throw new Error('Router not initialized');
  
          const transportOptions: WebRtcTransportOptions = {
            listenIps: config.get('mediasoup.webRtcTransport.listenIps').map((ip: { ip: string; announcedIp: string | null }) => ({
              ip: ip.ip,
              announcedIp: ip.announcedIp || undefined,
            })),
            enableUdp: config.get('mediasoup.webRtcTransport.enableUdp'),
            enableTcp: config.get('mediasoup.webRtcTransport.enableTcp'),
            preferUdp: config.get('mediasoup.webRtcTransport.preferUdp'),
            initialAvailableOutgoingBitrate:
              config.get('mediasoup.webRtcTransport.initialAvailableOutgoingBitrate'),
          };  
          const transport = await this.router.createWebRtcTransport(transportOptions);
  
          this.logger.info(`Created WebRtcTransport [id:${transport.id}] for client`);
  
          transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed') {
              this.logger.info(`Transport closed [id:${transport.id}]`);
              transport.close();
            }
          });
  
          transport.on('@close', () => {
            this.logger.info(`Transport closed [id:${transport.id}]`);
          });
  
          this.transports.set(transport.id, transport);
  
          callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          });
        } catch (error) {
          this.logger.error(`Error creating WebRtcTransport: ${(error as Error).message}`);
          callback({ error: (error as Error).message });
        }
      });
  
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

}
