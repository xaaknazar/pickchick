import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { Body, Button, Wrapper } from './UI';
import { ScrollArea, type ScrollFocus } from './ScrollArea';
import { useScrollTarget } from './scroll';
const meta = {
  title: 'Kiosk/ScrollArea',
  component: ScrollArea,
  args: {
    children: (
      <Wrapper padding={24} gap={24}>
        {Array.from({ length: 15 }, (_, i) => (
          <Body key={i}>Позиция заказа {i + 1}</Body>
        ))}
      </Wrapper>
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollArea>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** A section that `focus` can bring to the top. */
function Section({ id }: { id: string }) {
  const target = useScrollTarget(id);
  return (
    <View ref={target} collapsable={false}>
      <Body>Раздел {id}</Body>
    </View>
  );
}
/** `focus` smooth-scrolls a registered section to 24 pt below the top. */
export const Focus: Story = {
  render: function FocusStory() {
    const [focus, setFocus] = useState<ScrollFocus | undefined>(undefined);
    return (
      <Wrapper flex={1} gap={16}>
        <Button
          label="К разделу 12"
          onPress={() => setFocus((now) => ({ target: '12', request: (now?.request ?? 0) + 1 }))}
        />
        <ScrollArea focus={focus}>
          <Wrapper padding={24} gap={48}>
            {Array.from({ length: 20 }, (_, i) => (
              <Section key={i} id={String(i + 1)} />
            ))}
            <Button
              label="К разделу 1"
              onPress={() => setFocus((now) => ({ target: '1', request: (now?.request ?? 0) + 1 }))}
            />
          </Wrapper>
        </ScrollArea>
      </Wrapper>
    );
  },
};
