import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { getLogger } from './logger';

export interface MessageBus {
  publish(channel: string, message: unknown): void;
  subscribe(channel: string, listener: (msg: unknown) => void): () => void;
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown, ttlSeconds?: number): void;
  del(key: string): void;
  keys(pattern: string): string[];
  close(): void;
}

/** Redis-backed bus with pub/sub, KV and TTL. */
export class RedisBus implements MessageBus {
  private client: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(msg: unknown) => void>>();

  constructor(host: string, port: number, db: number) {
    this.client = new Redis({ host, port, db, lazyConnect: false, maxRetriesPerRequest: 1 });
    this.sub = new Redis({ host, port, db });
    this.sub.on('message', (_channel, data) => {
      const handlers = this.handlers.get(_channel);
      if (!handlers) return;
      let parsed: unknown = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* keep raw */
      }
      for (const h of handlers) h(parsed);
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  publish(channel: string, message: unknown): void {
    this.client.publish(channel, JSON.stringify(message));
  }

  subscribe(channel: string, listener: (msg: unknown) => void): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      this.sub.subscribe(channel).catch(() => {});
    }
    this.handlers.get(channel)!.add(listener);
    return () => {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.handlers.delete(channel);
        this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  get<T = unknown>(key: string): T | null {
    // ioredis sync-style via cache is not possible; use the synchronous contract
    throw new Error('use getAsync');
  }

  set(_key: string, _value: unknown, _ttl?: number): void {
    throw new Error('use setAsync');
  }

  keys(_pattern: string): string[] {
    throw new Error('use keysAsync');
  }

  del(_key: string): void {
    throw new Error('use delAsync');
  }

  async getAsync<T = unknown>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    if (val === null) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  async setAsync(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) await this.client.set(key, serialized, 'EX', ttlSeconds);
    else await this.client.set(key, serialized);
  }

  async keysAsync(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async delAsync(key: string): Promise<void> {
    await this.client.del(key);
  }

  close(): void {
    this.client.disconnect();
    this.sub.disconnect();
  }
}

/** In-memory fallback with JSON file persistence so state survives restarts. */
export class MemoryBus implements MessageBus {
  private store = new Map<string, { value: unknown; expireAt?: number }>();
  private emitter = new EventEmitter();
  private persistPath: string;
  private dirty = false;

  constructor(persistPath?: string) {
    this.persistPath = persistPath || process.env.COTEAM_STATE_FILE || '';
    if (this.persistPath) {
      this.loadPersisted();
      process.on('exit', () => this.flush());
    }
  }

  private loadPersisted(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        const now = Date.now();
        for (const [k, v] of Object.entries(data.store || {})) {
          const expireAt = (data.ttl as Record<string, number>)?.[k];
          if (expireAt && now > expireAt) continue;
          this.store.set(k, { value: v, expireAt });
        }
      }
    } catch {
      /* corrupt state file: start fresh */
    }
  }

  flush(): void {
    if (!this.persistPath || !this.dirty) return;
    this.dirty = false;
    const store: Record<string, unknown> = {};
    const ttl: Record<string, number> = {};
    for (const [k, entry] of this.store) {
      store[k] = entry.value;
      if (entry.expireAt) ttl[k] = entry.expireAt;
    }
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ store, ttl }));
      fs.renameSync(tmp, this.persistPath);
    } catch {
      /* best effort */
    }
  }

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    return !!entry?.expireAt && Date.now() > entry.expireAt;
  }

  publish(channel: string, message: unknown): void {
    this.emitter.emit(channel, message);
  }

  subscribe(channel: string, listener: (msg: unknown) => void): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  get<T = unknown>(key: string): T | null {
    if (this.isExpired(key)) {
      this.store.delete(key);
      return null;
    }
    return (this.store.get(key)?.value as T) ?? null;
  }

  set(key: string, value: unknown, ttlSeconds?: number): void {
    this.store.set(key, {
      value,
      expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    this.dirty = true;
  }

  keys(pattern: string): string[] {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...this.store.keys()].filter((k) => {
      if (this.isExpired(k)) return false;
      return regex.test(k);
    });
  }

  del(key: string): void {
    this.store.delete(key);
    this.dirty = true;
  }

  close(): void {
    this.flush();
  }
}

let bus: MessageBus | null = null;

export async function initBus(redisConfig: { host: string; port: number; db: number }): Promise<MessageBus> {
  if (bus) return bus;
  
  const logger = getLogger();
  
  if (process.env.COTEAM_FORCE_MEMORY === '1') {
    logger.info('Using in-memory message bus (forced by COTEAM_FORCE_MEMORY)');
    bus = new MemoryBus();
    return bus;
  }
  
  try {
    logger.info('Connecting to Redis', { host: redisConfig.host, port: redisConfig.port, db: redisConfig.db });
    const redisBus = new RedisBus(redisConfig.host, redisConfig.port, redisConfig.db);
    await redisBus.ping();
    bus = redisBus as unknown as MessageBus;
    logger.info('Redis connection successful');
  } catch (error) {
    logger.warn('Redis connection failed, using in-memory message bus', { error: String(error) });
    bus = new MemoryBus();
  }
  return bus;
}

export function getBus(): MessageBus {
  if (!bus) throw new Error('MessageBus not initialized. Call initBus() first.');
  return bus;
}

export function closeBus(): void {
  bus?.close();
  bus = null;
}

/** Uniform sync-looking async accessors used across the codebase. */
export async function busGet<T = unknown>(key: string): Promise<T | null> {
  const b = getBus() as MessageBus & Partial<RedisBus>;
  if (typeof (b as RedisBus).getAsync === 'function') return (b as RedisBus).getAsync<T>(key);
  return b.get<T>(key);
}

export async function busSet(key: string, value: unknown, ttl?: number): Promise<void> {
  const b = getBus() as MessageBus & Partial<RedisBus>;
  if (typeof (b as RedisBus).setAsync === 'function') return (b as RedisBus).setAsync(key, value, ttl);
  return b.set(key, value, ttl);
}

export async function busKeys(pattern: string): Promise<string[]> {
  const b = getBus() as MessageBus & Partial<RedisBus>;
  if (typeof (b as RedisBus).keysAsync === 'function') return (b as RedisBus).keysAsync(pattern);
  return b.keys(pattern);
}

export async function busDel(key: string): Promise<void> {
  const b = getBus() as MessageBus & Partial<RedisBus>;
  if (typeof (b as RedisBus).delAsync === 'function') return (b as RedisBus).delAsync(key);
  return b.del(key);
}
