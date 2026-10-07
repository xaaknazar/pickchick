import { copy, type Locale } from '../i18n';
import { Button, Footer, Heading, IconButton, Wrapper } from './UI';
export function ProductActions({
  locale,
  quantity,
  price,
  valid,
  available,
  busy,
  next,
  requiredValid,
  onNext,
  onMinus,
  onPlus,
  onAdd,
}: {
  locale: Locale;
  quantity: number;
  price: string | null;
  valid: boolean;
  available: boolean;
  busy: boolean;
  next: boolean;
  requiredValid: boolean;
  onNext: () => void;
  onMinus: () => void;
  onPlus: () => void;
  onAdd: () => void;
}) {
  const t = copy(locale);
  return (
    <Footer>
      {next ? (
        <Button
          label={t.next}
          icon="arrow-forward"
          disabled={!requiredValid}
          onPress={onNext}
          testID="kiosk-set-next"
          fullWidth
        />
      ) : (
        <Wrapper dir="row" align="center" gap={24}>
          <Wrapper dir="row" align="center" gap={14}>
            <IconButton
              testID="kiosk-product-decrement"
              name="remove"
              label="-"
              disabled={quantity <= 1 || busy}
              onPress={onMinus}
            />
            <Heading testID="kiosk-product-quantity" size="card">
              {quantity}
            </Heading>
            <IconButton
              testID="kiosk-product-increment"
              name="add"
              label="+"
              disabled={quantity >= 20 || busy}
              onPress={onPlus}
            />
          </Wrapper>
          <Wrapper flex={1}>
            <Button
              testID="kiosk-product-add"
              label={price ? `${t.toCart} · ${price}` : t.required}
              disabled={!valid || !available}
              busy={busy}
              onPress={onAdd}
              fullWidth
            />
          </Wrapper>
        </Wrapper>
      )}
    </Footer>
  );
}
