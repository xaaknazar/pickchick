import { useEffect, useRef, useState } from 'react';
import type { Product, Selection } from '../model';
import { lineUnitPrice } from '../domain';
import { PRICES_UPDATED, MENU_UPDATED, retainSelections } from '../cart-reprice';
import { CatalogChangeNotice } from './CatalogChangeNotice';

export function ProductMenuNotice({
  product,
  selections,
}: {
  product: Product;
  selections: Selection[];
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
      else if (retained.length !== selections.length || product.available === false)
        setMessage(MENU_UPDATED);
    }
    previous.current = product;
  }, [product, selections]);
  return message ? (
    <CatalogChangeNotice message={message} onDismiss={() => setMessage('')} />
  ) : null;
}
