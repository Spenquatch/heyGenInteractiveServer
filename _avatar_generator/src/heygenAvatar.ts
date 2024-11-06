import axios from 'axios';
import wrtc from 'wrtc';
const { RTCPeerConnection, RTCSessionDescription} = wrtc;
import sdpTransform from 'sdp-transform';
import { config } from './config';
import { Logger } from './lib/logger';
import { MediasoupServer } from './mediasoupServer';

export class HeyGenAvatar {
  private logger: Logger;
  private accessToken: string | null = null;
  private sessionId: string | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private apiKey: string = config.get('heygen.apiKey');
  private pendingTracks: Array<{
    track: MediaStreamTrack;
    mediaSection: sdpTransform.MediaDescription;
  }> = [];

  

  constructor(private mediasoupServer: MediasoupServer) {
    this.logger = new Logger();
  }

  /**
   * Generates an access token using the API key.
   */
  public async generateAccessToken() {
    try {
      this.logger.info('Generating HeyGen access token...');
      const response = await axios.post(
        'https://api.heygen.com/v1/streaming.create_token',
        {},
        {
          headers: {
            'x-api-key': this.apiKey,
            'accept': 'application/json',
            'content-type': 'application/json',
          },
        }
      );

      if (response.status !== 200) {
        throw new Error(`Failed to generate access token: ${response.statusText}`);
      }

      this.accessToken = response.data.data.token;
      this.logger.info('Access token:', this.accessToken);
      this.logger.info('Access token generated successfully.');
    } catch (error) {
      this.logger.error(`Error generating access token: ${(error as Error).message}`);
      throw error;
    }
  }


  /**
   * Creates a new streaming session with HeyGen.
   */
  public async createNewSession() {
    try {
      if (!this.accessToken) {
        await this.generateAccessToken();
      }
  
      this.logger.info('Creating a new HeyGen streaming session...');
      const response = await axios.post(
        'https://api.heygen.com/v1/streaming.new',
        {
          quality: 'medium',
          avatar_id: 'ef08039a41354ed5a20565db899373f3',
          voice: {
            rate: 1.0,
          },
          video_encoding: 'vp8',
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'accept': 'application/json',
            'content-type': 'application/json',
          },
        }
      );
  
      if (response.status !== 200) {
        throw new Error(`Failed to create new session: ${response.statusText}`);
      }
  
      const data = response.data.data;
      this.sessionId = data.session_id;
      const offerSdp = data.sdp.sdp;
      const iceServers = data.ice_servers2;
  
      // Add debug logging
      // this.logger.info('Received ICE servers:', iceServers);
      // this.logger.info('Received SDP offer:', offerSdp);
      // this.logger.info('SDP type:', data.sdp.type);

      // Verify ICE server structure
      if (!Array.isArray(iceServers) || !iceServers.length) {
          throw new Error('Invalid or missing ICE servers configuration');
        }

      this.logger.info(`Session created with ID: ${this.sessionId}`);
      await this.setupPeerConnection(offerSdp, iceServers);

    } catch (error) {
      this.logger.error(`Error creating new session: ${(error as Error).message}`);
      throw error;
    }
  }
  
  private async setupPeerConnection(offerSdp: string, iceServers: RTCIceServer[]) {
    try {
        this.logger.info('Setting up WebRTC peer connection with HeyGen...');
        const sdp = sdpTransform.parse(offerSdp);
        this.mediasoupServer.setRemoteSdp(sdp);
        
        // Create peer connection with jitter buffer config
        this.peerConnection = new RTCPeerConnection({
            iceServers,
            // Add jitter buffer configuration
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-bundle',
            // @ts-ignore - these are experimental but supported
            jitterBufferMinimumDelay: 0.2,  // 200ms
            jitterBufferMaximumDelay: 1.0,  // 1000ms
            jitterBufferPreferredDelay: 0.5  // 500ms
        }) as RTCPeerConnection;

        // Connection state monitoring
        this.peerConnection.onconnectionstatechange = async () => {
            const state = this.peerConnection?.connectionState;
            this.logger.info('Connection state changed:', state);
            
            switch (state) {
                case 'connected':
                    this.logger.info('Connection established - starting RTP monitoring');
                    // Start periodic RTP stats monitoring
                    setInterval(() => this.monitorRtpStats(), 5000);
                    break;
                case 'disconnected':
                case 'failed':
                    this.logger.error(`Connection ${state} - check ICE candidates and network`);
                    break;
                case 'closed':
                    this.logger.info('Connection closed');
                    break;
            }
        };

        // Add ICE connection state monitoring
        this.peerConnection.oniceconnectionstatechange = () => {
            this.logger.info('ICE connection state:', this.peerConnection?.iceConnectionState);
        };

        // Add ICE gathering state monitoring
        this.peerConnection.onicegatheringstatechange = () => {
            this.logger.info('ICE gathering state:', this.peerConnection?.iceGatheringState);
        };

        // Data channel handling
        this.peerConnection.ondatachannel = (event) => {
          const channel = event.channel;
          this.logger.info('Data channel received:', {
              label: channel.label,
              id: channel.id,
              state: channel.readyState
          });
          
          channel.onmessage = (msg) => {
              this.logger.info('Data channel message:', {
                  type: msg.type,
                  data: msg.data,
                  timestamp: new Date().toISOString()
              });
          };
          
          channel.onopen = () => {
              this.logger.info('Data channel opened:', channel.label);
              // Send a test message
              channel.send('Test message from client');
          };
          
          channel.onerror = (error) => {
              this.logger.error('Data channel error:', error);
          };
      };


        // ICE candidate handling
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendIceCandidate(event.candidate);
            }
        };

        // Track handling with detailed capabilities
        this.peerConnection.ontrack = (event) => {
            this.logger.info('Track received:', {
                kind: event.track.kind,
                id: event.track.id,
                label: event.track.label,
                readyState: event.track.readyState,
                muted: event.track.muted,
                enabled: event.track.enabled
            });

            // Configure jitter buffer for the track
            if (event.track.kind === 'audio' || event.track.kind === 'video') {
                const receiver = this.peerConnection?.getReceivers()
                    .find(r => r.track.id === event.track.id);
                
                if (receiver) {
                    // @ts-ignore - this is a non-standard but supported property
                    receiver.jitterBufferDelay = 500; // 500ms
                    // @ts-ignore
                    receiver.playoutDelayHint = 500; // 500ms
                }

                try {
                    // Single call to receiveTrack
                    this.mediasoupServer.receiveTrack(event.track);
                } catch (error) {
                    this.logger.error(`Failed to handle track: ${error}`);
                }
            }

            // Monitor track stats
            setInterval(async () => {
                if (event.track.readyState === 'live') {
                    const stats = await this.peerConnection?.getStats(event.track);
                    stats?.forEach(report => {
                        if (report.type === 'inbound-rtp') {
                            this.logger.info(`${event.track.kind} track stats:`, {
                                packetsReceived: report.packetsReceived,
                                bytesReceived: report.bytesReceived,
                                frameRate: report.framesPerSecond
                            });
                        }
                    });
                }
            }, 5000);

            event.track.onmute = () => this.logger.warn('Track muted:', event.track.id);
            event.track.onunmute = () => this.logger.info('Track unmuted:', event.track.id);
            event.track.onended = () => this.logger.warn('Track ended:', event.track.id);
        };

        // SDP negotiation
        await this.peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: 'offer',
                sdp: offerSdp,
            })
        );

        const answer = await this.peerConnection.createAnswer();
        this.logger.info('Answer:', answer);
        await this.peerConnection.setLocalDescription(answer);
        this.logger.info('Local Description:', this.peerConnection.localDescription);
        await this.startSession(answer.sdp || '');
        this.logger.info('WebRTC peer connection established with HeyGen.');

    } catch (error) {
        this.logger.error(`Error setting up peer connection: ${(error as Error).message}`);
        throw error;
    }
}

   /**
   * Starts the session with HeyGen by sending the SDP answer.
   * @param answerSdp The SDP answer to send to HeyGen.
   */
   private async startSession(answerSdp: string) {
    try {
      this.logger.info('Starting HeyGen session with SDP answer...');
      const response = await axios.post(
        'https://api.heygen.com/v1/streaming.start',
        {
          session_id: this.sessionId,
          sdp: {
            type: 'answer',
            sdp: answerSdp,
          },
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'accept': 'application/json',
            'content-type': 'application/json',
          },
        }
      );

      if (response.status !== 200) {
        throw new Error(`Failed to start session: ${response.statusText}`);
      }

      this.logger.info('HeyGen session started successfully.');
    } catch (error) {
      this.logger.error(`Error starting session: ${(error as Error).message}`);
      throw error;
    }
  }


  private async processPendingTracks() {
    for (const { track, mediaSection } of this.pendingTracks) {
      const rtpParameters = this.mediasoupServer.getRtpParameters(mediaSection);
      await this.mediasoupServer.createProducer(track, rtpParameters);
    }
    // Clear the queue after processing
    this.pendingTracks = [];
  }


    /**
       * Terminates the current HeyGen streaming session.
       */
    public async terminateSession() {
      try {
        if (this.sessionId) {
          this.logger.info('Terminating HeyGen session...');
          await axios.post(
            'https://api.heygen.com/v1/streaming.stop',
            {
              session_id: this.sessionId,
            },
            {
              headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'accept': 'application/json',
                'content-type': 'application/json',
              },
            }
          );
          this.sessionId = null;
          this.logger.info('HeyGen session terminated.');
        }

        if (this.peerConnection) {
          this.peerConnection.close();
          this.peerConnection = null;
          this.logger.info('Peer connection closed.');
        }
      } catch (error) {
        this.logger.error(`Error terminating session: ${(error as Error).message}`);
        // Handle the error as needed
      }
    }  

    /**
   * Sends an ICE candidate to HeyGen.
   * @param candidate The ICE candidate to send.
   */
    private async sendIceCandidate(candidate: RTCIceCandidate) {
      try {
        this.logger.info('Sending ICE candidate to HeyGen...');
    
        // Manually construct the candidate object
        const candidateObj = {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        };
    
        await axios.post(
          'https://api.heygen.com/v1/streaming.ice',
          {
            session_id: this.sessionId,
            candidate: candidateObj,
          },
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'accept': 'application/json',
              'content-type': 'application/json',
            },
          }
        );
      } catch (error) {
        this.logger.error(`Error sending ICE candidate: ${(error as Error).message}`);
        // Handle the error as needed
      }
    }
  /**
   * Sends a speak command to the HeyGen avatar.
   * @param text The text for the avatar to speak.
   */
  public async speak(text: string) {
    try {
      this.logger.info(`Sending speak command: "${text}"`);
      await axios.post(
        'https://api.heygen.com/v1/streaming.task',
        {
          session_id: this.sessionId,
          text: text,
          task_mode: 'async',
          task_type: 'repeat', // or 'chat' depending on usage
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'accept': 'application/json',
            'content-type': 'application/json',
          },
        }
      );
    } catch (error) {
      this.logger.error(`Error sending speak command: ${(error as Error).message}`);
      // Handle the error as needed
    }
  }    

  private async monitorRtpStats() {
    if (!this.peerConnection) {
        this.logger.warn('No peer connection available for stats monitoring');
        return;
    }

    try {
        const stats = await this.peerConnection.getStats();
        let hasIncomingPackets = false;

        stats.forEach(report => {
            switch(report.type) {
                case 'inbound-rtp':
                    hasIncomingPackets = true;
                    this.logger.info('Inbound RTP Stats:', {
                        kind: report.kind,
                        packetsReceived: report.packetsReceived,
                        bytesReceived: report.bytesReceived,
                        packetsLost: report.packetsLost,
                        jitter: report.jitter
                    });
                    break;
                    
                case 'track':
                    if (report.kind === 'video') {
                        this.logger.info('Video Track Stats:', {
                            frameWidth: report.frameWidth,
                            frameHeight: report.frameHeight,
                            framesPerSecond: report.framesPerSecond,
                            framesReceived: report.framesReceived,
                            framesDropped: report.framesDropped
                        });
                    }
                    break;

                case 'codec':
                    this.logger.debug('Codec Stats:', {
                        payloadType: report.payloadType,
                        codecType: report.codecType,
                        mimeType: report.mimeType,
                        clockRate: report.clockRate,
                        channels: report.channels
                    });
                    break;
            }
        });

        if (!hasIncomingPackets) {
            this.logger.warn('No incoming RTP packets detected');
        }
    } catch (error) {
        this.logger.error('Error getting RTP stats:', error);
    }
}

  async startStream(): Promise<void> {
    await this.createNewSession();
  }

}
