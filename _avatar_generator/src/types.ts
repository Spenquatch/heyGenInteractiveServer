declare module 'wrtc' {
    interface RTCConfiguration {
      iceServers?: RTCIceServer[];
      iceTransportPolicy?: RTCIceTransportPolicy;
      bundlePolicy?: RTCBundlePolicy;
      rtcpMuxPolicy?: RTCRtcpMuxPolicy;
      peerIdentity?: string;
      certificates?: RTCCertificate[];
    }
  
    interface RTCPeerConnectionInterface {
      createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
      createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
      setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
      setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
      close(): void;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
      ontrack: ((event: RTCTrackEvent) => void) | null;
    }
  
    export type RTCSessionDescriptionInit = {
      type: 'offer' | 'answer' | 'pranswer' | 'rollback';
      sdp: string;
    };
  
    export type RTCPeerConnection = RTCPeerConnectionInterface;
  
    const wrtc: {
      readonly RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnectionInterface;
      readonly RTCSessionDescription: new (description: RTCSessionDescriptionInit) => RTCSessionDescription;
      readonly RTCIceCandidate: new (configuration: RTCIceCandidateInit) => RTCIceCandidate;
      readonly MediaStream: {
        new(): MediaStream;
        new(stream: MediaStream): MediaStream;
        new(tracks: MediaStreamTrack[]): MediaStream;
      };
      readonly MediaStreamTrack: new () => MediaStreamTrack;
      readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    };
  
    export default wrtc;
  }
  