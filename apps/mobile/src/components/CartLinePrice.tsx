import { Text } from './LocalizedText';
import { localize, useLocale } from '../i18n';
import { StyleSheet, View } from 'react-native';
import { colors, font } from '../theme';
import { money } from '../domain';

export function CartLinePrice({
  unitMinor,
  previousUnitMinor,
  quantity,
}: {
  unitMinor: string;
  previousUnitMinor?: string;
  quantity: number;
}) {
  useLocale();
  return (
    <View style={s.amount}>
      {previousUnitMinor && previousUnitMinor !== unitMinor ? (
        <Text style={s.previous}>
          {localize(money((BigInt(previousUnitMinor) * BigInt(quantity)).toString()))}
        </Text>
      ) : null}
      <Text style={s.current}>
        {localize(money((BigInt(unitMinor) * BigInt(quantity)).toString()))}
      </Text>
    </View>
  );
}
const s = StyleSheet.create({
  amount: { alignItems: 'flex-end', gap: 2 },
  current: { color: colors.text, fontFamily: font.heading, fontSize: 18, lineHeight: 24 },
  previous: {
    color: colors.muted,
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 20,
    textDecorationLine: 'line-through',
  },
});
