import type { Owner, StreamStatus } from '../model.js';

/**
 * Connection of each kitchen stream (ADR-0014): the cashier edge and the cloud server are shown
 * separately, so a cook sees which orders can be acted on. Text, not colour alone, carries the
 * state; the container is a polite live region.
 */
const names: Record<Owner, string> = { edge: 'Касса', cloud: 'Сервер' };
const states: Record<StreamStatus, string> = {
  online: 'на связи',
  offline: 'нет связи',
  unknown: 'подключение',
};
export function streamLabel(owner: Owner, status: StreamStatus) {
  return `${names[owner]}: ${states[status]}`;
}
export function streamIndicators(streams: Record<Owner, StreamStatus>) {
  return `<span class="streams" role="status" aria-live="polite">${(['edge', 'cloud'] as const)
    .map(
      (owner) =>
        `<span class="stream stream-${streams[owner]}" data-stream="${owner}"><span class="stream-dot" aria-hidden="true"></span>${streamLabel(owner, streams[owner])}</span>`,
    )
    .join('')}</span>`;
}
/** Small source mark on a ticket: who executes this order. */
export function sourceBadge(owner: Owner, offline: boolean) {
  return `<span class="source source-${owner}${offline ? ' source-offline' : ''}" data-source="${owner}">${owner === 'cloud' ? 'Сервер' : 'Касса'}${offline ? ' · нет связи' : ''}</span>`;
}
/** DOM variant for the paired customer display, which renders without innerHTML. */
export function streamIndicatorsElement(streams: Record<Owner, StreamStatus>) {
  const box = document.createElement('p');
  box.className = 'streams display-streams';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  for (const owner of ['edge', 'cloud'] as const) {
    const item = document.createElement('span');
    item.className = `stream stream-${streams[owner]}`;
    item.dataset.stream = owner;
    const dot = document.createElement('span');
    dot.className = 'stream-dot';
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, streamLabel(owner, streams[owner]));
    box.append(item);
  }
  return box;
}
