import * as mediasoupClient from 'mediasoup-client';
import { Socket, io } from 'socket.io-client';

interface ErrorResponse {
  error: string;
}

// Add these helper functions at the top of your client.ts file
function updateDebugInfo(info: string) {
    const debugElement = document.getElementById('debug-info');
    if (debugElement) {
        const timestamp = new Date().toISOString();
        debugElement.textContent = `${timestamp}: ${info}\n${debugElement.textContent}`;
    }
}

function logTrackInfo(track: MediaStreamTrack) {
    const settings = track.getSettings();
    let trackInfo: any = {
        trackId: track.id,
        kind: track.kind,
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
        settings
    };

    // Only add capabilities if the browser supports it
    try {
        if (typeof track.getCapabilities === 'function') {
            trackInfo = {
                ...trackInfo,
                capabilities: track.getCapabilities()
            };
        }
    } catch (e) {
        console.log('Browser does not support getCapabilities');
    }

    // Only add constraints if the browser supports it
    try {
        if (typeof track.getConstraints === 'function') {
            trackInfo = {
                ...trackInfo,
                constraints: track.getConstraints()
            };
        }
    } catch (e) {
        console.log('Browser does not support getConstraints');
    }
    
    updateDebugInfo(JSON.stringify(trackInfo, null, 2));
}

class HeygenClient {
  private device: mediasoupClient.Device;
  private socket: Socket = io('http://localhost:3000');
  private consumers: Map<string, mediasoupClient.types.Consumer> = new Map();
  private transport: mediasoupClient.types.Transport | null = null;


  private setupPlayButton() {
    const playButton = document.getElementById('play-button');
    if (playButton) {
      playButton.onclick = async () => {
        console.log('Requesting stream start...');
        this.socket.emit('startStream');
      };
    }
  }


  constructor() {
    this.setupStyles();
    this.device = new mediasoupClient.Device();
    
    // Check WebRTC support
    if (!navigator.mediaDevices || !RTCPeerConnection) {
        console.error('WebRTC is not supported in this browser');
        return;
    }

    // Log WebRTC capabilities
    console.log('WebRTC Capabilities:', {
        RTCPeerConnection: !!window.RTCPeerConnection,
        RTCSessionDescription: !!window.RTCSessionDescription,
        RTCIceCandidate: !!window.RTCIceCandidate,
        MediaStream: !!window.MediaStream,
        MediaStreamTrack: !!window.MediaStreamTrack
    });
    
    this.device = new mediasoupClient.Device();
    this.socket = io('http://localhost:3000');
    
    this.setupSocketListeners();
    this.setupPlayButton();
  }

  private setupStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #media-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
            padding: 20px;
            background-color: #f0f0f0;
            min-height: 400px;
            border: 1px solid #ccc;
        }
        
        video {
            background-color: black;
            border: 1px solid #999;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        
        audio {
            width: 100%;
            max-width: 400px;
        }
    `;
    document.head.appendChild(style);
  }

  private setupSocketListeners() {
    this.socket.on('connect', async () => {
      console.log('Connected to server');
      await this.loadDevice();
    });

    this.socket.on('streamReady', () => {
      console.log('Stream is ready');
      const videos = document.getElementsByTagName('video');
      Array.from(videos).forEach(video => {
        video.play()
          .then(() => console.log('Video playback started'))
          .catch(e => console.log('Video playback error:', e));
      });
    });    

    this.socket.on('newProducer', async (producerId: string) => {
      console.log('New producer detected:', producerId);
      await this.consumeStream(producerId);
    });
  }

  private async loadDevice() {
    try {
      const routerRtpCapabilities = await new Promise<mediasoupClient.types.RtpCapabilities>((resolve) => {
        this.socket.emit('getRouterRtpCapabilities', resolve);
      });

      await this.device.load({ routerRtpCapabilities });
      console.log('Device loaded');
      await this.createConsumerTransport();
    } catch (error) {
      console.error('Failed to load device:', error);
    }
  }

  private async createConsumerTransport() {
    const transportOptions = await new Promise<mediasoupClient.types.TransportOptions & ErrorResponse>((resolve) => {
      this.socket.emit('createWebRtcTransport', {}, resolve);
    });

    if (transportOptions.error) {
      console.error('Failed to create transport:', transportOptions.error);
      return;
    }

    // Use the TURN servers from HeyGen's response
    transportOptions.iceServers = [
      {
        urls: ['stun:stun.l.google.com:19302']
      },
      {
        urls: ['stun:global.stun.twilio.com:3478']
      },
      {
        urls: ['turn:global.turn.twilio.com:3478?transport=udp'],
        username: '87d09d5d38717b7b560932cd4c8730eb49b57c6a207063d6ae13f70b564748f1',
        credential: '8hhw76y2Z2wz39cI5xNgbNilynuX5krTsCCc5zZPGrE='
      },
      {
        urls: ['turn:global.turn.twilio.com:3478?transport=tcp'],
        username: '87d09d5d38717b7b560932cd4c8730eb49b57c6a207063d6ae13f70b564748f1',
        credential: '8hhw76y2Z2wz39cI5xNgbNilynuX5krTsCCc5zZPGrE='
      },
      {
        urls: ['turn:global.turn.twilio.com:443?transport=tcp'],
        username: '87d09d5d38717b7b560932cd4c8730eb49b57c6a207063d6ae13f70b564748f1',
        credential: '8hhw76y2Z2wz39cI5xNgbNilynuX5krTsCCc5zZPGrE='
      }
    ];

    this.transport = this.device.createRecvTransport(transportOptions);

    // Add more detailed ICE connection monitoring
    if ((this.transport as any).iceGatheringState !== undefined) {
        console.log('ICE gathering state:', (this.transport as any).iceGatheringState);
        (this.transport as any).oniceconnectionstatechange = () => {
            const state = (this.transport as any).iceConnectionState;
            console.log('ICE connection state changed:', state);
            updateDebugInfo(`ICE connection state: ${state}`);
        };
        (this.transport as any).onicegatheringstatechange = () => {
            const state = (this.transport as any).iceGatheringState;
            console.log('ICE gathering state changed:', state);
            updateDebugInfo(`ICE gathering state: ${state}`);
        };
        (this.transport as any).onconnectionstatechange = () => {
            const state = (this.transport as any).connectionState;
            console.log('Connection state changed:', state);
            updateDebugInfo(`Connection state: ${state}`);
        };
    }

    this.transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        console.log('Transport connect event, dtlsParameters:', dtlsParameters);
        await new Promise<void>((resolve, reject) => {
          this.socket.emit(
            'transportConnect',
            {
              transportId: this.transport?.id,
              dtlsParameters,
            },
            ({ error }: ErrorResponse) => {
              if (error) {
                console.error('Transport connect error:', error);
                reject(error);
              } else {
                console.log('Transport connected successfully');
                resolve();
              }
            }
          );
        });
        callback();
      } catch (error) {
        console.error('Transport connect error:', error);
        errback(error as Error);
      }
    });

    const producerIds = await new Promise<string[]>((resolve) => {
      this.socket.emit('getProducers', resolve);
    });

    for (const producerId of producerIds) {
      await this.consumeStream(producerId);
    }
  }

  private async consumeStream(producerId: string) {
    if (!this.transport) {
      console.error('Transport not available for consuming stream');
      return;
    }

    console.log('Attempting to consume stream for producer:', producerId);

    try {
      const consumerOptions = await new Promise<mediasoupClient.types.ConsumerOptions & ErrorResponse>((resolve) => {
        this.socket.emit(
          'consume',
          {
            rtpCapabilities: this.device.rtpCapabilities,
            producerId,
            transportId: this.transport?.id,
          },
          resolve
        );
      });

      console.log('Consumer options received:', JSON.stringify(consumerOptions, null, 2));

      if (consumerOptions.error) {
        console.error('Failed to consume stream:', consumerOptions.error);
        return;
      }

      const consumer = await this.transport.consume(consumerOptions);
      
      // Add observer for consumer stats
      const statsInterval = setInterval(async () => {
        try {
          const stats = await consumer.getStats();
          const trackStats = Object.values(stats).find(
            stat => stat.type === 'inbound-rtp'
          );
          if (trackStats) {
            console.log('Consumer stats:', {
              bytesReceived: trackStats.bytesReceived,
              packetsReceived: trackStats.packetsReceived,
              frameWidth: trackStats.frameWidth,
              frameHeight: trackStats.frameHeight,
              framesDecoded: trackStats.framesDecoded,
              framesDropped: trackStats.framesDropped,
              framesReceived: trackStats.framesReceived
            });
          }
        } catch (e) {
          console.error('Failed to get consumer stats:', e);
        }
      }, consumer.kind === 'video' ? 500 : 2000); // More frequent for video initially

      // Cleanup interval when consumer closes
      consumer.on('transportclose', () => {
        clearInterval(statsInterval);
      });

      // Log detailed consumer information
      console.log('Consumer created:', {
        id: consumer.id,
        kind: consumer.kind,
        trackId: consumer.track.id,
        paused: consumer.paused,
        producerId: consumer.producerId,
        rtpParameters: consumer.rtpParameters
      });

      this.consumers.set(consumer.id, consumer);

      const mediaElement = this.attachMediaToElement(consumer);
      
      const container = document.getElementById('media-container');
      if (!container) {
        console.error('Media container not found');
        return;
      }

      // Clear existing elements of the same kind
      const existingElements = container.getElementsByTagName(consumer.kind);
      Array.from(existingElements).forEach(element => element.remove());
      
      container.appendChild(mediaElement);

      // Resume the consumer immediately
      await consumer.resume();
      console.log(`Consumer ${consumer.id} resumed`);

      // Notify the server
      await new Promise<void>((resolve, reject) => {
        this.socket.emit(
          'consumerResume',
          { consumerId: consumer.id },
          ({ error }: ErrorResponse) => {
            if (error) {
              console.error('Failed to resume consumer:', error);
              reject(error);
            } else {
              console.log('Consumer resumed successfully:', consumer.id);
              resolve();
            }
          }
        );
      });

    } catch (error) {
      console.error('Error in consumeStream:', error);
    }
  }

  private attachMediaToElement(consumer: mediasoupClient.types.Consumer): HTMLElement {
    console.log(`Attaching ${consumer.kind} track to element`);
    updateDebugInfo(`Attaching ${consumer.kind} track to element`);
    
    const mediaElement = document.createElement(consumer.kind === 'video' ? 'video' : 'audio');
    const stream = new MediaStream([consumer.track]);
    
    mediaElement.id = `media-${consumer.id}`;
    mediaElement.style.border = '2px solid red'; // Visual indicator
    
    if (consumer.kind === 'video') {
        const videoElement = mediaElement as HTMLVideoElement;
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true;
        videoElement.controls = true;
        
        // Add detailed event listeners
        videoElement.addEventListener('loadedmetadata', () => {
            updateDebugInfo(`Video loadedmetadata: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
        });
        
        videoElement.addEventListener('playing', () => {
            updateDebugInfo(`Video playing: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
        });
        
        videoElement.addEventListener('error', () => {
            const error = videoElement.error;
            updateDebugInfo(`Video error: ${error?.code} - ${error?.message}`);
        });
        
        // Monitor track state changes
        consumer.track.onended = () => {
            updateDebugInfo(`Track ended: ${consumer.id}`);
        };
        
        consumer.track.onmute = () => {
            updateDebugInfo(`Track muted: ${consumer.id}`);
        };
        
        consumer.track.onunmute = () => {
            updateDebugInfo(`Track unmuted: ${consumer.id}`);
        };
        
        // Log detailed track information
        logTrackInfo(consumer.track);
    }
    
    try {
        mediaElement.srcObject = stream;
        updateDebugInfo(`srcObject set successfully for ${consumer.kind}`);
    } catch (e) {
        updateDebugInfo(`Error setting srcObject: ${e}`);
        console.error('Failed to set srcObject:', e);
    }
    
    const container = document.getElementById('media-container');
    if (!container) {
        updateDebugInfo('Error: Media container not found');
        throw new Error('Media container not found');
    }
    
    // Clear existing elements of the same kind
    const existingElements = container.getElementsByTagName(consumer.kind);
    Array.from(existingElements).forEach(element => {
        updateDebugInfo(`Removing existing ${consumer.kind} element`);
        element.remove();
    });
    
    container.appendChild(mediaElement);
    updateDebugInfo(`Media element appended to container: ${mediaElement.id}`);
    
    // Add periodic track status check
    const statusInterval = setInterval(() => {
        if (consumer.track) {
            updateDebugInfo(`Track status check - enabled: ${consumer.track.enabled}, readyState: ${consumer.track.readyState}`);
        } else {
            clearInterval(statusInterval);
            updateDebugInfo('Track no longer available');
        }
    }, 1000);
    
    // Cleanup interval when track ends
    consumer.track.onended = () => {
        clearInterval(statusInterval);
        updateDebugInfo('Track ended - clearing status check interval');
    };
    
    return mediaElement;
  }

}

window.addEventListener('load', () => {
  new HeygenClient();
});
