import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetch as nativeFetch } from 'expo/fetch';
import { API_URL } from '../api';
import { createCustomerRequest } from '../customer-http';
import { useAccount } from '../useAccount';
import { parseCheckoutLegal, type CheckoutLegal } from '../checkout-legal';
import { Body, Button, Caption, Heading } from './UI';
import { colors } from '../theme';
import { t, useLocale } from '../i18n';

/** Explicit consent is append-only on the server, never inferred from opening this dialog. */
export function useCheckoutLegal() {
  useLocale();
  const auth = useAccount(),
    insets = useSafeAreaInsets();
  const [readFailure, setReadFailure] = useState(false);
  const [legal, setLegal] = useState<CheckoutLegal | null>(null);
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.reject(new Error('LEGAL_CONSENT_REQUIRED'));
      pending.current = null;
    };
  }, []);
  const request = useCallback(
    async (method: 'GET' | 'PATCH', body?: unknown, signal?: AbortSignal) => {
      if (!auth.account?.customerId || !auth.withOrderAccess) throw new Error('UNAUTHORIZED');
      const value = await auth.withOrderAccess(auth.account.customerId, (token) =>
        createCustomerRequest(API_URL, nativeFetch, {
          allowed: /^\/v1\/customers\/me$/,
          timeoutMs: 10000,
          maxBytes: 16000,
          signal,
        })('/v1/customers/me', method, body, token),
      );
      return parseCheckoutLegal(value);
    },
    [auth.account?.customerId, auth.withOrderAccess],
  );
  const authorize = useCallback(
    async (signal?: AbortSignal) => {
      let current: CheckoutLegal;
      try {
        current = await request('GET', undefined, signal);
      } catch (error) {
        if (active.current && !signal?.aborted) setReadFailure(true);
        throw error;
      }
      setReadFailure(false);
      if (!active.current || signal?.aborted) throw new Error('LEGAL_CONSENT_REQUIRED');
      if (current.accepted) return;
      if (pending.current) throw new Error('LEGAL_CONSENT_REQUIRED');
      setLegal(current);
      setBusy(false);
      setFailed(false);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          pending.current = null;
          if (active.current) setLegal(null);
          reject(new Error('LEGAL_CONSENT_REQUIRED'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        pending.current = {
          resolve: () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          reject: (e) => {
            signal?.removeEventListener('abort', abort);
            reject(e);
          },
        };
      });
    },
    [request],
  );
  const close = () => {
    pending.current?.reject(new Error('LEGAL_CONSENT_REQUIRED'));
    pending.current = null;
    setLegal(null);
    setReadFailure(false);
  };
  const accept = async () => {
    if (!legal || busy) return;
    const attempt = pending.current;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await request('PATCH', {
        legal_consents: {
          terms_version: legal.version,
          privacy_version: legal.version,
          accepted: true,
        },
      });
      if (!saved.accepted || saved.version !== legal.version) throw new Error('LEGAL_CHANGED');
      if (pending.current !== attempt) return;
      pending.current?.resolve();
      pending.current = null;
      if (active.current) setLegal(null);
    } catch {
      if (active.current && pending.current === attempt) {
        setFailed(true);
        const current = await request('GET').catch(() => null);
        if (current && pending.current === attempt) setLegal(current);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const open = (url: string) => void Linking.openURL(url).catch(() => setFailed(true));
  return {
    authorize,
    dialog: legal ? (
      <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
        <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <ScrollView contentContainerStyle={s.content}>
            <Heading>{t('Обновлённые условия')}</Heading>
            <Body>
              {t(
                'Перед платным заказом прочитайте новые условия и политику конфиденциальности. Прежнее согласие на бесплатный пилот сохраняется в истории.',
              )}
            </Body>
            <Caption>{legal.version}</Caption>
            <Button secondary title={t('Условия сервиса')} onPress={() => open(legal.terms_url)} />
            <Button
              secondary
              title={t('Политика конфиденциальности')}
              onPress={() => open(legal.privacy_url)}
            />
            <Body>
              {t(
                'Нажимая «Принимаю условия», вы принимаете эту редакцию условий и политики. Это не согласие на рекламу и не подтверждение банковского платежа.',
              )}
            </Body>
            {failed ? <Body>{t('Не удалось сохранить согласие. Попробуйте ещё раз.')}</Body> : null}
            <Button
              testID="checkout-legal-accept"
              title={t('Принимаю условия')}
              disabled={busy}
              onPress={() => void accept()}
            />
            <Button
              testID="checkout-legal-close"
              secondary
              title={t('Не сейчас')}
              onPress={close}
            />
          </ScrollView>
        </View>
      </Modal>
    ) : readFailure ? (
      <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
        <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={s.content}>
            <Heading>{t('Не удалось проверить условия')}</Heading>
            <Body>{t('Проверьте подключение и попробуйте ещё раз. Заказ не отправлен.')}</Body>
            <Button title={t('Закрыть')} onPress={close} />
          </View>
        </View>
      </Modal>
    ) : null,
  };
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 20, flexGrow: 1, justifyContent: 'center' },
});
