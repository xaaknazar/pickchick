import { useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { Locale } from '../i18n';
import {
  createReviewAccess,
  REVIEW_CODE_SHA256,
  reviewAccessConfigured,
  reviewCodeValid,
} from '../review-access';
import { Body, Button, Heading, Wrapper } from './UI';
import { DeviceField } from './DeviceField';

const text = {
  ru: {
    title: 'Демо для проверки Apple',
    body: 'Отдельный код открывает пример меню и заказа. Деньги не списываются, заказ не отправляется в ресторан. Печать фото недоступна.',
    code: 'Код проверки Apple',
    open: 'Открыть демо',
    error: 'Код не принят. Проверьте его и повторите через 2 секунды.',
  },
  kk: {
    title: 'Apple тексеруіне арналған демо',
    body: 'Жеке код мәзір мен тапсырыс үлгісін ашады. Ақша алынбайды, тапсырыс мейрамханаға жіберілмейді. Фото басып шығару қолжетімсіз.',
    code: 'Apple тексеру коды',
    open: 'Демоны ашу',
    error: 'Код қабылданбады. Тексеріп, 2 секундтан кейін қайталаңыз.',
  },
  en: {
    title: 'Apple review demo',
    body: 'Use the separate review code to explore a sample menu and order. No money is charged and no order is sent to the restaurant. Photo printing is unavailable.',
    code: 'Apple review code',
    open: 'Open demo',
    error: 'Code not accepted. Check it and try again in 2 seconds.',
  },
};
export function ReviewAccess({ locale, onOpen }: { locale: Locale; onOpen: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const verify = useMemo(
    () =>
      createReviewAccess(REVIEW_CODE_SHA256, (value) =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
      ),
    [],
  );
  if (!reviewAccessConfigured()) return null;
  const t = text[locale];
  return (
    <Wrapper gap={20}>
      <Heading size="title">{t.title}</Heading>
      <Body>{t.body}</Body>
      <DeviceField name="key" label={t.code} value={code} onChange={setCode} busy={busy} />
      {error ? (
        <Body accessibilityRole="alert" tone="danger">
          {t.error}
        </Body>
      ) : null}
      <Button
        testID="kiosk-review-open"
        label={t.open}
        busy={busy}
        disabled={!reviewCodeValid(code)}
        onPress={() => {
          if (busy) return;
          setBusy(true);
          setError(false);
          void verify(code).then((valid) => {
            setCode('');
            setBusy(false);
            if (valid) onOpen();
            else setError(true);
          });
        }}
      />
    </Wrapper>
  );
}
