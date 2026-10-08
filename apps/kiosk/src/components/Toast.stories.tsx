import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { colors } from '../theme';
import { Toast } from './Toast';
const meta = {
  title: 'Kiosk/Toast',
  component: Toast,
  decorators: [
    (Story) => (
      // Backdrop only: the toast floats over the blue menu surface.
      <View style={{ height: 320, backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: { message: 'Добавлено в корзину: Pick Combo', trigger: 1, testID: 'kiosk-toast' },
  tags: ['autodocs'],
} satisfies Meta<typeof Toast>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Saved: Story = { args: { message: 'Изменения сохранены', trigger: 'saved' } };
