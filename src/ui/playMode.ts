// Modalidad de juego elegida en el dashboard. Vive en su propio módulo para que
// las vistas (src/ui/dashboard/*) y el shell (main.ts) compartan el tipo sin
// crear una dependencia circular.
export type PlayMode = 'survival' | 'custom' | 'local1v1';
