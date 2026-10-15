import { ACADEMY_LESSONS, ACADEMY_SCENARIOS, academyItemName, type AcademyItemKind } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { ACTION_QUIZ } from '../src/academy/data/actions';
import { CARD_QUESTIONS } from '../src/academy/data/cards';
import { COMPARE_QUESTIONS, HAND_SORT, NAME_QUESTIONS } from '../src/academy/data/handQuiz';
import { POSITION_QUIZ } from '../src/academy/data/holdem';
import { buildScenarios } from '../src/academy/practice/scenarios';
import { TOPICS } from '../src/academy/progress';
import { questionFor, seeded } from '../src/academy/review';

// The admin console names the anonymous Academy statistics; every id the web app can send must have a name.
const unnamed = (kind: AcademyItemKind, ids: string[]) => ids.filter((id) => !academyItemName(kind, id, 'ko') || !academyItemName(kind, id, 'en'));
const tracked = (q: { id: string; statId?: string }) => (q.statId ?? q.id).slice(0, 48);

describe('academy item names for the admin console', () => {
  it('names every lesson and practice scenario', () => {
    expect(unnamed('lesson', [...ACADEMY_LESSONS])).toEqual([]);
    expect(unnamed('scenario', [...ACADEMY_SCENARIOS, 'free'])).toEqual([]);
  });

  it('names every lesson quiz question', () => {
    const ids = [...CARD_QUESTIONS, ...NAME_QUESTIONS, ...COMPARE_QUESTIONS, HAND_SORT, ...POSITION_QUIZ, ...ACTION_QUIZ].map(tracked);
    expect(ids.length).toBeGreaterThan(20);
    expect(unnamed('question', ids)).toEqual([]);
  });

  it('names the questions asked during practice scenarios', () => {
    const ids = buildScenarios('x').flatMap((sc) => sc.questions.map((_, i) => `practice:${sc.id}:${i}`));
    expect(ids.length).toBeGreaterThan(0);
    expect(unnamed('question', ids)).toEqual([]);
  });

  it('names every review question, whichever variant a seed draws', () => {
    const ids = new Set<string>();
    for (const topic of TOPICS) for (let seed = 1; seed <= 40; seed++) for (let n = 0; n < 8; n++) ids.add(tracked(questionFor(topic, seeded(seed), n)));
    expect(unnamed('question', [...ids])).toEqual([]);
  });

  it('leaves an unknown id unnamed, so the console shows the raw id', () => {
    expect(academyItemName('question', 'not-a-question', 'ko')).toBeNull();
    expect(academyItemName('lesson', 'c-heart', 'en')).toBeNull();
  });
});
