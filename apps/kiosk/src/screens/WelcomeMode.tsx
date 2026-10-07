import type { KioskModel } from '../model';
import { copy } from '../i18n';
import {
  Header,
  Heading,
  Body,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
} from '../components/UI';
import { Hero } from '../components/Hero';
import { WelcomeContent } from '../components/WelcomeContent';
import { DiningModeCard } from '../components/DiningModeCard';
export function WelcomeScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  return (
    <ScreenSurface testID="kiosk-screen-welcome" tone="dark">
      <Hero />
      <WelcomeContent
        locale={context.locale}
        onLocale={context.setLocale}
        onStart={() => void model.start()}
        busy={model.busy}
      />
    </ScreenSurface>
  );
}
export function ModeScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  return (
    <ScreenSurface testID="kiosk-screen-mode">
      <Header
        {...context}
        back={() =>
          model.cart.length || model.unavailableCartLines.length
            ? context.onCancel()
            : void model.newGuest()
        }
        minimal
      />
      <ScrollArea fill>
        <Wrapper flex={1} padding={40} gap={28} justify="center">
          <Wrapper gap={12}>
            <Heading size="display">{t.modeTitle}</Heading>
            <Body tone="muted">
              {context.locale === 'ru'
                ? 'Приготовим ваш заказ так, как удобно вам'
                : 'Тапсырысты өзіңізге ыңғайлы етіп дайындаймыз'}
            </Body>
          </Wrapper>
          {(['dine_in', 'takeaway'] as const).map((mode) => (
            <DiningModeCard
              key={mode}
              mode={mode}
              locale={context.locale}
              busy={model.busy}
              onSelect={() => void model.setMode(mode)}
            />
          ))}
        </Wrapper>
      </ScrollArea>
    </ScreenSurface>
  );
}
