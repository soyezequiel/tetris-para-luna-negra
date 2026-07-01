// Panel lateral de sala del dashboard de escritorio. Vista PURA: no lee estado de
// módulo del shell — todo entra por parámetro. Dos caras:
//   • Sin sala (RoomPanelEmptyData)  → crear sala + salas públicas + unirse por código.
//   • Con sala (RoomPanelActiveData) → cabecera, config, lista de jugadores y acciones.
// Los sub-paneles con estado (error online, toggle de visibilidad, panel de apuesta)
// y los avatares entran ya renderizados como fragmentos HTML; la derivación vive en
// main.ts (orquestador renderDashboardRoomPanel).

import { shieldCrestIcon, shieldSolidIcon } from '../icons';
import { escapeHtml } from '../format';

export interface PublicRoomEntry {
  id: string;
  hostName: string;
  /** Avatar del host ya renderizado (renderOnlineAvatar). */
  avatarHtml: string;
  playerCount: number;
}

export interface RoomPanelEmptyData {
  publicRooms: PublicRoomEntry[];
  /** Código tipeado en el input de "unirse" (controlado por main). */
  joinCode: string;
  /** ¿Hay una operación de red en curso? Deshabilita los botones. */
  busy: boolean;
  /** ¿Estamos en build de desarrollo? Muestra el botón "Partida vs bot (dev)". */
  isDev: boolean;
  /** Error online ya renderizado (renderOnlineError). */
  onlineErrorHtml: string;
  roomIdMaxLength: number;
}

export interface RoomPlayerEntry {
  id: string;
  name: string;
  /** Avatar ya renderizado (renderOnlineAvatar). */
  avatarHtml: string;
  isHost: boolean;
  isSelf: boolean;
  isReady: boolean;
}

export interface RoomPanelActiveData {
  roomId: string;
  isPrivate: boolean;
  /** ¿El jugador local es el anfitrión? */
  host: boolean;
  /** ¿La sala está en lobby (vs ronda en curso)? */
  inLobby: boolean;
  readyCount: number;
  playerCount: number;
  matchText: string;
  statusText: string;
  visibilityText: string;
  speedLevelText: string;
  roomPurposeText: string;
  players: RoomPlayerEntry[];
  /** ¿Se copió recién el link de invitación? (cambia el label del botón) */
  inviteLinkCopied: boolean;
  /** Sin identidad/signer compatible: no se puede invitar, se ofrece iniciar sesión. */
  inviteUnavailable: boolean;
  inviteAction: string;
  inviteLabel: string;
  inviteWindowBusy: boolean;
  busy: boolean;
  onlineErrorHtml: string;
  /** Toggle de visibilidad (solo host en lobby) ya renderizado; '' si no aplica. */
  visibilityToggleHtml: string;
  /** Panel de apuesta online ya renderizado (renderOnlineBetPanel). */
  betPanelHtml: string;
}

// Sala vacía: ícono+"SALA" violeta, título, descripción, "+ Crear sala", divisor y
// la lista de salas públicas. El input por código y el bot dev quedan como utilidades
// secundarias bajo un divisor, sin recargar la jerarquía.
export function renderRoomPanelEmpty({ publicRooms, joinCode, busy, isDev, onlineErrorHtml, roomIdMaxLength }: RoomPanelEmptyData): string {
  const shieldIcon = shieldSolidIcon({ size: 16, ariaHidden: true });
  const publicRoomsHtml = publicRooms.length === 0
    ? '<div class="dash-public-empty">No hay salas públicas activas.</div>'
    : publicRooms.slice(0, 4).map((candidateRoom) => `
        <div class="dash-public-room">
          ${candidateRoom.avatarHtml}
          <span class="dash-public-room-name">Sala de ${escapeHtml(candidateRoom.hostName)}</span>
          <span class="dash-public-room-count">${candidateRoom.playerCount}/4</span>
          <button class="dash-public-room-join" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(candidateRoom.id)}"${busy ? ' disabled' : ''}>Unirse</button>
        </div>
      `).join('');

  return `
      <div class="dash-room-empty">
        <div class="dash-room-empty-head">
          <span class="dash-room-empty-icon">${shieldIcon}</span>
          <span class="dash-room-empty-eyebrow">Sala</span>
        </div>
        <h3 class="dash-room-empty-title">Jugá con amigos</h3>
        <p class="dash-room-empty-desc">Creá una sala y compartí el link. Cualquiera entra y la batalla arranca con 2+ jugadores.</p>

        ${onlineErrorHtml}

        <button class="dash-room-create-btn" type="button" data-ui-action="online-create"${busy ? ' disabled' : ''}>+ Crear sala</button>
        ${isDev ? `<button class="dash-room-devbot-btn" type="button" data-ui-action="dev-bot-match"${busy ? ' disabled' : ''}>Partida vs bot (dev)</button>` : ''}

        <div class="dash-room-empty-divider"></div>

        <div class="dash-room-empty-section-head">
          <span>Salas públicas</span>
          <button class="dash-room-empty-refresh" type="button" data-ui-action="online-refresh"${busy ? ' disabled' : ''}>Actualizar</button>
        </div>
        <div class="dash-public-rooms">${publicRoomsHtml}</div>

        <div class="dash-room-empty-divider"></div>

        <label class="dash-room-empty-join-label" for="dash-code-input">Unirse con código</label>
        <div class="dash-join-row">
          <input id="dash-code-input" class="dash-input" type="text" style="text-transform: uppercase;" placeholder="CÓDIGO" maxlength="${roomIdMaxLength}" value="${escapeHtml(joinCode)}" data-online-field="join-code" autocomplete="off" />
          <button class="dash-action-btn accent" type="button" style="width: auto; padding: 8px 16px;" data-ui-action="online-join"${busy ? ' disabled' : ''}>Unirse</button>
        </div>
      </div>
    `;
}

// Sala activa: cabecera con código+invitaciones, línea de estado, propósito, resumen
// de config, lista de jugadores, panel de apuesta y acciones.
export function renderRoomPanelActive(data: RoomPanelActiveData): string {
  const {
    roomId, isPrivate, host, inLobby, readyCount, playerCount, matchText, statusText,
    visibilityText, speedLevelText, roomPurposeText, players, inviteLinkCopied,
    inviteUnavailable, inviteAction, inviteLabel, inviteWindowBusy, busy, onlineErrorHtml, visibilityToggleHtml, betPanelHtml,
  } = data;
  const roomPurposeIcon = shieldCrestIcon({ size: 16, ariaHidden: true });

  const playersHtml = players.map((candidate) => `
      <div class="dash-player-card ${candidate.isSelf ? 'is-self' : ''} ${candidate.isReady ? 'is-ready' : ''}">
        <div class="dash-player-info">
          <div class="dash-player-avatar-wrap">
            ${candidate.avatarHtml}
          </div>
          <div class="dash-player-copy">
            <span class="dash-player-name">${escapeHtml(candidate.name)}${candidate.isSelf ? ' (Tú)' : ''}</span>
            <span class="dash-player-role">${candidate.isHost ? 'Anfitrión' : candidate.isSelf ? 'Tu jugador' : 'Invitado'}</span>
          </div>
        </div>
        <div class="dash-player-actions">
          ${candidate.isSelf && inLobby
            ? (candidate.isReady
              ? '<button class="dash-player-ready-btn is-ready" type="button" data-ui-action="online-unready">Listo ✓</button>'
              : '<button class="dash-player-ready-btn" type="button" data-ui-action="online-ready">Marcar listo</button>')
            : (candidate.isReady
              ? '<span class="dash-player-ready-indicator ready">Listo</span>'
              : '<span class="dash-player-ready-indicator waiting">Sin listo</span>')}
          ${host && !candidate.isSelf
            ? `<button class="dash-copy-btn dash-kick-btn" type="button" data-ui-action="online-kick" data-target-player-id="${escapeHtml(candidate.id)}">Sacar</button>`
            : ''}
        </div>
      </div>
    `).join('');

  const inviteButtonsHtml = `
    <button class="dash-copy-btn" type="button" data-ui-action="online-copy-invite-link">${inviteLinkCopied ? '¡Link copiado!' : 'Copiar link'}</button>
    ${inviteUnavailable
      ? `<button class="dash-copy-btn" type="button" data-ui-action="luna-login"${busy || inviteWindowBusy ? ' disabled' : ''}>${inviteWindowBusy ? 'Abriendo...' : 'Iniciar sesión'}</button>`
      : `<button class="dash-copy-btn" type="button" data-ui-action="${escapeHtml(inviteAction)}"${busy || inviteWindowBusy ? ' disabled' : ''}>${inviteWindowBusy ? 'Abriendo...' : escapeHtml(inviteLabel)}</button>`}
  `;

  return `
    <div class="dash-room-header dash-room-header-active">
      <div class="dash-room-title-area">
        <div class="dash-room-code-wrapper">
          <div class="dash-room-identity-line">
            <span class="dash-room-eyebrow">${escapeHtml(isPrivate ? 'SALA PRIVADA' : 'SALA PÚBLICA')}</span>
            <h2 class="dash-room-code">${escapeHtml(roomId)}</h2>
          </div>
          <div class="dash-room-code-actions">
            <button class="dash-copy-btn" type="button" data-ui-action="online-copy-code" data-code="${escapeHtml(roomId)}">Copiar</button>
            ${inviteButtonsHtml}
          </div>
        </div>
      </div>
      <div class="dash-ready-stack">
        <span class="dash-player-ready-indicator ready">${readyCount}/${playerCount}</span>
        <span>listos</span>
      </div>
    </div>

    <div class="dash-room-status-line">
      <span>${escapeHtml(matchText)}</span>
      <span>${escapeHtml(statusText)}</span>
    </div>

    <div class="dash-room-purpose">
      <div class="dash-room-purpose-top">
        <span class="dash-room-purpose-icon">${roomPurposeIcon}</span>
        <strong>${host ? 'Control de anfitrión' : 'Tu lugar en la sala'}</strong>
      </div>
      <p class="dash-room-purpose-explainer">${escapeHtml(roomPurposeText)}</p>
    </div>

    <div class="dash-room-summary" aria-label="Configuración de sala">
      <div class="dash-room-summary-item">
        <span>Tipo</span>
        <strong>${escapeHtml(matchText)}</strong>
      </div>
      <div class="dash-room-summary-item">
        <span>Visibilidad</span>
        <strong>${escapeHtml(visibilityText)}</strong>
      </div>
      <div class="dash-room-summary-item">
        <span>Velocidad</span>
        <strong>${escapeHtml(speedLevelText)}</strong>
      </div>
    </div>

    ${onlineErrorHtml}

    ${visibilityToggleHtml}

    <section class="dash-room-section">
      <div class="dash-section-header">
        <span>Jugadores</span>
        <small>${readyCount}/${playerCount} listos</small>
      </div>
      <div class="dash-player-list">
        ${playersHtml}
      </div>
    </section>

    ${betPanelHtml}

    <div class="dash-room-actions-group">
      ${inLobby
        ? (host ? `<span class="dash-room-start-hint" style="align-self: center; color: var(--dash-text-dim); font-size: 12px; font-weight: 600;">El host arranca con el botón central</span>` : '')
        : '<button class="dash-action-btn" type="button" disabled>Ronda en curso…</button>'}
      <button class="dash-action-btn danger" type="button" data-ui-action="online-leave">Salir de la sala</button>
    </div>
  `;
}
