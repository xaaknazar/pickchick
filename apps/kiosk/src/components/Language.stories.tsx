import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { Wrapper } from './Wrapper';
import { Language } from './Language';
const meta = {
  title: 'Kiosk/Language',
  component: Language,
  decorators: [
    (Story) => (
      // Backdrop only: the default v3 switch sits in the blue header.
      <View style={{ backgroundColor: colors.blue }}>
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  args: { locale: 'ru', onChange: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Language>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { locale: 'kk' } };
export const Light: Story = {
  args: { tone: 'light' },
  decorators: [
    (Inner) => (
      <View style={{ backgroundColor: colors.background }}>
        <Inner />
      </View>
    ),
  ],
};
