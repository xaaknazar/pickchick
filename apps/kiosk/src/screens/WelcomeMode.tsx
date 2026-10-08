import type { KioskModel } from '../model';
import { copy } from '../i18n';
import { Header, ScreenSurface, ScrollArea, Wrapper, type ScreenContext } from '../components/UI';
import { Hero } from '../components/Hero';
import { WelcomeContent } from '../components/WelcomeContent';
import { DiningModeCard, DiningModeTitle } from '../components/DiningModeCard';
export function WelcomeScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  return (
    <ScreenSurface
      testID="kiosk-screen-welcome"
      tone="dark"
      entrance={context.from && context.from !== 'boot' ? context.direction : 'none'}
    >
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
    <ScreenSurface testID="kiosk-screen-mode" tone="night" entrance={context.direction}>
      <Header
        {...context}
        back={() =>
          model.cart.length || model.unavailableCartLines.length
            ? context.onCancel()
            : void model.newGuest()
        }
        backLabel={t.back}
        minimal
      />
      <ScrollArea fill>
        <DiningModeTitle>{t.modeTitle}</DiningModeTitle>
        <Wrapper flex={1} paddingX={60} paddingY={46} gap={30}>
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
