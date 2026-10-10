import { streamIndicators, sourceBadge } from './StreamStatus.js';
import { DisplayAccess } from './DisplayAccess.js';
import { TerminalAccess } from '../terminal-access.js';
import { surface } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/StreamStatus' };
/** Synthetic nav strip and two ticket heads, as on /kitchen-live/prep with the cloud stream. */
function kitchen(streams) {
  return surface('kitchen', (root) => {
    const ticket = (owner, number, channel) =>
      `<article class="ticket${streams[owner] === 'offline' ? ' owner-offline' : ''}" data-owner="${owner}"><div class="ticket-head"><strong class="number">${number}</strong><div><span class="mode">С СОБОЙ</span><p class="channel">${channel}</p>${sourceBadge(owner, streams[owner] === 'offline')}</div><div class="age"><strong>3 мин</strong><small>В очереди</small></div></div></article>`;
    root.innerHTML = `<nav aria-label="Рабочий экран"><span class="connection">${streamIndicators(streams)}<span class="sync-time">12:40:05</span></span></nav><main class="workspace"><div class="tickets">${ticket('edge', '12', 'Касса')}${ticket('cloud', '301', 'Киоск')}${ticket('cloud', '604', 'Приложение')}</div></main>`;
  });
}
export const BothOnline = { render: () => kitchen({ edge: 'online', cloud: 'online' }) };
export const CashierOffline = { render: () => kitchen({ edge: 'offline', cloud: 'online' }) };
export const ServerOffline = { render: () => kitchen({ edge: 'online', cloud: 'offline' }) };
export const BothOffline = { render: () => kitchen({ edge: 'offline', cloud: 'offline' }) };
export const DisplayCashierOffline = {
  render: () =>
    surface('kitchen', (root) => {
      const access = new TerminalAccess(() => {});
      access.mode = 'display';
      access.paired = true;
      const display = new DisplayAccess(access, () => {});
      display.cloud = true;
      display.streams = { edge: 'offline', cloud: 'online' };
      display.render(root, 'ТЦ Abay Plaza');
    }),
};
