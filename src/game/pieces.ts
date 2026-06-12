import type { PieceType, Rotation, Vec2 } from './types';

export const PIECES: PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

export const PIECE_COLORS: Record<PieceType, number> = {
  I: 0x39c6aa,
  J: 0x6453c5,
  L: 0xd07c3e,
  O: 0xd1bb3f,
  S: 0x93ce49,
  T: 0xbd50c7,
  Z: 0xcf4651,
};

// Paleta para modo daltónico: tonos del set Okabe–Ito, elegidos para ser
// distinguibles entre sí en deuteranopía, protanopía y tritanopía (los tipos
// de daltonismo más comunes). Se usa en lugar de PIECE_COLORS cuando el
// jugador activa el modo daltónico.
export const PIECE_COLORS_COLORBLIND: Record<PieceType, number> = {
  I: 0x56b4e9, // celeste
  J: 0x0072b2, // azul
  L: 0xe69f00, // naranja
  O: 0xf0e442, // amarillo
  S: 0x009e73, // verde azulado
  T: 0xcc79a7, // púrpura rosado
  Z: 0xd55e00, // bermellón
};

const SHAPES: Record<PieceType, Vec2[][]> = {
  I: [
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ],
    [
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ],
  ],
  J: [
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
  ],
  L: [
    [
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  O: [
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
  ],
  S: [
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  T: [
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  Z: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
    ],
  ],
};

export function cellsFor(type: PieceType, rotation: Rotation): Vec2[] {
  return SHAPES[type][rotation];
}

export function nextRotation(rotation: Rotation, dir: 1 | -1 | 2): Rotation {
  return (((rotation + dir) % 4) + 4) % 4 as Rotation;
}

const JLSTZ_KICKS: Record<string, Vec2[]> = {
  '0>1': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: 2 },
    { x: -1, y: 2 },
  ],
  '1>0': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: -2 },
    { x: 1, y: -2 },
  ],
  '1>2': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: -2 },
    { x: 1, y: -2 },
  ],
  '2>1': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: 2 },
    { x: -1, y: 2 },
  ],
  '2>3': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: -1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
  ],
  '3>2': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: -2 },
    { x: -1, y: -2 },
  ],
  '3>0': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: -2 },
    { x: -1, y: -2 },
  ],
  '0>3': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: -1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
  ],
};

const I_KICKS: Record<string, Vec2[]> = {
  '0>1': [
    { x: 0, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 1 },
    { x: 1, y: -2 },
  ],
  '1>0': [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: -1 },
    { x: -1, y: 2 },
  ],
  '1>2': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: -2 },
    { x: 2, y: 1 },
  ],
  '2>1': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 2 },
    { x: -2, y: -1 },
  ],
  '2>3': [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: -1 },
    { x: -1, y: 2 },
  ],
  '3>2': [
    { x: 0, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 1 },
    { x: 1, y: -2 },
  ],
  '3>0': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 2 },
    { x: -2, y: -1 },
  ],
  '0>3': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: -2 },
    { x: 2, y: 1 },
  ],
};

// 180-degree rotation kicks (TETR.IO / SRS+ style), stored in the same
// y-negated convention as the tables above so they apply via `y - kick.y`.
const JLSTZ_180_KICKS: Record<string, Vec2[]> = {
  '0>2': [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
  ],
  '2>0': [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
  ],
  '1>3': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: -2 },
    { x: 1, y: -1 },
    { x: 0, y: -2 },
    { x: 0, y: -1 },
  ],
  '3>1': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: -2 },
    { x: -1, y: -1 },
    { x: 0, y: -2 },
    { x: 0, y: -1 },
  ],
};

const I_180_KICKS: Record<string, Vec2[]> = {
  '0>2': [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: -1 },
  ],
  '2>0': [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 1 },
  ],
  '1>3': [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: -2 },
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: -1, y: 0 },
  ],
  '3>1': [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: -2 },
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 0 },
  ],
};

export function kicksFor(type: PieceType, from: Rotation, to: Rotation): Vec2[] {
  if (type === 'O') return [{ x: 0, y: 0 }];
  const key = `${from}>${to}`;
  const is180 = (from + 2) % 4 === to;
  if (is180) {
    return (type === 'I' ? I_180_KICKS : JLSTZ_180_KICKS)[key] ?? [{ x: 0, y: 0 }];
  }
  return (type === 'I' ? I_KICKS : JLSTZ_KICKS)[key] ?? [{ x: 0, y: 0 }];
}
