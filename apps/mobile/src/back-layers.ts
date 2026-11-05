/**
 * Android hardware Back inside one sheet (lane android, 05.11.2026).
 *
 * The sheet itself closes on Back, but a layer inside it may be on top: the Kaspi payment screen
 * in the cart (Back = its glass X, with «Закрыть оплату?» while the bank may act), the documents
 * or support page over sign-in, the OTP step (Back = «Изменить номер»). React runs a child's
 * effects before its parent's, so registering each layer with BackHandler directly would let the
 * sheet's own listener (registered last, called first) swallow Back. The sheet keeps this list
 * instead and asks the newest layer first; only when no layer takes Back does the sheet close
 * (and a locked sheet - a running payment - stays where it is, never leaving the app).
 */
export type BackLayer = () => boolean;

export interface BackLayers {
  /** Registers a layer; returns its removal. Newer layers are asked first. */
  add(layer: BackLayer): () => void;
  /** True when a layer handled Back. */
  dispatch(): boolean;
  readonly size: number;
}

export function createBackLayers(): BackLayers {
  const layers: { id: symbol; layer: BackLayer }[] = [];
  return {
    add(layer) {
      const id = Symbol('back-layer');
      layers.push({ id, layer });
      return () => {
        const index = layers.findIndex((entry) => entry.id === id);
        if (index >= 0) layers.splice(index, 1);
      };
    },
    dispatch() {
      // A layer may remove itself while handling Back; walk a copy, newest first.
      return [...layers].reverse().some((entry) => entry.layer());
    },
    get size() {
      return layers.length;
    },
  };
}
