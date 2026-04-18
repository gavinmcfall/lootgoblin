import { templates } from './templates';

export interface InjectSpec {
  button?: { template: string; position: 'append' | 'prepend' | 'topbar'; label: string };
}

const MARKER = 'data-lootgoblin-injected';

export function inject(root: HTMLElement, spec: InjectSpec, onClick?: (root: HTMLElement) => void): void {
  if (root.getAttribute(MARKER)) return;
  if (!spec.button) return;
  const tpl = templates[spec.button.template];
  if (!tpl) return;
  const btn = tpl.render(spec.button.label);
  if (onClick) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(root);
    });
  }
  // Ensure the root is positioned so absolute-positioned button anchors correctly.
  if (spec.button.position !== 'topbar' && getComputedStyle(root).position === 'static') {
    root.style.position = 'relative';
  }
  if (spec.button.position === 'append') root.appendChild(btn);
  else if (spec.button.position === 'prepend') root.insertBefore(btn, root.firstChild);
  else if (spec.button.position === 'topbar') document.body.appendChild(btn);
  root.setAttribute(MARKER, '1');
}
