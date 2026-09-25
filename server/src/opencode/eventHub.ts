import { randomBytes } from 'node:crypto';
import type { OcEvent } from './types';

export interface HubEvent {
  instanceId: string;
  eventId: string;
  event: OcEvent;
}

export interface OpencodeEventHubOptions {
  instanceId: string;
  replayLimit?: number;
  replayBytes?: number;
  processId?: number;
}

type ReplayEntry = {
  value: HubEvent;
  bytes: number;
};

const DEFAULT_REPLAY_LIMIT = 2048;
const DEFAULT_REPLAY_BYTES = 8 * 1024 * 1024;
const SEQUENCE_DIGITS = 12;

export class OpencodeEventHub {
  latestEventId?: string;

  private readonly instanceId: string;
  private readonly replayLimit: number;
  private readonly replayBytes: number;
  private readonly processId: number;
  private prefix: string;
  private sequence = 0;
  private replay: ReplayEntry[] = [];
  private replayBytesUsed = 0;

  constructor(options: OpencodeEventHubOptions) {
    this.instanceId = options.instanceId;
    this.replayLimit = normalizeLimit(options.replayLimit, DEFAULT_REPLAY_LIMIT);
    this.replayBytes = normalizeLimit(options.replayBytes, DEFAULT_REPLAY_BYTES);
    this.processId = options.processId ?? process.pid;
    this.prefix = this.createPrefix();
  }

  commit(event: OcEvent): HubEvent {
    const eventId = event.id ?? this.nextEventId();
    const value = { instanceId: this.instanceId, eventId, event };
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');

    this.latestEventId = eventId;
    if (bytes > this.replayBytes) {
      this.replay = [];
      this.replayBytesUsed = 0;
      return value;
    }

    this.replay.push({ value, bytes });
    this.replayBytesUsed += bytes;
    while (this.replay.length > this.replayLimit || this.replayBytesUsed > this.replayBytes) {
      const removed = this.replay.shift();
      if (!removed) break;
      this.replayBytesUsed -= removed.bytes;
    }
    return value;
  }

  replayAfter(eventId?: string): HubEvent[] | null {
    if (eventId === undefined) return null;
    if (eventId === this.latestEventId) return [];
    const index = this.replay.findIndex(({ value }) => value.eventId === eventId);
    if (index < 0) return null;
    return this.replay.slice(index + 1).map(({ value }) => value);
  }

  reset(): void {
    this.prefix = this.createPrefix();
    this.sequence = 0;
    this.replay = [];
    this.replayBytesUsed = 0;
    delete this.latestEventId;
  }

  private nextEventId(): string {
    this.sequence += 1;
    return `${this.prefix}-${String(this.sequence).padStart(SEQUENCE_DIGITS, '0')}`;
  }

  private createPrefix(): string {
    return `oc-${this.processId}-${randomBytes(8).toString('hex')}`;
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
