import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { Hero } from './Hero';
import { WelcomeContent } from './WelcomeContent';
const meta = {
  title: 'Kiosk/WelcomeContent',
  component: WelcomeContent,
  decorators: [
    (Story) => (
      <ScreenSurface tone="dark">
        <Hero video={false} />
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { locale: 'ru', onLocale: fn(), onStart: fn(), busy: false, onLogoHold: fn() },
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Заставка v3. Надпись кнопки по очереди КЗ -> РУ -> EN, по 2,4 с, перелист 0,28 с, точки под текстом (решение владельца 2026-10-11). Касание начинает заказ на языке переключателя; после выбора языка и при Reduce Motion надпись стоит на языке переключателя.',
      },
    },
  },
} satisfies Meta<typeof WelcomeContent>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { locale: 'kk' } };
export const English = { args: { locale: 'en' } };
export const Busy = { args: { busy: true } };
