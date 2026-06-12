// Resuelve el frame de engine objetivo para un rAF dado, anclado al reloj real.
//
// P2 (game feel): NUNCA forzamos `currentFrame + 1`. Hacerlo obligaba a un frame de
// engine por cada requestAnimationFrame, así que en un monitor >60Hz el juego entero
// (gravedad, DAS, ARR, lock delay) corría proporcionalmente más rápido (~3× a 180Hz).
//
// Anclando al reloj (real en solo, del server en online) un rAF puede no producir
// frame nuevo: `resolveGameplayFrame(f, f) === f`. El loop detecta ese caso
// (candidateFrame === gameFrame) y conserva los inputs recolectados hasta el próximo
// tick real, en vez de descartarlos o sellarlos a un frame ya pasado.
export function resolveGameplayFrame(currentFrame: number, elapsedFrames: number): number {
  return Math.max(currentFrame, elapsedFrames);
}
