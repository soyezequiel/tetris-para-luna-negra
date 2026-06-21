// Estado de red del multijugador online: el "cableado" de sincronización con el
// server/peers. Tres sub-dominios cohesivos del clúster online-net (el resto —room,
// host-authority, peers, attacks, round, death— vive en otros objetos de PR7):
//  - onlineNetState: locks de request en vuelo + timestamps de poll/progress/report.
//  - onlineClockState: reloj del server anclado a un reloj local monotónico.
//  - onlineFailoverState: detección de host caído y pedido de migración de autoridad.
// Objetos mutables fuera de main.ts, igual que el resto de PR7.

export interface OnlineNetState {
  error: string | null;
  // Lock general de operaciones online (el polling lo toma; ver onlineBusy histórico).
  busy: boolean;
  pollInFlight: boolean;
  progressInFlight: boolean;
  lastPollAt: number;
  lastProgressAt: number;
  selfReportInFlight: boolean;
  lastSelfReportAt: number;
  lastPeerBroadcastAt: number;
  lastKoBroadcastAt: number;
  // Última vez que se logueó diagnóstico de lag MP (throttle del log).
  lastDiagLogAt: number;
  // Timer de debounce para re-enviar las reglas custom a la sala como host (350ms).
  rulesSyncTimer: ReturnType<typeof setTimeout> | null;
}

export const onlineNetState: OnlineNetState = {
  error: null,
  busy: false,
  pollInFlight: false,
  progressInFlight: false,
  lastPollAt: 0,
  lastProgressAt: 0,
  selfReportInFlight: false,
  lastSelfReportAt: 0,
  lastPeerBroadcastAt: 0,
  lastKoBroadcastAt: 0,
  lastDiagLogAt: 0,
  rulesSyncTimer: null,
};

// Reloj del servidor anclado a un reloj LOCAL MONOTÓNICO (performance.now()), no a
// Date.now(): Date.now() puede saltar por ajustes del SO/NTP y es de baja resolución,
// lo que metía jitter en el frame del motor en online (engineFps saltando 44↔76 con
// fps=180). `serverOffsetMs` es el efectivo (suavizado); `serverOffsetTargetMs` el
// crudo del último sync. Inicializados a (Date.now - performance.now) para que antes
// del primer sync onlineNowMs() ≈ Date.now().
const initialServerOffsetMs = Date.now() - performance.now();

export interface OnlineClockState {
  serverOffsetMs: number;
  serverOffsetTargetMs: number;
  // Primer sync con el server → snap directo.
  synced: boolean;
  // performance.now() del último slew (ver slewOnlineClock).
  lastSlewAt: number;
  // |Δ| del snap ocurrido en este frame (0 = no hubo). Diagnóstico de lag MP: cada snap
  // (salto > ONLINE_CLOCK_SNAP_MS) es un "momento de lag" percibido aunque el frame sea
  // barato; el probe los cuenta (ver perfEndFrame / perf:spike).
  snapMsThisFrame: number;
}

export const onlineClockState: OnlineClockState = {
  serverOffsetMs: initialServerOffsetMs,
  serverOffsetTargetMs: initialServerOffsetMs,
  synced: false,
  lastSlewAt: 0,
  snapMsThisFrame: 0,
};

export interface OnlineFailoverState {
  hostChannelDownSince: number;
  requestInFlight: boolean;
  lastRequestAt: number;
}

export const onlineFailoverState: OnlineFailoverState = {
  hostChannelDownSince: 0,
  requestInFlight: false,
  lastRequestAt: 0,
};
