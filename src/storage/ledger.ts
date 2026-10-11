import { ClassicLevel } from 'classic-level';
import { Block, ChainState } from '../types/index.js';

export interface ILedgerStorage {
  saveBlock(block: Block): Promise<void>;
  getBlock(index: number): Promise<Block | null>;
  getBlockByHash(hash: string): Promise<Block | null>;
  getLatestBlock(): Promise<Block | null>;
  saveState(state: ChainState): Promise<void>;
  getState(): Promise<ChainState | null>;
  close(): Promise<void>;
}

export class LedgerStorage implements ILedgerStorage {
  private db?: ClassicLevel<string, any>;
  private memoryBlocks: Map<number, Block> = new Map();
  private memoryHashIndex: Map<string, number> = new Map();
  private memoryState: ChainState | null = null;
  private latestIndex: number = -1;

  constructor(private dbPath?: string) {
    if (this.dbPath) {
      this.db = new ClassicLevel(this.dbPath, { valueEncoding: 'json' });
    }
  }

  async init(): Promise<void> {
    if (this.db) {
      try {
        const latest = await this.db.get('meta:latestBlockIndex');
        if (typeof latest === 'number') {
          this.latestIndex = latest;
        }
      } catch (err: any) {
        if (err.code !== 'LEVEL_NOT_FOUND') {
          throw err;
        }
      }
    }
  }

  async saveBlock(block: Block): Promise<void> {
    const idx = block.header.index;
    this.memoryBlocks.set(idx, block);
    this.memoryHashIndex.set(block.hash, idx);
    if (idx > this.latestIndex) {
      this.latestIndex = idx;
    }

    if (this.db) {
      const batch = this.db.batch();
      batch.put(`block:${idx}`, block);
      batch.put(`hash:${block.hash}`, idx);
      batch.put('meta:latestBlockIndex', this.latestIndex);
      await batch.write();
    }
  }

  async getBlock(index: number): Promise<Block | null> {
    if (this.memoryBlocks.has(index)) {
      return this.memoryBlocks.get(index)!;
    }
    if (this.db) {
      try {
        return (await this.db.get(`block:${index}`)) as Block;
      } catch (err: any) {
        if (err.code === 'LEVEL_NOT_FOUND') return null;
        throw err;
      }
    }
    return null;
  }

  async getBlockByHash(hash: string): Promise<Block | null> {
    if (this.memoryHashIndex.has(hash)) {
      const idx = this.memoryHashIndex.get(hash)!;
      return this.getBlock(idx);
    }
    if (this.db) {
      try {
        const idx = (await this.db.get(`hash:${hash}`)) as number;
        return this.getBlock(idx);
      } catch (err: any) {
        if (err.code === 'LEVEL_NOT_FOUND') return null;
        throw err;
      }
    }
    return null;
  }

  async getLatestBlock(): Promise<Block | null> {
    if (this.latestIndex < 0) return null;
    return this.getBlock(this.latestIndex);
  }

  async saveState(state: ChainState): Promise<void> {
    this.memoryState = JSON.parse(JSON.stringify(state));
    if (this.db) {
      await this.db.put('state:latest', state);
    }
  }

  async getState(): Promise<ChainState | null> {
    if (this.memoryState) {
      return this.memoryState;
    }
    if (this.db) {
      try {
        return (await this.db.get('state:latest')) as ChainState;
      } catch (err: any) {
        if (err.code === 'LEVEL_NOT_FOUND') return null;
        throw err;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
    }
  }
}
