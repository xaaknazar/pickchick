/** Isolated, synthetic HTML stories; no live server or financial endpoint is used. */
export function surface(kind, render) {
  const document = globalThis.document;
  document
    .querySelectorAll('[data-operation-story],dialog.op-dialog,dialog.password-reset')
    .forEach((n) => n.remove());
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `/${kind}-assets/styles.css`;
  css.dataset.operationStory = '';
  document.head.append(css);
  const root = document.createElement('div');
  root.id = 'app';
  render(root);
  for (const image of root.querySelectorAll('img')) {
    const path = image.getAttribute('src');
    if (path?.startsWith('/')) image.src = '/' + kind + '-assets' + path;
  }
  return root;
}
export const branch = '00000000-0000-4000-8000-000000000001';
export const actor = '00000000-0000-4000-8000-000000000002';
export const rows = [
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Касса Abay Plaza',
    kind: 'edge',
    status: 'active',
    mode: null,
    last_seen_at: '2099-01-01T00:00:00Z',
    key_expires_at: '2099-12-31T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    name: 'iPad у входа',
    kind: 'kiosk',
    status: 'active',
    mode: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    name: 'Горячий цех',
    kind: 'kitchen',
    mode: 'prep',
    status: 'active',
    paired_at: '2026-10-09T05:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Сборка заказов',
    kind: 'kitchen',
    mode: 'assembly',
    status: 'pending',
    command_state: 'applied',
    command_action: 'pair',
    code_expires_at: '2099-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    name: 'Табло выдачи',
    kind: 'display',
    mode: 'display',
    status: 'revoked',
  },
];
