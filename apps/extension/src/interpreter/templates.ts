export interface Template {
  id: string;
  render(label: string): HTMLElement;
}

export const templates: Record<string, Template> = {
  // Solid green pill at the bottom-right of a card. The card element must
  // have position:relative (the inject engine sets it on non-static roots).
  'tag-btn-v1': {
    id: 'tag-btn-v1',
    render(label) {
      const btn = document.createElement('button');
      btn.textContent = '🎯 ' + label;
      btn.className = 'lootgoblin-tag-btn';
      btn.style.cssText = [
        'position:absolute',
        'bottom:8px',
        'right:8px',
        'z-index:99999',
        'padding:6px 12px',
        'border-radius:6px',
        'border:none',
        'background:#10b981',
        'color:#ffffff',
        'font-size:12px',
        'font-weight:500',
        'cursor:pointer',
        'font-family:ui-sans-serif,system-ui,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
        'line-height:1',
      ].join(';');
      btn.onmouseenter = () => (btn.style.background = '#059669');
      btn.onmouseleave = () => (btn.style.background = '#10b981');
      return btn;
    },
  },
  // Fixed-position floating button for detail pages — always visible regardless
  // of scroll. Appended to document.body when a trigger uses position:'topbar'.
  'tag-btn-floating': {
    id: 'tag-btn-floating',
    render(label) {
      const btn = document.createElement('button');
      btn.textContent = '🎯 ' + label;
      btn.className = 'lootgoblin-tag-btn';
      btn.style.cssText = [
        'position:fixed',
        'top:80px',
        'right:24px',
        'z-index:99999',
        'padding:10px 18px',
        'border-radius:9999px',
        'border:none',
        'background:#10b981',
        'color:#ffffff',
        'font-size:14px',
        'font-weight:600',
        'cursor:pointer',
        'font-family:ui-sans-serif,system-ui,sans-serif',
        'box-shadow:0 4px 14px rgba(0,0,0,0.4)',
        'line-height:1',
      ].join(';');
      btn.onmouseenter = () => (btn.style.background = '#059669');
      btn.onmouseleave = () => (btn.style.background = '#10b981');
      return btn;
    },
  },
};
