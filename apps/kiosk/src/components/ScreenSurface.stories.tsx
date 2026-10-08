import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Body } from './UI';
import { ScreenSurface } from './ScreenSurface';
const meta = {
  title: 'Kiosk/ScreenSurface',
  component: ScreenSurface,
  args: { children: <Body>Поверхность приложения</Body> },
  tags: ['autodocs'],
} satisfies Meta<typeof ScreenSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const KeyboardAware: Story = { args: { keyboardAware: true } };
export const Brand = { args: { tone: 'brand', children: <Body tone="inverse">PICK CHICK</Body> } };
/** Prototype `scrIn`: fades in while sliding 60 pt from the right. */
export const EnterForward: Story = {
  args: { tone: 'brand', entrance: 'forward', children: <Body tone="inverse">Вперёд</Body> },
};
/** Prototype `scrBack`: the same entrance from the left after a back action. */
export const EnterBack: Story = {
  args: { tone: 'brand', entrance: 'back', children: <Body tone="inverse">Назад</Body> },
};
