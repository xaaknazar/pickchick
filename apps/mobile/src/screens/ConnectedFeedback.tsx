import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { TestFeedback, TestFeedbackInput } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import { TestApiError, TestCustomerClient } from '../test-client';
import { Body, Button, Caption, Heading, Icon, Loading, Notice, Page, Row } from '../components/UI';
import { MotionPressable } from '../components/Motion';
import { orderUI } from '../components/OrderPresentation';
import { colors, font } from '../theme';

const ticketStatus = {
  new: 'Принято',
  in_progress: 'В работе',
  resolved: 'Решено',
  closed: 'Закрыто',
};
function message(error: unknown) {
  if (error instanceof TestApiError) {
    if (error.status === 404)
      return 'Приём сообщений ещё не подключён на сервере. Попробуйте позже или обратитесь к сотруднику ресторана.';
    if (error.status === 401)
      return 'Нужно восстановить доступ к заказу. Вернитесь в заказ и нажмите «Восстановить доступ».';
    if (error.status === 429)
      return 'Лимит обращений по этому заказу достигнут. Дождитесь ответа управляющего.';
    if (error.status === 409)
      return 'Данные изменились. Обновите страницу, чтобы проверить результат.';
  }
  return 'Не удалось получить подтверждение. Повторите отправку: сохранённая попытка не создаст дубликат.';
}

export function ConnectedFeedback(props: ScreenProps) {
  const order = props.model.testFlow.current;
  const kind = props.screenId === 'M35' ? 'review' : 'ticket';
  const client = useMemo(() => new TestCustomerClient(), []);
  const [feedback, setFeedback] = useState<TestFeedback | null>(null);
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<TestFeedbackInput | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const lock = useRef(false);
  const id = order?.order_id;
  useEffect(() => {
    let active = true;
    if (!id) {
      setBusy(false);
      return;
    }
    void (async () => {
      try {
        const draft = await client.feedbackDraft(id, kind);
        if (!active) return;
        if (draft) {
          setPending(draft.body);
          setText(draft.body.text);
          if (draft.body.kind === 'review') setStars(draft.body.stars);
        }
        const data = await client.feedback(id);
        if (active) setFeedback(data);
      } catch (failure) {
        if (active) setError(message(failure));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, id, kind]);
  const refresh = async () => {
    if (!id || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      setFeedback(await client.feedback(id));
    } catch (failure) {
      setError(message(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!id || lock.current) return;
    const body: TestFeedbackInput =
      pending ??
      (kind === 'review' ? { kind, stars, text: text.trim() } : { kind, text: text.trim() });
    lock.current = true;
    setBusy(true);
    setError(null);
    setPending(body);
    try {
      setFeedback(await client.sendFeedback(id, body));
      setPending(null);
      setSent(true);
      setText('');
    } catch (failure) {
      setError(message(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const review = feedback?.review;
  const allowed = Boolean(order && (kind === 'ticket' || order.state === 'fulfilled'));
  const canWrite = allowed && !(kind === 'review' && review) && !sent;
  return (
    <Page
      props={props}
      title={kind === 'review' ? 'Оценить заказ' : 'Поддержка'}
      footer={
        canWrite ? (
          <Button
            testID="feedback-submit"
            title={
              busy
                ? 'Отправляем…'
                : pending
                  ? 'Повторить отправку'
                  : kind === 'review'
                    ? 'Отправить отзыв'
                    : 'Отправить обращение'
            }
            style={orderUI.action}
            textStyle={orderUI.actionText}
            disabled={
              busy ||
              !feedback ||
              (!pending && (kind === 'review' ? !stars : text.trim().length < 3))
            }
            onPress={() => {
              void submit();
            }}
          />
        ) : undefined
      }
    >
      <View style={s.context}>
        <Heading small style={orderUI.title}>
          Заказ №{order?.number ?? ''}
        </Heading>
        <Caption style={orderUI.detail}>
          {kind === 'review'
            ? 'Как всё прошло? Ваш отзыв увидит управляющий.'
            : 'Опишите вопрос. Номер и ресторан добавим к обращению автоматически.'}
        </Caption>
      </View>
      {busy && !feedback ? <Loading title="Загружаем…" /> : null}
      {error ? (
        <Notice warning title="Не удалось подтвердить">
          {error}
        </Notice>
      ) : null}
      {error ? (
        <Button
          title="Проверить ещё раз"
          secondary
          disabled={busy}
          onPress={() => {
            void refresh();
          }}
        />
      ) : null}
      {!allowed ? <Notice>Оценить заказ можно после выдачи.</Notice> : null}
      {kind === 'review' && review ? (
        <View style={s.context}>
          <Icon name="checkmark-circle-outline" size={32} color={colors.success} />
          <Heading small style={orderUI.title}>
            Спасибо за отзыв
          </Heading>
          <Body style={orderUI.label}>Ваша оценка: {review.stars} из 5</Body>
          {review.text ? <Body>{review.text}</Body> : null}
        </View>
      ) : canWrite ? (
        <View style={{ gap: 20 }}>
          {kind === 'review' ? (
            <View style={{ gap: 12 }}>
              <Body style={orderUI.label}>Ваша оценка</Body>
              <Row style={{ gap: 8, flexWrap: 'wrap' }}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <MotionPressable
                    key={value}
                    testID={`rating-${value}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`${value} из 5`}
                    accessibilityState={{
                      checked: stars === value,
                      disabled: busy || Boolean(pending),
                    }}
                    disabled={busy || Boolean(pending)}
                    onPress={() => setStars(value)}
                    style={s.star}
                  >
                    <Icon
                      name={value <= stars ? 'star' : 'star-outline'}
                      size={28}
                      color={value <= stars ? colors.accent : colors.muted}
                    />
                  </MotionPressable>
                ))}
              </Row>
            </View>
          ) : null}
          <View style={{ gap: 8 }}>
            <Body style={orderUI.label}>
              {kind === 'review' ? 'Комментарий · необязательно' : 'Ваш вопрос'}
            </Body>
            <TextInput
              testID="feedback-text"
              accessibilityLabel={kind === 'review' ? 'Комментарий к заказу' : 'Вопрос по заказу'}
              value={text}
              onChangeText={setText}
              editable={!busy && !pending}
              maxLength={2000}
              multiline
              placeholder={
                kind === 'review'
                  ? 'Что понравилось, а что можно улучшить?'
                  : 'Расскажите, чем мы можем помочь'
              }
              placeholderTextColor={colors.muted}
              style={s.input}
            />
            <Caption style={orderUI.detail}>{text.length} / 2000</Caption>
          </View>
          {pending ? (
            <Caption style={orderUI.detail}>
              Попытка сохранена на устройстве. Повторная отправка использует те же данные.
            </Caption>
          ) : null}
        </View>
      ) : null}
      {kind === 'ticket' && sent ? (
        <Notice title="Обращение принято">
          Управляющий увидит его в системе. Статус обращения появится ниже.
        </Notice>
      ) : null}
      {kind === 'ticket' && feedback?.tickets.length ? (
        <View style={{ gap: 16 }}>
          <Heading small style={orderUI.section}>
            Ваши обращения
          </Heading>
          {feedback.tickets.map((ticket) => (
            <View key={ticket.id} style={s.ticket}>
              <Row>
                <Icon name="chatbubble-outline" color={colors.accent} />
                <Body style={[orderUI.label, { fontFamily: font.bold }]}>
                  {ticketStatus[ticket.status]}
                </Body>
              </Row>
              <Body style={orderUI.label}>{ticket.text}</Body>
            </View>
          ))}
          <Button
            title="Обновить обращения"
            secondary
            disabled={busy}
            onPress={() => {
              void refresh();
            }}
          />
        </View>
      ) : null}
    </Page>
  );
}
const s = StyleSheet.create({
  context: { gap: 8 },
  star: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  input: {
    minHeight: 140,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 24,
    textAlignVertical: 'top',
  },
  ticket: { gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderColor: colors.border },
});
