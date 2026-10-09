import { DeviceAccessView } from './DeviceAccessView.js';
import { DevicesModel } from '../devices-model.js';
import { surface, rows, branch, actor } from '../../../operations-storybook/surface.mjs';
export default { title: 'Backoffice/Devices' };
function render(role = 'manager', showCode = false) {
  return surface('backoffice', (root) => {
    const model = new DevicesModel(
      async (path) =>
        path.endsWith('/events')
          ? { events: [] }
          : { branch_id: branch, role, devices: rows, as_of: '2026-10-09T05:00:00Z' },
      () => {
        root.replaceChildren();
        view.render(root);
      },
    );
    model.actor = actor;
    model.branch = branch;
    model.data = { branch_id: branch, role, devices: rows, as_of: '2026-10-09T05:00:00Z' };
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
