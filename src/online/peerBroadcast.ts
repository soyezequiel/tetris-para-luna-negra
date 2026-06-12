import type { GameInput } from '../game/types';
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
  seed?: number;
  game: OnlineGameSnapshot;
}

export type OnlinePeerAttackMessage = Omit<AttackRequest, 'roomId'> & { type: 'attack' };
// Intención de ataque que un invitado manda al host: el host elige objetivo y la rutea.
// A diferencia de OnlinePeerAttackMessage (host -> víctima, ya resuelto), esto va
// invitado -> host y todavía no tiene toPlayerId.
export interface OnlinePeerAttackIntentMessage {
  type: 'attackIntent';
  fromPlayerId: string;
  attackId: string;
  lines: number;
  holeSeed: number;
  frame: number;
  seed?: number;
}
export interface OnlinePeerInputMessage {
  type: 'input';
  playerId: string;
  seed?: number;
  inputs: GameInput[];
}
export interface OnlinePeerKoMessage {
  type: 'ko';
  playerId: string;
  seed?: number;
  frame: number;
  lines: number;
  pieces: number;
  elapsedFrames: number;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: number;
  game: OnlineGameSnapshot | null;
}

type OnlinePeerMessage =
  | OnlinePeerSnapshotMessage
  | OnlinePeerAttackMessage
  | OnlinePeerAttackIntentMessage
  | OnlinePeerInputMessage
  | OnlinePeerKoMessage;

interface OnlinePeerBroadcasterOptions {
  playerId: string;
  sendSignal: SendSignal;
  onSnapshot: (remoteId: string, playerId: string, game: OnlineGameSnapshot) => void;
  onAttack?: (remoteId: string, attack: OnlinePeerAttackMessage) => void;
  onAttackIntent?: (remoteId: string, intent: OnlinePeerAttackIntentMessage) => void;
  onInput?: (remoteId: string, message: OnlinePeerInputMessage) => void;
  onKo?: (remoteId: string, message: OnlinePeerKoMessage) => void;
  onPeerState?: (playerId: string, state: PeerConnectionState) => void;
}

interface PeerEntry {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  makingOffer: boolean;
  state: PeerConnectionState;
  createdAt: number;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
// Una conexión que sigue en 'new'/'connecting' pasado este tiempo (ICE pegado por
// NAT/firewall) nunca recupera sola: la recreamos para reintentar la negociación.
// Sin esto, ese peer queda invisible (sin snapshots) indefinidamente.
const PEER_CONNECT_TIMEOUT_MS = 8000;

export class OnlinePeerBroadcaster {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly seenSignals = new Set<string>();

  constructor(private readonly options: OnlinePeerBroadcasterOptions) {}

  syncRoom(room: OnlineRoom): void {
    this.reviveStalledPeers();
    const remoteIds = new Set(room.players.map((player) => player.id).filter((id) => id !== this.options.playerId));
    for (const remoteId of remoteIds) this.ensurePeer(remoteId, this.shouldInitiate(remoteId));
    for (const remoteId of this.peers.keys()) {
      if (!remoteIds.has(remoteId)) this.closePeer(remoteId);
    }
    this.acceptSignals(room.peerSignals ?? []);
  }

  broadcast(game: OnlineGameSnapshot): void {
    this.broadcastSnapshot(this.options.playerId, game);
  }

  broadcastSnapshot(playerId: string, game: OnlineGameSnapshot): void {
    const message = JSON.stringify({ type: 'snapshot', playerId, seed: game.seed, game } satisfies OnlinePeerSnapshotMessage);
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

  sendAttackIntent(toPlayerId: string, intent: Omit<OnlinePeerAttackIntentMessage, 'type'>): boolean {
    const peer = this.peers.get(toPlayerId);
    if (peer?.channel?.readyState !== 'open') return false;
    peer.channel.send(JSON.stringify({ ...intent, type: 'attackIntent' } satisfies OnlinePeerAttackIntentMessage));
    return true;
  }

  sendInputs(toPlayerId: string, inputs: GameInput[], seed?: number): boolean {
    const peer = this.peers.get(toPlayerId);
    if (peer?.channel?.readyState !== 'open') return false;
    peer.channel.send(JSON.stringify({
      type: 'input',
      playerId: this.options.playerId,
      seed,
      inputs,
    } satisfies OnlinePeerInputMessage));
    return true;
  }

  broadcastKo(report: Omit<OnlinePeerKoMessage, 'type'>): void {
    const message = JSON.stringify({ ...report, type: 'ko' } satisfies OnlinePeerKoMessage);
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
      createdAt: Date.now(),
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
      const state = connection.connectionState;
      if (state === 'connected') this.setPeerState(remoteId, 'open');
      else if (state === 'failed') this.recreatePeer(remoteId);
      else if (state === 'closed') this.setPeerState(remoteId, 'closed');
      else if (state === 'disconnected') this.setPeerState(remoteId, 'connecting');
    };
    connection.ondatachannel = (event) => this.attachChannel(remoteId, entry, event.channel);

    if (initiate) {
      // Inputs are deltas: a single dropped packet desyncs the host simulation and
      // can falsely top a player out. Use a reliable, ordered channel so every input
      // (and KO/attack message) is delivered. Snapshots are full-state, latest-wins,
      // so the small ordering latency is harmless here.
      this.attachChannel(remoteId, entry, connection.createDataChannel('stack40-game', { ordered: true }));
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
    try {
      await this.applySignal(signal);
    } catch {
      // Una señal vieja, duplicada o fuera de orden no debe tirar la negociación
      // entera ni quedar como unhandled rejection; la siguiente oferta/answer
      // válida (o recreatePeer en 'failed') recupera la conexión.
    }
  }

  private async applySignal(signal: OnlinePeerSignal): Promise<void> {
    let entry = this.ensurePeer(signal.fromPlayerId, false);
    // A failed/closed connection never recovers on its own. If a peer renegotiates
    // (e.g. after reconnecting), rebuild from a fresh connection before applying signals.
    if (entry.connection.connectionState === 'failed' || entry.connection.connectionState === 'closed') {
      this.closePeer(signal.fromPlayerId);
      entry = this.ensurePeer(signal.fromPlayerId, false);
    }
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
    if (signal.type === 'answer') {
      // Una answer duplicada o de una oferta anterior (p. ej. tras recrear la
      // conexión) llega con la conexión ya en 'stable': setRemoteDescription
      // lanzaría InvalidStateError y dejaría pendingIce sin aplicar, matando el
      // canal de datos (sin snapshots/KO/garbage para ese peer). Se ignora.
      if (entry.connection.signalingState !== 'have-local-offer') return;
    } else if (entry.connection.signalingState !== 'stable') {
      // Glare: llegó una oferta mientras nuestra propia oferta está pendiente.
      // El peer "polite" (el que no inicia) descarta la suya con rollback y
      // contesta; el "impolite" ignora la entrante y espera su answer.
      if (this.shouldInitiate(signal.fromPlayerId)) return;
      await entry.connection.setLocalDescription({ type: 'rollback' });
    }
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
    channel.onmessage = (event) => this.handleChannelMessage(remoteId, event.data);
  }

  private handleChannelMessage(remoteId: string, data: unknown): void {
    if (typeof data !== 'string') return;
    try {
      const message = JSON.parse(data) as OnlinePeerMessage;
      if (message.type === 'snapshot') {
        if (!message.playerId || !message.game) return;
        this.options.onSnapshot(remoteId, message.playerId, message.game);
      }
      if (message.type === 'attack') {
        if (
          !message.attackId
          || !message.authorityPlayerId
          || !message.fromPlayerId
          || !message.toPlayerId
          || !Number.isFinite(message.lines)
          || !Number.isFinite(message.holeSeed)
          || !Number.isFinite(message.frame)
        ) return;
        this.options.onAttack?.(remoteId, message);
      }
      if (message.type === 'attackIntent') {
        if (
          !message.fromPlayerId
          || message.fromPlayerId !== remoteId
          || !message.attackId
          || !Number.isFinite(message.lines)
          || !Number.isFinite(message.holeSeed)
          || !Number.isFinite(message.frame)
        ) return;
        this.options.onAttackIntent?.(remoteId, message);
      }
      if (message.type === 'input') {
        if (
          !message.playerId
          || message.playerId !== remoteId
          || !Array.isArray(message.inputs)
        ) return;
        this.options.onInput?.(remoteId, message);
      }
      if (message.type === 'ko') {
        if (
          !message.playerId
          || !Number.isFinite(message.frame)
          || !Number.isFinite(message.lines)
          || !Number.isFinite(message.pieces)
          || !Number.isFinite(message.elapsedFrames)
        ) return;
        if (message.playerId !== remoteId) return;
        this.options.onKo?.(remoteId, message);
      }
    } catch {
      // Ignore malformed peer messages. The server polling fallback remains authoritative for room state.
    }
  }

  // Recrea conexiones atascadas en negociación más allá del timeout. Se llama
  // desde syncRoom (cada poll de la sala), así no hace falta un timer propio.
  private reviveStalledPeers(): void {
    const now = Date.now();
    for (const [remoteId, peer] of this.peers) {
      if (peer.state === 'open' || peer.channel?.readyState === 'open') continue;
      const cs = peer.connection.connectionState;
      if (cs !== 'new' && cs !== 'connecting' && cs !== 'disconnected') continue;
      if (now - peer.createdAt < PEER_CONNECT_TIMEOUT_MS) continue;
      this.recreatePeer(remoteId);
    }
  }

  private recreatePeer(remoteId: string): void {
    // A failed ICE connection is terminal; drop it and immediately stand up a fresh
    // connection so input flow recovers instead of the host topping the player out.
    if (!this.peers.has(remoteId)) return;
    this.closePeer(remoteId);
    this.ensurePeer(remoteId, this.shouldInitiate(remoteId));
  }

  private closePeer(remoteId: string): void {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    // Detach handlers first so the old connection's deferred 'closed' events can't
    // clobber the state of a replacement connection created right after.
    peer.connection.onicecandidate = null;
    peer.connection.onconnectionstatechange = null;
    peer.connection.ondatachannel = null;
    if (peer.channel) {
      peer.channel.onopen = null;
      peer.channel.onclose = null;
      peer.channel.onmessage = null;
      peer.channel.close();
    }
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
