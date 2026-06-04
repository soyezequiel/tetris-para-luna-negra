import type { MusicTrack } from './SoundEngine';

const MUSIC_BASE_PATH = '/audio/music';

export const MUSIC_TRACKS: MusicTrack[] = [
  { title: 'Tetris Theme Reworked', src: `${MUSIC_BASE_PATH}/tetris-theme-reworked.m4a` },
  { title: 'Stacking Squares', src: `${MUSIC_BASE_PATH}/stacking-squares.m4a` },
  { title: 'Puzzle Piece', src: `${MUSIC_BASE_PATH}/puzzle-piece.m4a` },
  { title: 'Fall Into Place', src: `${MUSIC_BASE_PATH}/fall-into-place.m4a` },
  { title: 'Benevolence', src: `${MUSIC_BASE_PATH}/benevolence.m4a` },
  { title: 'Farewell of Slavianka', src: `${MUSIC_BASE_PATH}/farewell-of-slavianka.m4a` },
  { title: 'Schneidig vor, Op. 79', src: `${MUSIC_BASE_PATH}/schneidig-vor-op-79.m4a` },
  { title: 'Two Tribes (feat. Kevin Blumenfeld)', src: `${MUSIC_BASE_PATH}/two-tribes.m4a` },
  { title: 'Heart Of Glass', src: `${MUSIC_BASE_PATH}/heart-of-glass.m4a` },
  { title: 'Heart Of Glass (Russian)', src: `${MUSIC_BASE_PATH}/heart-of-glass-russian.m4a` },
  { title: 'Holding Out For A Hero (Russian)', src: `${MUSIC_BASE_PATH}/holding-out-for-a-hero-russian.m4a` },
  {
    title: 'Holding Out For A Hero (Japanese)',
    src: `${MUSIC_BASE_PATH}/holding-out-for-a-hero-japanese.m4a`,
  },
  { title: "Opportunities (Let's Make Lots of Money)", src: `${MUSIC_BASE_PATH}/opportunities.m4a` },
  { title: 'The Final Countdown (Trailer Music)', src: `${MUSIC_BASE_PATH}/the-final-countdown-trailer.m4a` },
];
