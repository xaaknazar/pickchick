import { copy, type Locale } from '../i18n';
import { Heading, Icon, Wrapper } from './UI';
export function EmptyCart({ locale }: { locale: Locale }) {
  return (
    <Wrapper paddingY={80} gap={24} align="center">
      <Icon name="bag-outline" size="hero" tone="brand" />
      <Heading size="section" align="center">
        {copy(locale).empty}
      </Heading>
    </Wrapper>
  );
}
