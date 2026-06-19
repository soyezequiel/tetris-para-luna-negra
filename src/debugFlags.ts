// Flags de logging de diagnóstico, leídos de la URL/localStorage. Apagados por defecto para
// que la consola del jugador esté limpia; se prenden bajo demanda y el flag se persiste en
// localStorage para sobrevivir recargas/navegación entre salas.
function readFlag(param: string, storageKey: string): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(param)) {
      const on = params.get(param) !== '0';
      localStorage.setItem(storageKey, on ? '1' : '0');
      return on;
    }
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

// Logs viejos de diagnóstico multijugador (`[MP ...]`: heartbeat/host-sim/host-input/etc.).
// Eran ruido en la consola durante toda partida online; ahora arrancan APAGADOS. Prenderlos
// con `?mplog=1` (apagar con `?mplog=0`) cuando haga falta investigar un desync/top-out falso.
export const mpLogEnabled = readFlag('mplog', 'stack40.mplog');
