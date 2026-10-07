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
export const Brand = { args: { tone: 'brand', children: <Body tone="inverse">PICK CHICK</Body> } };
