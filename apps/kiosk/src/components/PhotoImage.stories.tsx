import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { PhotoImage } from './PhotoImage';
const meta = {
  title: 'Kiosk/PhotoImage',
  component: PhotoImage,
  decorators: [
    (Story) => (
      <View style={{ width: 260, height: 260 }}>
        <Story />
      </View>
    ),
  ],
  args: { imageId: 'i1.jpg' },
  tags: ['autodocs'],
} satisfies Meta<typeof PhotoImage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const PikoBothFlavors: Story = { args: { imageId: 'drink:piko' } };
export const OrangeInCart: Story = { args: { imageId: 'drink:piko-orange', variant: 'cart' } };
export const ComboHero: Story = { args: { imageId: 'i7.jpg', variant: 'hero' } };
export const BottleOption: Story = { args: { imageId: 'cola-bottle', variant: 'option' } };
