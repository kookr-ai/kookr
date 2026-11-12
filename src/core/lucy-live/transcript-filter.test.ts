import { describe, expect, it } from 'vitest';
import { isEmptyTranscript } from './transcript-filter.js';

describe('isEmptyTranscript', () => {
  it.each(['', '  ', '.', 'a', '...?', '12', 'Merci.', 'merci !', "Sous-titrage ST' 501", 'Sous-titres réalisés par la communauté', 'Thank you.', 'THANK YOU', 'Thanks for watching!', "Merci d'avoir regardé cette vidéo.", 'Merci d’avoir regardé cette vidéo', 'Subtitles by the Amara.org community'])(
    'treats %j as empty', (t) => expect(isEmptyTranscript(t)).toBe(true));

  it.each(['Which tasks need me?', 'Thank you for the update, what is running?', 'Quelles tâches tournent ?', 'ok so what failed'])(
    'keeps %j', (t) => expect(isEmptyTranscript(t)).toBe(false));
});
