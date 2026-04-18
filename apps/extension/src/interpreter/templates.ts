export interface Template {
  id: string;
  render(label: string): HTMLElement;
}

export const templates: Record<string, Template> = {
  'tag-btn-v1': {
    id: 'tag-btn-v1',
    render(label) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = 'lootgoblin-tag-btn';
      btn.style.cssText =
        'position:absolute;top:8px;right:8px;z-index:99999;padding:4px 10px;border-radius:6px;border:1px solid #10b981;background:rgba(16,185,129,0.15);color:#a7f3d0;font-size:12px;cursor:pointer;font-family:ui-sans-serif,system-ui,sans-serif;';
      return btn;
    },
  },
};
