// Etapa central "Jugar" del dashboard de escritorio. Vista PURA: no lee ningún
// estado de módulo del shell — todo entra por parámetro. Tiene dos caras:
//   • Sin sala  → selector de modalidad (renderModeSelectStage): tarjetas +
//     detalle del modo + CTA solo. La derivación (chips custom, tops de
//     Supervivencia) la hace main.ts y entra ya renderizada/calculada.
//   • Con sala  → etapa "listo para jugar" (renderSmartPlayStage): el copy y el
//     botón dependen del contexto (esperando rivales / host / invitado), que
//     main.ts deriva del estado de la sala y pasa como `ctx`.

import { playModeMeta, modeAccent, renderModeCard } from './modeCard';
import { playIcon, rocketIcon, checkIcon } from '../icons';
import { escapeHtml } from '../format';
import type { PlayMode } from '../playMode';

export interface ModeSelectData {
  /** Modalidad seleccionada (define tarjeta activa, detalle y acción del CTA). */
  mode: PlayMode;
  /** Chips de la config custom (Gravedad · Objetivo · Hold · Next). Solo modo custom. */
  customChips: Array<{ k: string; v: string }>;
  /** Tops embebidos de Supervivencia ya renderizados. Solo modo survival. */
  survivalTopsHtml: string;
}

export interface SmartPlayRoomData {
  /** Contexto del botón inteligente, derivado del estado de la sala. */
  ctx: 'waiting' | 'host' | 'guest';
  /** Modalidad de la sala en mayúsculas (p.ej. "BATALLA"), para el eyebrow. */
  roomModeName: string;
  /** ¿El jugador local está marcado listo? */
  ready: boolean;
  /** Cantidad de jugadores listos en la sala. */
  readyCount: number;
  /** Total de jugadores en la sala. */
  total: number;
  /** Tarjetas de modalidad (solo host en lobby) ya renderizadas; '' si no aplica. */
  modeCardsHtml: string;
}

// Selector de modalidad (sin sala): tarjetas Supervivencia / Custom / 1v1 local.
// La tarjeta activa define qué arranca el botón ▶ en solo y el matchType al crear
// sala. La de Supervivencia muestra además los tops embebidos.
export function renderModeSelectStage({ mode, customChips, survivalTopsHtml }: ModeSelectData): string {
  const meta = playModeMeta(mode);
  const accent = modeAccent(mode);
  const cards = (['survival', 'custom', 'local1v1'] as PlayMode[])
    .map((m) => renderModeCard(m, m === mode))
    .join('');

  const primaryAction = mode === 'local1v1' ? 'local-versus' : 'sidebar-play';
  const chipsHtml = `<div class="dash-mode-chips">${customChips.map((c) => `<span class="dash-mode-chip"><strong>${c.k}</strong><span>${escapeHtml(c.v)}</span></span>`).join('')}</div>`;
  const customExtra = mode === 'custom'
    ? `${chipsHtml}
       <button class="dash-mode-config-btn" type="button" data-ui-action="custom-open">⚙ Configurar partida</button>`
    : '';
  const tops = mode === 'survival' ? survivalTopsHtml : '';

  return `
    <div class="dash-play-stage dash-play-stage--mode-select dash-mode-select" style="--stage-accent: ${accent};">
      <div class="dash-mode-select-inner">
        <div class="dash-play-eyebrow dash-mode-step-eyebrow">1 · Elegí cómo jugar</div>
        <div class="dash-mode-cards" role="tablist">${cards}</div>
        <div class="dash-mode-divider"></div>
        <div class="dash-mode-tag">${escapeHtml(meta.tag)}</div>
        <h2 class="dash-mode-name">${meta.name}</h2>
        <p class="dash-mode-desc">${meta.desc}</p>
        <div class="dash-mode-action-col">
          <button class="dash-mode-solo-cta" type="button" data-ui-action="${primaryAction}" aria-label="${meta.solo}">
            ${playIcon({ size: 20, ariaHidden: true })}
            <span class="dash-mode-solo-text"><span>${meta.solo}</span><span class="dash-mode-solo-sub">${escapeHtml(meta.sub)}</span></span>
          </button>
          ${customExtra}
          <p class="dash-mode-hint">¿Jugar con amigos? Creá una sala en el panel de la derecha y se vuelve multijugador. →</p>
        </div>
        ${tops}
      </div>
    </div>
  `;
}

// Etapa "listo para jugar" (con sala). El copy y el botón dependen del contexto.
export function renderSmartPlayStage({ ctx, roomModeName, ready, readyCount, total, modeCardsHtml }: SmartPlayRoomData): string {
  let accent = '#00f5ff';
  let eyebrow = 'SALA';
  let step2 = 'JUGÁ';
  let title = 'Listo para jugar';
  let subtitle = 'Tocá jugar y empezás una partida al instante.';
  let playHtml = '';
  const secondaryHtml = '';

  if (ctx === 'waiting') {
    accent = '#ffb627'; eyebrow = `SALA ${roomModeName} · ESPERANDO`; step2 = 'ESPERÁ RIVALES';
    title = 'Esperando a que lleguen';
    subtitle = 'Sos el único en la sala. Invitá amigos desde el panel de la derecha — la partida arranca cuando haya al menos 2 jugadores.';
    playHtml = `
      <div class="dash-smart-play dash-smart-play--waiting" role="status">
        <span class="dash-smart-spinner" aria-hidden="true"></span>
        <span class="dash-smart-play-text"><strong>ESPERANDO JUGADORES</strong><small>Faltan rivales<span class="dash-dots"><i></i><i></i><i></i></span></small></span>
      </div>`;
  } else if (ctx === 'host') {
    accent = '#c79bff'; eyebrow = `SALA ${roomModeName} · SOS EL ANFITRIÓN`; step2 = 'EMPEZÁ';
    // El host arranca la ronda (acción 'online-start'). El server exige host listo
    // + ≥2 listos, así que el botón se deshabilita hasta cumplirlo. Marcarse listo
    // se hace desde el panel de sala (online-ready/online-unready).
    const canStart = ready && readyCount >= 2;
    const startTitle = !ready
      ? 'Marcate listo en el panel para empezar'
      : (readyCount < 2 ? 'Esperá a que haya 2 jugadores listos' : 'Empezar partida');
    title = '¡Ya pueden jugar!';
    subtitle = canStart
      ? 'Cuando estén todos listos, arrancá la partida. Vos controlás el inicio.'
      : (!ready
        ? 'Marcate listo en el panel de la derecha para poder arrancar.'
        : 'Necesitás al menos 2 jugadores listos para arrancar.');
    playHtml = `
      <button class="dash-smart-play dash-smart-play--host" type="button" data-ui-action="online-start" aria-label="${startTitle}" title="${startTitle}"${canStart ? '' : ' disabled'}>
        <span class="dash-smart-play-icon">${rocketIcon()}</span>
        <span class="dash-smart-play-text"><strong>EMPEZAR PARTIDA</strong><small>${readyCount}/${total} listos · multijugador</small></span>
      </button>`;
  } else { // guest
    accent = ready ? '#39d49a' : '#ffb627';
    eyebrow = `SALA ${roomModeName} · ESPERANDO AL ANFITRIÓN`;
    step2 = ready ? '¡LISTO!' : 'MARCÁ LISTO';
    title = ready ? 'Estás listo' : 'Marcá que estás listo';
    subtitle = ready
      ? 'La partida arranca apenas el anfitrión la inicie. Podés cambiar de opinión cuando quieras.'
      : 'Confirmá que estás listo — el anfitrión arranca cuando todos lo estén.';
    playHtml = `
      <button class="dash-smart-play ${ready ? 'dash-smart-play--ready' : 'dash-smart-play--guest'}" type="button" data-ui-action="sidebar-play" aria-pressed="${ready}" aria-label="${ready ? 'Quitar listo' : 'Estoy listo'}">
        <span class="dash-smart-play-icon">${checkIcon()}</span>
        <span class="dash-smart-play-text"><strong>${ready ? '¡LISTO!' : 'ESTOY LISTO'}</strong><small>${ready ? 'Esperando al anfitrión…' : 'Tocá para confirmar'}</small></span>
      </button>`;
  }

  return `
    <div class="dash-play-stage" style="--stage-accent: ${accent};">
      <div class="dash-step-pills">
        <span class="dash-step-pill is-active">1 · ELEGÍ CÓMO JUGAR</span>
        <span class="dash-step-sep"></span>
        <span class="dash-step-pill is-active">2 · ${step2}</span>
      </div>
      ${modeCardsHtml}
      <div class="dash-play-eyebrow">${eyebrow}</div>
      <h2 class="dash-play-title">${title}</h2>
      <p class="dash-play-subtitle">${subtitle}</p>
      <div class="dash-play-cta">${playHtml}</div>
      ${secondaryHtml ? `<div class="dash-play-secondary">${secondaryHtml}</div>` : ''}
    </div>
  `;
}
