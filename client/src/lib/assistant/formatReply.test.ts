import { describe, expect, it } from 'vitest';
import { formatReply } from './formatReply';

describe('formatReply', () => {
  it('lays out a plan in the shape the system prompt asks for', () => {
    const reply = [
      "I've assumed you're a beginner training for general fitness.",
      '',
      'Monday — Upper body:',
      '- Push-ups: 3 sets of 10',
      '- Dumbbell rows: 3 x 12',
      '',
      'Wednesday — Lower body:',
      '- Squats 3x10',
      '- Lunges 3x8 each leg',
      '',
      'Rest on the other days.',
      'Add a rep each week.',
    ].join('\n');

    expect(formatReply(reply)).toEqual([
      { kind: 'paragraph', text: "I've assumed you're a beginner training for general fitness." },
      { kind: 'heading', text: 'Monday — Upper body' },
      { kind: 'list', ordered: false, items: ['Push-ups: 3 sets of 10', 'Dumbbell rows: 3 x 12'] },
      { kind: 'heading', text: 'Wednesday — Lower body' },
      { kind: 'list', ordered: false, items: ['Squats 3x10', 'Lunges 3x8 each leg'] },
      { kind: 'paragraph', text: 'Rest on the other days.\nAdd a rep each week.' },
    ]);
  });

  it('turns CRLF into the same blocks as LF', () => {
    expect(formatReply('Monday:\r\n- Squats\r\n\r\nRest.')).toEqual(
      formatReply('Monday:\n- Squats\n\nRest.'),
    );
    expect(formatReply('Monday:\r\n- Squats\r\n\r\nRest.')).toHaveLength(3);
  });

  it('separates blocks on blank lines, including whitespace-only ones', () => {
    expect(formatReply('First thought.\n   \nSecond thought.')).toEqual([
      { kind: 'paragraph', text: 'First thought.' },
      { kind: 'paragraph', text: 'Second thought.' },
    ]);
  });

  describe('lists', () => {
    it('accepts -, * and • bullets', () => {
      expect(formatReply('- one\n* two\n• three')).toEqual([
        { kind: 'list', ordered: false, items: ['one', 'two', 'three'] },
      ]);
    });

    it('accepts 1. and 1) numbering', () => {
      expect(formatReply('1. Warm up\n2) Squat\n10. Stretch')).toEqual([
        { kind: 'list', ordered: true, items: ['Warm up', 'Squat', 'Stretch'] },
      ]);
    });

    it('starts a new list when the kind of list changes', () => {
      expect(formatReply('- a\n1. b')).toEqual([
        { kind: 'list', ordered: false, items: ['a'] },
        { kind: 'list', ordered: true, items: ['b'] },
      ]);
    });

    it('joins an indented continuation line onto the item above it', () => {
      expect(formatReply('- Squats 3x10\n  keep your back straight\nThen rest.')).toEqual([
        { kind: 'list', ordered: false, items: ['Squats 3x10 keep your back straight'] },
        { kind: 'paragraph', text: 'Then rest.' },
      ]);
    });

    it('ends a paragraph when a list starts without a blank line', () => {
      expect(formatReply('Try these:\n- Plank')).toEqual([
        { kind: 'heading', text: 'Try these' },
        { kind: 'list', ordered: false, items: ['Plank'] },
      ]);
      expect(formatReply('Try these today\n- Plank')).toEqual([
        { kind: 'paragraph', text: 'Try these today' },
        { kind: 'list', ordered: false, items: ['Plank'] },
      ]);
    });

    it('does not mistake a bold line or 3*10 for a bullet', () => {
      expect(formatReply('Do 3*10 reps')).toEqual([{ kind: 'paragraph', text: 'Do 3*10 reps' }]);
    });
  });

  describe('headings', () => {
    it('reads markdown # headings', () => {
      expect(formatReply('### Monday\n- Squats')).toEqual([
        { kind: 'heading', text: 'Monday' },
        { kind: 'list', ordered: false, items: ['Squats'] },
      ]);
    });

    it('reads a line wrapped entirely in bold, with or without a colon', () => {
      expect(formatReply('**Tuesday:**\n__Thursday__\n**Friday**:')).toEqual([
        { kind: 'heading', text: 'Tuesday' },
        { kind: 'heading', text: 'Thursday' },
        { kind: 'heading', text: 'Friday' },
      ]);
    });

    it('does not treat a line that merely contains bold as a heading', () => {
      expect(formatReply('**Monday** and **Friday** are rest days')).toEqual([
        { kind: 'paragraph', text: 'Monday and Friday are rest days' },
      ]);
      expect(formatReply('**Note:** drink water')).toEqual([
        { kind: 'paragraph', text: 'Note: drink water' },
      ]);
    });

    it('reads a short line ending in a colon, up to 60 characters', () => {
      const sixty = 'x'.repeat(59) + ':';
      expect(formatReply(sixty)).toEqual([{ kind: 'heading', text: 'x'.repeat(59) }]);
    });

    it('keeps a longer line ending in a colon as a paragraph', () => {
      const long = 'x'.repeat(60) + ':';
      expect(formatReply(long)).toEqual([{ kind: 'paragraph', text: long }]);
    });
  });

  describe('markdown the prompt forbids but a model may still send', () => {
    it('strips inline bold, underline-bold, emphasis and backticks', () => {
      expect(formatReply('Do **3 sets** of __10__, *slowly*, with `good form`')).toEqual([
        { kind: 'paragraph', text: 'Do 3 sets of 10, slowly, with good form' },
      ]);
    });

    it('reduces a link to its text', () => {
      expect(formatReply('See [the squat guide](https://example.com/squat) first')).toEqual([
        { kind: 'paragraph', text: 'See the squat guide first' },
      ]);
    });

    it('drops horizontal rules and code fences, keeping what was inside', () => {
      expect(formatReply('Monday:\n- Squats\n---\n```text\nwarm up first\n```\n***')).toEqual([
        { kind: 'heading', text: 'Monday' },
        { kind: 'list', ordered: false, items: ['Squats'] },
        { kind: 'paragraph', text: 'warm up first' },
      ]);
    });

    it('cleans bullets and headings too', () => {
      expect(formatReply('## **Leg day**\n* **Squat** 3x10')).toEqual([
        { kind: 'heading', text: 'Leg day' },
        { kind: 'list', ordered: false, items: ['Squat 3x10'] },
      ]);
    });
  });

  it('returns nothing for an empty reply, and only strings in what it returns', () => {
    expect(formatReply('')).toEqual([]);
    expect(formatReply('  \n \n')).toEqual([]);
    const blocks = formatReply('# <b>Hi</b>\n- <img src=x onerror=alert(1)>');
    // Markup is not interpreted here — it comes out as text for React to escape.
    expect(blocks).toEqual([
      { kind: 'heading', text: '<b>Hi</b>' },
      { kind: 'list', ordered: false, items: ['<img src=x onerror=alert(1)>'] },
    ]);
  });
});
