import type { AttackRequest, OnlineGameSnapshot, OnlinePeerSignal, OnlinePeerSignalType, OnlineRoom } from './protocol';

type SendSignal = (signal: {
  toPlayerId: string;
  type: OnlinePeerSignalType;
  data: unknown;
}) => void;

type PeerConnectionState = 'new' | 'connecting' | 'open' | 'closed';

export interface OnlinePeerSnapshotMessage {
  type: 'snapshot';
  playerId: string;
  game: OnlineGameSnapshot;
}

export type OnlinePeerAttackMessage = Omit<AttackRequest, 'roomId'> & { type: 'attack' };
export interface OnlinePeerKoMessage {
  type: 'ko';
  playerId: string;
  frame: number;
}

type OnlinePeerMessage = OnlinePeerSnapshotMessage | OnlinePeerAttackMessage | OnlinePeerKoMessage;

interface OnlinePeerBroadcasterOptions {
  playerId: string;
  sendSignal: SendSignal;
  onSnapshot: (playerId: string, game: OnlineGameSnapshot) => void;
  onAttack?: (attack: OnlinePeerAttackMessage) => void;
  onKo?: (message: OnlinePeerKoMessage) => void;
  onPeerState?: (playerId: string, state: PeerConnectionState) => void;
}

interface PeerEntry {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  makingOffer: boolean;
  state: PeerConnectionState;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export class OnlinePeerBroadcaster {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly seenSignals = new Set<string>();

  constructor(private readonly options: OnlinePeerBroadcasterOptions) {}

  syncRoom(room: OnlineRoom): void {
    const remoteIds = new Set(room.players.map((player) => player.id).filter((id) => id !== this.options.playerId));
    for (const remoteId of remoteIds) this.ensurePeer(remoteId, this.shouldInitiate(remoteId));
    for (const remoteId of this.peers.keys()) {
      if (!remoteIds.has(remoteId)) this.closePeer(remoteId);
    }
    this.acceptSignals(room.peerSignals ?? []);
  }

  broadcast(game: OnlineGameSnapshot): void {
    const message = JSON.stringify({ type: 'snapshot', playerId: this.options.playerId, game } satisfies OnlinePeerSnapshotMessage);
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === 'open') peer.channel.send(message);
    }
  }

  sendAttack(toPlayerId: string, attack: Omit<OnlinePeerAttackMessage, 'type' | 'toPlayerId'>): boolean {
    const peer = this.peers.get(toPlayerId);
    if (peer?.channel?.readyState !== 'open') return false;
    peer.channel.send(JSON.stringify({ ...attack, type: 'attack', toPlayerId } satisfies OnlinePeerAttackMessage));
    return true;
  }

  broadcastKo(frame: number): void {
    const message = JSON.stringify({ type: 'ko', playerId: this.options.playerId, frame } satisfies OnlinePeerKoMessage);
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === 'open') peer.channel.send(message);
    }
  }

  close(): void {
    for (const remoteId of [...this.peers.keys()]) this.closePeer(remoteId);
    this.seenSignals.clear();
  }

  private acceptSignals(signals: OnlinePeerSignal[]): void {
    for (const signal of signals) {
      if (signal.toPlayerId !== this.options.playerId || this.seenSignals.has(signal.id)) continue;
      this.seenSignals.add(signal.id);
      void this.handleSignal(signal);
    }
  }

  private ensurePeer(remoteId: string, initiate: boolean): PeerEntry {
    const existing = this.peers.get(remoteId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = {
      connection,
      channel: null,
      pendingIce: [],
      makingOffer: false,
      state: 'new',
    };
    this.peers.set(remoteId, entry);
    this.setPeerState(remoteId, 'connecting');

    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.options.sendSignal({
        toPlayerId: remoteId,
        type: 'ice',
        data: event.candidate.toJSON(),
      });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') this.setPeerState(remoteId, 'open');
      if (connection.connectionState === 'closed' || connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        this.setPeerState(remoteId, connection.connectionState === 'closed' ? 'closed' : 'connecting');
      }
    };
    connection.ondatachannel = (event) => this.attachChannel(remoteId, entry, event.channel);

    if (initiate) {
      this.attachChannel(remoteId, entry, connection.createDataChannel('stack40-game', { ordered: false, maxRetransmits: 0 }));
      void this.createAndSendOffer(remoteId, entry);
    }

    return entry;
  }

  private async createAndSendOffer(remoteId: string, entry: PeerEntry): Promise<void> {
    if (entry.makingOffer) return;
    entry.makingOffer = true;
    try {
      const offer = await entry.connection.createOffer();
      await entry.connection.setLocalDescription(offer);
      this.options.sendSignal({
        toPlayerId: remoteId,
        type: 'offer',
        data: entry.connection.localDescription?.toJSON() ?? offer,
      });
    } finally {
      entry.makingOffer = false;
    }
  }

  private async handleSignal(signal: OnlinePeerSignal): Promise<void> {
    const entry = this.ensurePeer(signal.fromPlayerId, false);
    if (signal.type === 'ice') {
      const candidate = signal.data as RTCIceCandidateInit;
      if (!entry.connection.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }
      await entry.connection.addIceCandidate(candidate);
      return;
    }

    const description = signal.data as RTCSessionDescriptionInit;
    await entry.connection.setRemoteDescription(description);
    await this.flushPendingIce(entry);
    if (signal.type === 'offer') {
      const answer = await entry.connection.createAnswer();
      await entry.connection.setLocalDescription(answer);
      this.options.sendSignal({
        toPlayerId: signal.fromPlayerId,
        type: 'answer',
        data: entry.connection.localDescription?.toJSON() ?? answer,
      });
    }
  }

  private async flushPendingIce(entry: PeerEntry): Promise<void> {
    while (entry.pendingIce.length > 0) {
      const candidate = entry.pendingIce.shift();
      if (candidate) await entry.connection.addIceCandidate(candidate);
    }
  }

  private attachChannel(remoteId: string, entry: PeerEntry, channel: RTCDataChannel): void {
    entry.channel = channel;
    channel.onopen = () => this.setPeerState(remoteId, 'open');
    channel.onclose = () => this.setPeerState(remoteId, 'closed');
    channel.onmessage = (event) => this.handleChannelMessage(event.data);
  }

  private handleChannelMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    try {
      const message = JSON.parse(data) as OnlinePeerMessage;
      if (message.type === 'snapshot') {
        if (!message.playerId || !message.game) return;
        this.options.onSnapshot(message.playerId, message.game);
      }
      if (message.type === 'attack') {
        if (!message.attackId || !message.fromPlayerId || !message.toPlayerId || !Number.isFinite(message.lines)) return;
        this.options.onAttack?.(message);
      }
      if (message.type === 'ko') {
        if (!message.playerId || !Number.isFinite(message.frame)) return;
        this.options.onKo?.(message);
      }
    } catch {
      // Ignore malformed peer messages. The server polling fallback remains authoritative for room state.
    }
  }

  private closePeer(remoteId: string): void {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    peer.channel?.close();
    peer.connection.close();
    this.peers.delete(remoteId);
    this.setPeerState(remoteId, 'closed');
  }

  private setPeerState(remoteId: string, state: PeerConnectionState): void {
    const peer = this.peers.get(remoteId);
    if (peer) peer.state = state;
    this.options.onPeerState?.(remoteId, state);
  }

  private shouldInitiate(remoteId: string): boolean {
    return this.options.playerId < remoteId;
  }
}
