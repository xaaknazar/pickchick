import { useCallback, useRef, type ReactNode } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccount } from '../useAccount';
import { accountCanAct, type AccountDestination } from '../account-access';
import { Body, Button, Heading, Loading } from './UI';
import { ProfileRestoreNotice } from './ProfileRestoreNotice';

/** Protected children never mount while a guest or an unreadable session is active. */
export function AccountGate({
  destination,
  children,
}: {
  destination: AccountDestination;
  children: ReactNode;
}) {
  const account = useAccount();
  const router = useRouter();
  const prompted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (account.ready && !account.account && !prompted.current) {
        prompted.current = true;
        router.push({ pathname: '/auth', params: { returnTo: destination } });
      }
    }, [account.ready, account.account, router, destination]),
  );
  if (accountCanAct(account)) return children;
  const game =
    destination === 'pick-man' ||
    destination === 'pick-farm' ||
    destination === 'magic-sort' ||
    destination === 'pick-blocks' ||
    destination === 'M27' ||
    destination === 'M28';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#04143A' }}>
      <View
        testID="account-required"
        style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 20 }}
      >
        {!account.ready ? (
          <>
            <Loading title="Восстанавливаем аккаунт" />
            <ProfileRestoreNotice restorationOnly />
          </>
        ) : (
          <>
            <Heading>{game ? 'Войдите, чтобы играть' : 'Войдите, чтобы сделать заказ'}</Heading>
            <Body muted>
              {game
                ? 'Игры доступны после входа в аккаунт Pick Chick.'
                : 'Войдите в свой аккаунт, чтобы продолжить. Ваша корзина сохранится.'}
            </Body>
            <Button
              testID="account-required-reopen"
              title="Войти в аккаунт"
              onPress={() =>
                router.push({
                  pathname: '/auth',
                  params: { returnTo: destination },
                })
              }
            />
          </>
        )}
        <Button
          title={game ? 'К событиям' : 'В меню'}
          secondary
          onPress={() => router.replace(game ? '/(tabs)/events' : '/(tabs)/menu')}
        />
      </View>
    </SafeAreaView>
  );
}
