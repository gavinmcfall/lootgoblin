import { describe, it, expect, beforeEach } from 'vitest';
import { Window } from 'happy-dom';
import { inject } from '@/interpreter/inject';

describe('inject', () => {
  let win: Window;

  beforeEach(() => {
    win = new Window();
    // @ts-expect-error — happy-dom's document assignable for test scope
    global.document = win.document;
    // @ts-expect-error — happy-dom's getComputedStyle
    global.getComputedStyle = win.getComputedStyle?.bind(win) ?? ((el: Element) => ({ position: 'static' }));
  });

  it('appends a tag button to a root element', () => {
    win.document.body.innerHTML = `<div class="tile"></div>`;
    const el = win.document.querySelector('.tile')!;
    inject(el as unknown as HTMLElement, { button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' } });
    const btn = (el as unknown as HTMLElement).querySelector('.lootgoblin-tag-btn');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Tag');
  });

  it('skips duplicate injection via marker', () => {
    win.document.body.innerHTML = `<div class="tile"></div>`;
    const el = win.document.querySelector('.tile')!;
    inject(el as unknown as HTMLElement, { button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' } });
    inject(el as unknown as HTMLElement, { button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' } });
    const btns = (el as unknown as HTMLElement).querySelectorAll('.lootgoblin-tag-btn');
    expect(btns.length).toBe(1);
  });

  it('noop when template not found', () => {
    win.document.body.innerHTML = `<div class="tile"></div>`;
    const el = win.document.querySelector('.tile')!;
    inject(el as unknown as HTMLElement, { button: { template: 'nonexistent', position: 'append', label: 'X' } });
    expect((el as unknown as HTMLElement).children.length).toBe(0);
  });

  it('fires onClick when button is clicked', () => {
    win.document.body.innerHTML = `<div class="tile"></div>`;
    const el = win.document.querySelector('.tile')!;
    let clicked = false;
    inject(
      el as unknown as HTMLElement,
      { button: { template: 'tag-btn-v1', position: 'append', label: 'Tag' } },
      () => { clicked = true; },
    );
    const btn = (el as unknown as HTMLElement).querySelector('.lootgoblin-tag-btn') as HTMLButtonElement;
    btn.click();
    expect(clicked).toBe(true);
  });
});
