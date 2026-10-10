import { useEffect, useRef, useState } from 'react';
import type { Product, Selection } from '../model';
import { lineUnitPrice } from '../domain';
import { PRICES_UPDATED, retainSelections } from '../cart-reprice';
import { CatalogChangeNotice } from './CatalogChangeNotice';

/**
 * Shown inside an open product card after a publication changed what the customer would pay.
 * Owner decision: there is no separate composition message; a removed option or companion
 * surfaces only as this price notice.
 */
export function ProductMenuNotice({
  product,
  selections,
  totalChanged = false,
  onDismiss,
}: {
  product: Product;
  selections: Selection[];
  /** The card's own extras (for example combo companions) changed price or disappeared. */
  totalChanged?: boolean;
  onDismiss?(): void;
}) {
  const previous = useRef(product);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (previous.current.catalogVersion !== product.catalogVersion) {
      const retained = retainSelections(product, selections);
      if (
        lineUnitPrice({ product: previous.current, selections }) !==
        lineUnitPrice({ product, selections: retained })
      )
        setMessage(PRICES_UPDATED);
    }
    previous.current = product;
  }, [product, selections]);
  useEffect(() => {
    if (totalChanged) setMessage(PRICES_UPDATED);
  }, [totalChanged]);
  return message ? (
    <CatalogChangeNotice
      message={message}
      onDismiss={() => {
        setMessage('');
        onDismiss?.();
      }}
    />
  ) : null;
}
