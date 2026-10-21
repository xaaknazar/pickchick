export type NotificationLocale = 'ru' | 'kk' | 'en';
export type OrderNotificationKind = 'paid' | 'preparing' | 'ready' | 'handed_over';
export const notificationTemplates: Record<
  OrderNotificationKind,
  Record<NotificationLocale, { title: string; body: string }>
> = {
  paid: {
    ru: {
      title: 'Оплата подтверждена',
      body: 'Ждём, когда ресторан примет заказ. Статус доступен в приложении.',
    },
    kk: {
      title: 'Төлем расталды',
      body: 'Мейрамхананың тапсырысты қабылдауын күтіп отырмыз. Күйін қолданбадан көре аласыз.',
    },
    en: {
      title: 'Payment confirmed',
      body: 'Waiting for the restaurant to accept your order. Check its status in the app.',
    },
  },
  preparing: {
    ru: {
      title: 'Готовим ваш заказ',
      body: 'Заказ уже на кухне. Сообщим, когда можно будет забрать.',
    },
    kk: {
      title: 'Тапсырысыңызды дайындап жатырмыз',
      body: 'Тапсырысыңыз асүйде. Алып кетуге дайын болғанда хабарлаймыз.',
    },
    en: {
      title: 'Preparing your order',
      body: 'Your order is in the kitchen. We will let you know when it is ready to collect.',
    },
  },
  ready: {
    ru: { title: 'Заказ готов!', body: 'Подходите к стойке выдачи. Номер заказа - в приложении.' },
    kk: {
      title: 'Тапсырыс дайын!',
      body: 'Тапсырыс беру орнына келіңіз. Тапсырыс нөмірі қолданбада көрсетілген.',
    },
    en: {
      title: 'Your order is ready!',
      body: 'Come to the collection counter. Your order number is in the app.',
    },
  },
  handed_over: {
    ru: {
      title: 'Приятного аппетита!',
      body: 'Спасибо за заказ. Поделитесь впечатлениями в приложении.',
    },
    kk: { title: 'Ас болсын!', body: 'Тапсырысыңызға рақмет. Қолданбада пікіріңізбен бөлісіңіз.' },
    en: {
      title: 'Enjoy your meal!',
      body: 'Thank you for your order. Share your feedback in the app.',
    },
  },
};
export function notificationText(kind: OrderNotificationKind, locale: NotificationLocale) {
  return notificationTemplates[kind][locale];
}
