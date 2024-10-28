import * as mediasoupClient from 'mediasoup-client';
import { Socket, io } from 'socket.io-client';

interface ErrorResponse {
  error: string;
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

    this.transport = this.device.createRecvTransport(transportOptions);

    this.transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket.emit(
            'transportConnect',
            {
              transportId: this.transport?.id,
              dtlsParameters,
            },
            ({ error }: ErrorResponse) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        });
        callback();
      } catch (error) {
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
    
    const mediaElement = document.createElement(consumer.kind === 'video' ? 'video' : 'audio');
    const stream = new MediaStream([consumer.track]);
    
    mediaElement.id = consumer.id;
    
    if (consumer.kind === 'video') {
        const videoElement = mediaElement as HTMLVideoElement;
        
        // Set attributes before setting srcObject
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true;
        videoElement.controls = true;
        videoElement.style.width = '100%';
        videoElement.style.maxWidth = '640px';
        videoElement.style.backgroundColor = 'black';
        
        // Add all event listeners before setting srcObject
        videoElement.addEventListener('loadedmetadata', () => {
            console.log('Video loadedmetadata event', {
                readyState: videoElement.readyState,
                videoWidth: videoElement.videoWidth,
                videoHeight: videoElement.videoHeight
            });
            videoElement.play()
                .then(() => console.log('Video playback started successfully'))
                .catch(e => console.error('Video play failed:', e));
        });
        
        videoElement.addEventListener('canplay', () => {
            console.log('Video canplay event');
            if (videoElement.paused) {
                videoElement.play()
                    .then(() => console.log('Video play on canplay successful'))
                    .catch(e => console.error('Video play on canplay failed:', e));
            }
        });
        
        videoElement.addEventListener('playing', () => {
            console.log('Video playing event', {
                time: videoElement.currentTime,
                dimensions: `${videoElement.videoWidth}x${videoElement.videoHeight}`,
                paused: videoElement.paused,
                ended: videoElement.ended,
                readyState: videoElement.readyState
            });
        });
        
        // Add more detailed error handling
        videoElement.addEventListener('error', () => {
            const error = videoElement.error;
            console.error('Video element error:', {
                code: error?.code,
                message: error?.message
            });
        });

        videoElement.addEventListener('stalled', () => {
            console.log('Video stalled event - attempting to resume');
            videoElement.play()
                .catch(e => console.error('Failed to resume after stall:', e));
        });

        videoElement.addEventListener('waiting', () => {
            console.log('Video waiting event');
            // Key frame request removed
        });
        
        // Set srcObject and handle potential errors
        try {
            videoElement.srcObject = stream;
        } catch (e) {
            console.error('Failed to set srcObject:', e);
        }
        
        // Monitor track state changes
        consumer.track.onended = async () => {
            console.log('Track ended - attempting to restart');
            try {
                await consumer.resume();
            } catch (e) {
                console.error('Failed to resume consumer:', e);
            }
        };
        
        consumer.track.onmute = async () => {
            console.log('Track muted - attempting to unmute');
            try {
                await consumer.resume();
            } catch (e) {
                console.error('Failed to resume consumer:', e);
            }
        };
        
        consumer.track.onunmute = () => {
            console.log('Track unmuted');
            if (videoElement.paused) {
                videoElement.play()
                    .catch(e => console.error('Failed to play after unmute:', e));
            }
        };
        
        // Add consumer event handlers
        consumer.on('transportclose', () => {
            console.log('Consumer transport closed');
        });
        
        consumer.on('trackended', () => {
            console.log('Consumer track ended');
        });
        
        // Force a play attempt with timeout
        const playAttempts = [100, 500, 1000, 2000];
        playAttempts.forEach(delay => {
            setTimeout(() => {
                if (videoElement.paused) {
                    console.log(`Attempting delayed play (${delay}ms)...`);
                    videoElement.play()
                        .then(() => console.log(`Delayed play successful (${delay}ms)`))
                        .catch(e => console.error(`Delayed play failed (${delay}ms):`, e));
                }
            }, delay);
        });
        
        // Log stream and track information
        console.log('Video stream tracks:', stream.getTracks());
        console.log('Video track enabled:', consumer.track.enabled);
        console.log('Video track readyState:', consumer.track.readyState);
        console.log('Video track settings:', consumer.track.getSettings());
        
    } else {
        // For audio elements
        const audioElement = mediaElement as HTMLAudioElement;
        audioElement.autoplay = true;
        audioElement.controls = true;
        audioElement.srcObject = stream;
    }
    
    return mediaElement;
  }

}

window.addEventListener('load', () => {
  new HeygenClient();
});

