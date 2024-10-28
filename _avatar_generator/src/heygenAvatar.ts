import axios from 'axios';
import wrtc from 'wrtc';
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = wrtc;
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

  

  constructor(private mediasoupServer: MediasoupServer) {
    this.logger = new Logger();
  }

  /**
   * Generates an access token using the API key.
   */
  public async generateAccessToken() {
    try {
      this.logger.info('Generating HeyGen access token...');
      const apiKey = config.get('heygen.apiKey');
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
          video_encoding: 'VP8',
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
        this.logger.info('Received ICE servers:', iceServers);
        this.logger.info('Received SDP offer:', offerSdp);
        this.logger.info('SDP type:', data.sdp.type);

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

      this.peerConnection = new RTCPeerConnection({ iceServers }) as RTCPeerConnection;

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendIceCandidate(event.candidate);
        }
      };

      this.peerConnection.ontrack = (event) => {
        this.logger.info('Received remote track:', event.track.kind);
        if (event.track.kind === 'video' || event.track.kind === 'audio') {
          this.mediasoupServer.receiveTrack(event.track);
          this.logger.info('Track Data:', event.track);
        }
      };

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
      this.logger.info('Session started with HeyGen.');

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

}