import { EventEmitter } from 'events';
import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { multiaddr } from '@multiformats/multiaddr';
import { TOPIC_TX, TOPIC_ENTROPY, TOPIC_BLOCKS, P2PEntropyMessage } from './topics.js';
import { Transaction, EntropyCommitment, EntropyReveal, Block } from '../types/index.js';

export interface P2PNodeOptions {
  listenPort?: number;
  listenHost?: string;
  enableMdns?: boolean;
  bootstrapAddrs?: string[];
}

export class P2PNetworkNode extends EventEmitter {
  private node?: Libp2p<any>;
  private running = false;
  private subscribedTopics = new Set<string>();

  constructor(private options: P2PNodeOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.running) return;

    const host = this.options.listenHost || '127.0.0.1';
    const port = this.options.listenPort ?? 0;
    const listenAddr = `/ip4/${host}/tcp/${port}`;

    const services: Record<string, any> = {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false
      })
    };

    if (this.options.enableMdns) {
      services.mdns = mdns();
    }

    this.node = await createLibp2p({
      addresses: {
        listen: [listenAddr]
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services
    });

    // Setup PubSub event listener
    const pubsub = this.node.services.pubsub;
    pubsub.addEventListener('message', (evt: any) => {
      this.handleIncomingMessage(evt.detail.topic, evt.detail.data);
    });

    // Subscribe to chain topics
    await this.subscribe(TOPIC_TX);
    await this.subscribe(TOPIC_ENTROPY);
    await this.subscribe(TOPIC_BLOCKS);

    // Bootstrap if addresses provided
    if (this.options.bootstrapAddrs && this.options.bootstrapAddrs.length > 0) {
      for (const addr of this.options.bootstrapAddrs) {
        try {
          await this.dial(addr);
        } catch (err: any) {
          // ignore or log bootstrap error
        }
      }
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running || !this.node) return;
    await this.node.stop();
    this.running = false;
  }

  getPeerId(): string {
    return this.node ? this.node.peerId.toString() : '';
  }

  getMultiaddrs(): string[] {
    if (!this.node) return [];
    return this.node.getMultiaddrs().map((m) => m.toString());
  }

  getConnectedPeers(): string[] {
    if (!this.node) return [];
    return this.node.getPeers().map((p) => p.toString());
  }

  async dial(targetMultiaddr: string): Promise<void> {
    if (!this.node) throw new Error('P2P Node is not running');
    const ma = multiaddr(targetMultiaddr);
    await this.node.dial(ma as any);
  }

  async subscribe(topic: string): Promise<void> {
    if (!this.node) return;
    if (!this.subscribedTopics.has(topic)) {
      this.node.services.pubsub.subscribe(topic);
      this.subscribedTopics.add(topic);
    }
  }

  async publish(topic: string, data: any): Promise<void> {
    if (!this.node) return;
    const jsonStr = JSON.stringify(data);
    const bytes = new TextEncoder().encode(jsonStr);
    await this.node.services.pubsub.publish(topic, bytes);
  }

  async broadcastTx(tx: Transaction): Promise<void> {
    await this.publish(TOPIC_TX, tx);
  }

  async broadcastCommitment(commitment: EntropyCommitment): Promise<void> {
    const msg: P2PEntropyMessage = {
      type: 'COMMIT',
      payload: commitment
    };
    await this.publish(TOPIC_ENTROPY, msg);
  }

  async broadcastReveal(reveal: EntropyReveal): Promise<void> {
    const msg: P2PEntropyMessage = {
      type: 'REVEAL',
      payload: reveal
    };
    await this.publish(TOPIC_ENTROPY, msg);
  }

  async broadcastBlock(block: Block): Promise<void> {
    await this.publish(TOPIC_BLOCKS, block);
  }

  private handleIncomingMessage(topic: string, data: Uint8Array): void {
    try {
      const decoded = new TextDecoder().decode(data);
      const parsed = JSON.parse(decoded);

      if (topic === TOPIC_TX) {
        this.emit('tx', parsed as Transaction);
      } else if (topic === TOPIC_ENTROPY) {
        const entropyMsg = parsed as P2PEntropyMessage;
        if (entropyMsg.type === 'COMMIT') {
          this.emit('commit', entropyMsg.payload as EntropyCommitment);
        } else if (entropyMsg.type === 'REVEAL') {
          this.emit('reveal', entropyMsg.payload as EntropyReveal);
        }
      } else if (topic === TOPIC_BLOCKS) {
        this.emit('block', parsed as Block);
      }
    } catch (err: any) {
      this.emit('error', err);
    }
  }
}
