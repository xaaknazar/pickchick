import { DeviceAccessView } from './DeviceAccessView.js';
import { DevicesModel } from '../devices-model.js';
import { surface, rows, branch, actor } from '../../../operations-storybook/surface.mjs';
export default { title: 'Backoffice/Devices' };
function render(role = 'manager', showCode = false) {
  return surface('backoffice', (root) => {
    const css = globalThis.document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/backoffice-assets/device-center.css';
    css.dataset.operationStory = '';
    globalThis.document.head.append(css);
    const now = new Date().toISOString();
    const devices = rows.map((d, i) => ({
      ...d,
      inventory_revision: 0,
      location: i === 0 ? 'Кассовая зона' : '',
      last_seen_at: i === 0 ? now : null,
      edge_last_seen_at: now,
      presence: [1, 2].includes(i)
        ? {
            observed_at: now,
            state: 'active',
            issue: 'none',
            app_version: i === 1 ? '0.1.0 (15)' : null,
            menu_version: 10,
          }
        : null,
    }));
    devices.push({
      id: '00000000-0000-4000-8000-000000000008',
      name: 'Меню над кассой',
      kind: 'usb_tv',
      status: 'unmonitored',
      location: 'Зал',
      inventory_revision: 1,
      archived: false,
    });
    const snapshot = {
      branch_id: branch,
      role,
      devices,
      as_of: now,
      pairing_enabled: true,
      inventory_enabled: true,
    };
    const model = new DevicesModel(
      async (path) => (path.endsWith('/events') ? { events: [] } : snapshot),
      () => {
        root.replaceChildren();
        view.render(root);
      },
    );
    model.now = () => Date.now();
    model.actor = actor;
    model.branch = branch;
    model.data = snapshot;
    if (showCode)
      model.code = {
        command_id: actor,
        device_id: rows[3].id,
        code: 'abcd-abcd-abcd-abcd-abcd-abcd-abcd-abcd',
        expires_at: '2099-01-01T00:00:00Z',
      };
    const view = new DeviceAccessView(model);
    view.render(root);
  });
}
export const Manager = { render: () => render() };
export const Analyst = { render: () => render('analyst') };
export const OneTimeCode = { render: () => render('manager', true) };
