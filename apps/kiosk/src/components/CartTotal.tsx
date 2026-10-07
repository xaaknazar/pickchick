import { copy, type Locale } from '../i18n';
import { money } from '../cart';
import { Body, Heading, Wrapper } from './UI';
export function CartTotal({
  total,
  valid,
  locale,
}: {
  total: string;
  valid: boolean;
  locale: Locale;
}) {
  return (
    <Wrapper dir="row" justify="space-between" align="center" gap={20}>
      <Body tone="muted">{copy(locale).total}</Body>
      <Wrapper flex={1}>
        <Heading size="section" align="right" tone="brand">
          {valid ? money(total) : locale === 'ru' ? 'Проверьте корзину' : 'Себетті тексеріңіз'}
        </Heading>
      </Wrapper>
    </Wrapper>
  );
}
