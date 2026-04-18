import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { extract } from '@/interpreter/extract';

describe('extract', () => {
  it('extracts attr, text, and nested selectors', () => {
    const win = new Window();
    win.document.body.innerHTML = `<div data-model-id="abc"><h3 class="title">Hero</h3><span class="author">Bulka</span><img src="/img.png"></div>`;
    const el = win.document.querySelector('[data-model-id]')!;
    const data = extract(el as unknown as Element, {
      modelId: { attr: 'data-model-id' },
      title: { selector: '.title', text: true },
      designer: { selector: '.author', text: true },
      thumbnail: { selector: 'img', attr: 'src' },
    });
    expect(data.modelId).toBe('abc');
    expect(data.title).toBe('Hero');
    expect(data.designer).toBe('Bulka');
    expect(data.thumbnail).toBe('/img.png');
  });

  it('applies regex to extract capture group', () => {
    const win = new Window();
    win.document.body.innerHTML = `<a href="/models/1234/">x</a>`;
    const el = win.document.querySelector('a')!;
    const data = extract(el as unknown as Element, { id: { attr: 'href', regex: '/models/(\\d+)/?' } });
    expect(data.id).toBe('1234');
  });

  it('returns null for missing targets', () => {
    const win = new Window();
    win.document.body.innerHTML = `<div></div>`;
    const el = win.document.querySelector('div')!;
    const data = extract(el as unknown as Element, { title: { selector: '.missing', text: true } });
    expect(data.title).toBeNull();
  });
});
