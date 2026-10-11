export const TOPIC_TX = '/lottery/tx/1.0.0';
export const TOPIC_ENTROPY = '/lottery/entropy/1.0.0';
export const TOPIC_BLOCKS = '/lottery/blocks/1.0.0';

export interface P2PEntropyMessage {
  type: 'COMMIT' | 'REVEAL';
  payload: any;
}

export interface P2PTxMessage {
  type: 'TX';
  payload: any;
}

export interface P2PBlockMessage {
  type: 'BLOCK';
  payload: any;
}
