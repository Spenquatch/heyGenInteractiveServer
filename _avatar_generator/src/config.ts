import convict from 'convict';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export const config = convict({
      server: {
        port: {
          doc: 'The port to bind',
          format: 'port',
          default: 3000,
          env: 'PORT'
        }
      },
      mediasoup: {
        numWorkers: {
          doc: 'Number of mediasoup workers',
          format: Number,
          default: 2,
          env: 'MEDIASOUP_NUM_WORKERS'
        },
        workerSettings: {
          logLevel: {
            doc: 'Worker log level',
            format: String,
            default: 'warn',
            env: 'MEDIASOUP_LOG_LEVEL'
          },
          logTags: {
            doc: 'Worker log tags',
            format: Array,
            default: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
          },
          rtcMinPort: {
            doc: 'RTC minimum port',
            format: 'port',
            default: 10000,
            env: 'MEDIASOUP_RTC_MIN_PORT'
          },
          rtcMaxPort: {
            doc: 'RTC maximum port',
            format: 'port',
            default: 10100,
            env: 'MEDIASOUP_RTC_MAX_PORT'
          },
          dtlsCertificateFile: {
            doc: 'DTLS certificate file path',
            format: String,
            default: 'cert.pem'
          },
          dtlsPrivateKeyFile: {
            doc: 'DTLS private key file path',
            format: String,
            default: 'key.pem'
          },
          disableLiburing: {
            doc: 'Disable liburing',
            format: Boolean,
            default: false
          }
        },
        router: {
          mediaCodecs: {
            doc: 'Media codecs configuration',
            format: Array,
            default: [
              {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
                parameters: {},
              },
              {
                kind: 'video',
                mimeType: 'video/VP8',
                clockRate: 90000,
                parameters: {
                  'x-google-start-bitrate': 1000,
                },
              },
            ]
          }
        },
        webRtcTransport: {
          listenIps: {
            doc: 'Array of IP addresses to listen on',
            format: Array,
            default: [{ ip: '0.0.0.0', announcedIp: null }]
          },
          enableUdp: {
            doc: 'Enable UDP',
            format: Boolean,
            default: true
          },
          enableTcp: {
            doc: 'Enable TCP',
            format: Boolean,
            default: true
          },
          preferUdp: {
            doc: 'Prefer UDP over TCP',
            format: Boolean,
            default: true
          },
          initialAvailableOutgoingBitrate: {
            doc: 'Initial available outgoing bitrate',
            format: Number,
            default: 1000000
          },
          minimumAvailableOutgoingBitrate: {
            doc: 'Minium available outgoing bitrate',
            format: Number,
            default: 600000
          },
          maxIncomingBitrate: {
            doc: 'Maximum incoming bitrate',
            format: Number,
            default: 1500000
          }
        }
      },
      https: {
        listenPort: {
          doc: 'HTTPS listen port',
          format: 'port',
          default: 4443,
          env: 'HTTPS_PORT'
        },
        listenIp: {
          doc: 'HTTPS listen IP',
          format: String,
          default: '0.0.0.0',
          env: 'HTTPS_IP'
        },
        tls: {
          dtlsCertificateFile: {
            doc: 'TLS certificate file path',
            format: String,
            default: 'cert.pem'
          },
          dtlsPrivateKeyFile: {
            doc: 'TLS private key file path',
            format: String,
            default: 'key.pem'
          }
        }
      },
      heygen: {
        apiKey: {
          doc: 'Heygen API key',
          format: String,
          default: 'Yjc5ZDg1YTBjZWI2NDgyODlhN2QxOTY3MGY3OWI2NWItMTcxNjc3MjkxMQ==',
          env: 'HEYGEN_API_KEY'
        },
        avatarId: {
          doc: 'Heygen avatar ID',
          format: String,
          default: 'default',
          env: 'HEYGEN_AVATAR_ID'
        }
      }
    }).validate();
