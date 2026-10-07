import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
export function ScrollArea({
  children,
  testID,
  onInteraction,
  fill = false,
}: {
  children?: ReactNode;
  testID?: string;
  onInteraction?: () => void;
  fill?: boolean;
}) {
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, minHeight: 0 }}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={onInteraction}
      contentContainerStyle={fill ? { flexGrow: 1 } : undefined}
    >
      {children}
    </ScrollView>
  );
}
