import { KioskIncidentsView } from './KioskIncidentsView.js';
import { KioskIncidentsModel } from '../kiosk-incidents-model.js';
import { surface, branch, actor } from '../../../operations-storybook/surface.mjs';
export default { title: 'Backoffice/KioskIncidents' };
// Audit 19.10, finding 4.3: a kiosk stuck on an unknown QR payment, released from the cabinet.
function render(role = 'manager', empty = false) {
  return surface('backoffice', (root) => {
    const css = globalThis.document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/backoffice-assets/device-center.css';
    css.dataset.operationStory = '';
    globalThis.document.head.append(css);
    const started = new Date(Date.now() - 23 * 60000).toISOString();
    const snapshot = {
      role,
      min_age_minutes: 15,
      candidates: empty
        ? []
        : [
            {
              order_id: '00000000-0000-4000-8000-0000000000a1',
              attempt_id: '00000000-0000-4000-8000-0000000000b1',
              total_minor: '419000',
              order_state: 'sending',
              attempt_state: 'unknown',
              qr_state: 'unknown',
              has_operation_id: true,
              issue_started_at: started,
              created_at: started,
            },
          ],
      accepted: [
        {
          order_id: '00000000-0000-4000-8000-0000000000a2',
          attempt_id: '00000000-0000-4000-8000-0000000000b2',
          reason: 'bank_identity_lost',
          note: 'Гость ушёл, оплаты в Kaspi Pay нет',
          accepted_at: started,
          accepted_by_name: 'Управляющий',
          attempt_state: 'unknown',
          kaspi_check: 'payment_not_found',
        },
      ],
    };
    const model = new KioskIncidentsModel(
      async () => snapshot,
      () => {
        root.replaceChildren();
        view.render(root);
      },
    );
    model.actor = actor;
    model.branch = branch;
    model.data = snapshot;
    const view = new KioskIncidentsView(model);
    view.render(root);
  });
}
export const Manager = { render: () => render() };
export const Analyst = { render: () => render('analyst') };
export const Nothing = { render: () => render('manager', true) };
