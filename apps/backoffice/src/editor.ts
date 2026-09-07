import {
  copy,
  toMajor,
  toMinor,
  money,
  assetKeys,
  productIssues,
  type CatalogPayload,
  type Product,
  type Group,
} from './domain.js';
import { element as el, button, field, select, check, grid, image } from './dom.js';
const kinds = [
  { value: 'item', label: 'Отдельная позиция' },
  { value: 'combo', label: 'Комбо' },
  { value: 'set', label: 'Сет' },
];
export function emptyProduct(payload: CatalogPayload): Product {
  return {
    id: '',
    sku: '',
    name: { ru: '', kk: '' },
    description: { ru: '', kk: '' },
    category_id: payload.categories[0]!.id,
    price_minor: '0',
    image_asset_key: 'generic-drink',
    available: false,
    prep_required: true,
    prep_minutes: 10,
    serving_label: { ru: '1 порция', kk: '' },
    weight_g: null,
    volume_ml: null,
    ingredients: { ru: '', kk: '' },
    allergens: [],
    allergens_status: 'unknown',
    nutrition: { basis: 'per_serving', energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
    nutrition_status: 'unverified',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
  };
}
export function openEditor(
  original: Product,
  payload: CatalogPayload,
  onApply: (p: Product) => void,
  isNew = false,
) {
  const p = copy(original),
    dialog = el('dialog', 'editor-dialog'),
    form = el('form', 'editor-form'),
    body = el('div', 'editor-body'),
    error = el('div', 'form-error'),
    tabs = el('div', 'editor-tabs'),
    footer = el('footer', 'editor-footer');
  let dirty = false,
    tab = 'general';
  const prices = new Map<object, string>([[p, toMajor(p.price_minor)]]);
  error.setAttribute('role', 'alert');
  error.dataset.testid = 'editor-error';
  dialog.dataset.testid = 'product-editor';
  const changed = () => {
    dirty = true;
  };
  const close = () => {
    if (dirty && !window.confirm('Закрыть карточку без применения правок?')) return;
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  const header = el('header', 'editor-header');
  header.append(
    el('div', '', isNew ? 'Новая позиция' : 'Редактирование позиции'),
    button('Закрыть', close, 'button subtle', 'editor-close'),
  );
  form.append(header, tabs, body, footer);
  dialog.append(form);
  document.body.append(dialog);
  const setText = (target: { ru: string; kk: string }, key: 'ru' | 'kk') => (value: string) => {
    target[key] = value;
    changed();
  };
  const loc = (title: string, target: { ru: string; kk: string }, id: string, multiline = false) =>
    grid(
      field(`${title} · RU`, target.ru, setText(target, 'ru'), {
        id: `edit-${id}-ru`,
        max: multiline ? 2000 : 150,
        multiline,
      }),
      field(`${title} · KZ`, target.kk, setText(target, 'kk'), {
        id: `edit-${id}-kk`,
        max: multiline ? 2000 : 150,
        multiline,
        hint: 'Пустое поле означает, что перевод ещё не добавлен.',
      }),
    );
  const numeric = (label: string, value: number, onValue: (v: number) => void, id?: string) =>
    field(
      label,
      String(value),
      (v) => {
        onValue(Number(v));
        changed();
      },
      { ...(id ? { id } : {}), type: 'number' },
    );
  const priceField = (
    label: string,
    key: object,
    value: string,
    update: (minor: string) => void,
    id?: string,
  ) =>
    field(
      label,
      prices.get(key) ?? toMajor(value),
      (v) => {
        prices.set(key, v);
        try {
          update(toMinor(v));
        } catch {
          /* Preserve invalid input until explicit validation. */
        }
        changed();
      },
      { ...(id ? { id } : {}), hint: 'Тенге, до двух знаков после запятой.' },
    );
  function section(title: string) {
    const s = el('section', 'editor-section');
    s.append(el('h3', '', title));
    body.append(s);
    return s;
  }
  function draw() {
    body.replaceChildren();
    tabs.replaceChildren();
    for (const [key, label] of [
      ['general', 'Основное'],
      ['details', 'Состав и КБЖУ'],
      ['modifiers', 'Модификаторы'],
      ['components', 'Компоненты'],
      ['preview', 'Предпросмотр'],
    ]) {
      const b = button(
        label!,
        () => {
          tab = key!;
          draw();
        },
        `tab ${tab === key ? 'active' : ''}`,
        `editor-tab-${key}`,
      );
      b.setAttribute('aria-pressed', String(tab === key));
      tabs.append(b);
    }
    if (tab === 'general') {
      const s = section('Карточка блюда');
      s.append(
        loc('Название', p.name, 'name'),
        loc('Описание', p.description, 'description', true),
        grid(
          field(
            'ID позиции',
            p.id,
            (v) => {
              p.id = v;
              changed();
            },
            {
              id: 'edit-id',
              max: 40,
              readonly: !isNew,
              hint: 'Постоянный идентификатор. После создания не меняется.',
            },
          ),
          field(
            'Артикул',
            p.sku,
            (v) => {
              p.sku = v;
              changed();
            },
            { id: 'edit-sku', max: 64 },
          ),
        ),
        grid(
          select(
            'Категория',
            p.category_id,
            payload.categories.map((c) => ({ value: c.id, label: c.name.ru })),
            (v) => {
              p.category_id = v;
              changed();
            },
            'edit-category',
          ),
          select(
            'Тип позиции',
            p.kind,
            kinds,
            (v) => {
              p.kind = v as Product['kind'];
              changed();
            },
            'edit-kind',
          ),
        ),
        grid(
          priceField('Базовая цена, ₸', p, p.price_minor, (v) => (p.price_minor = v), 'edit-price'),
          numeric(
            'Приготовление, минут',
            p.prep_minutes,
            (v) => (p.prep_minutes = v),
            'edit-prep-minutes',
          ),
        ),
        grid(
          check(
            'Доступна в каталоге',
            p.available,
            (v) => {
              p.available = v;
              changed();
            },
            'edit-available',
          ),
          check(
            'Требуется приготовление',
            p.prep_required,
            (v) => {
              p.prep_required = v;
              changed();
            },
            'edit-prep-required',
          ),
        ),
      );
      const photo = section('Изображение из материалов бренда'),
        preview = el('div', 'asset-preview');
      preview.append(image(p.image_asset_key, p.name.ru));
      photo.append(
        select(
          'Ресурс изображения',
          p.image_asset_key,
          assetKeys.map((key) => ({
            value: key,
            label: key === 'generic-drink' ? 'Без фотографии' : key,
          })),
          (v) => {
            p.image_asset_key = v;
            changed();
            preview.replaceChildren(image(v, p.name.ru));
          },
          'edit-image',
        ),
        preview,
        el(
          'p',
          'muted',
          'Здесь доступны подготовленные ресурсы. Загрузка новых изображений появится отдельным этапом.',
        ),
      );
    } else if (tab === 'details') {
      const s = section('Порция и состав');
      s.append(
        loc('Порция', p.serving_label, 'serving'),
        grid(
          field(
            'Вес, г',
            p.weight_g === null ? '' : String(p.weight_g),
            (v) => {
              p.weight_g = v.trim() ? Number(v) : null;
              changed();
            },
            { id: 'edit-weight', type: 'number', hint: 'Пустое поле — вес не указан.' },
          ),
          field(
            'Объём, мл',
            p.volume_ml === null ? '' : String(p.volume_ml),
            (v) => {
              p.volume_ml = v.trim() ? Number(v) : null;
              changed();
            },
            { id: 'edit-volume', type: 'number' },
          ),
        ),
        loc('Ингредиенты', p.ingredients, 'ingredients', true),
        field(
          'Аллергены — по одному на строку',
          p.allergens.join('\n'),
          (v) => {
            p.allergens = v
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean);
            changed();
          },
          { id: 'edit-allergens', multiline: true, max: 3030 },
        ),
        select(
          'Сведения об аллергенах',
          p.allergens_status,
          [
            { value: 'unknown', label: 'Не проверены' },
            { value: 'declared', label: 'Указаны оператором' },
          ],
          (v) => {
            p.allergens_status = v as Product['allergens_status'];
            changed();
          },
          'edit-allergens-status',
        ),
      );
      const n = section('Пищевая ценность');
      n.append(
        el(
          'p',
          'muted',
          'Данные из макета требуют проверки. Публикация каталога не подтверждает лабораторную точность КБЖУ.',
        ),
        grid(
          select(
            'Расчёт',
            p.nutrition.basis,
            [
              { value: 'per_serving', label: 'На порцию' },
              { value: 'per_100_g', label: 'На 100 г' },
            ],
            (v) => {
              p.nutrition.basis = v as Product['nutrition']['basis'];
              changed();
            },
            'edit-nutrition-basis',
          ),
          select(
            'Статус данных',
            p.nutrition_status,
            [
              { value: 'unverified', label: 'Не проверены' },
              { value: 'operator_entered', label: 'Введены оператором' },
            ],
            (v) => {
              p.nutrition_status = v as Product['nutrition_status'];
              changed();
            },
            'edit-nutrition-status',
          ),
        ),
        grid(
          ...(
            [
              ['energy_kcal', 'Калорийность, ккал'],
              ['protein_g', 'Белки, г'],
              ['fat_g', 'Жиры, г'],
              ['carbs_g', 'Углеводы, г'],
            ] as const
          ).map(([key, label]) =>
            numeric(label, p.nutrition[key], (v) => (p.nutrition[key] = v), `edit-${key}`),
          ),
        ),
      );
    } else if (tab === 'modifiers') {
      body.append(
        el(
          'p',
          'muted',
          'Минимум и максимум задают допустимое количество выбранных вариантов. Выбор по умолчанию должен укладываться в эти границы.',
        ),
      );
      p.modifier_groups.forEach((g, gi) => {
        const s = section(g.title.ru || `Группа ${gi + 1}`);
        s.dataset.testid = `modifier-group-${gi}`;
        s.append(
          loc('Название группы', g.title, `group-${gi}-title`),
          grid(
            field(
              'ID группы',
              g.id,
              (v) => {
                g.id = v;
                changed();
              },
              { id: `edit-group-${gi}-id`, max: 40 },
            ),
            numeric('Минимум', g.min, (v) => (g.min = v), `edit-group-${gi}-min`),
            numeric('Максимум', g.max, (v) => (g.max = v), `edit-group-${gi}-max`),
          ),
        );
        g.options.forEach((o, oi) => {
          const box = el('div', 'option-box');
          box.append(
            el('h4', '', `Вариант ${oi + 1}`),
            loc('Название варианта', o.label, `option-${gi}-${oi}-label`),
            grid(
              field(
                'ID варианта',
                o.id,
                (v) => {
                  o.id = v;
                  changed();
                },
                { id: `edit-option-${gi}-${oi}-id`, max: 40 },
              ),
              priceField(
                'Доплата, ₸',
                o,
                o.price_delta_minor,
                (v) => (o.price_delta_minor = v),
                `edit-option-${gi}-${oi}-price`,
              ),
            ),
            grid(
              numeric(
                'По умолчанию',
                o.default_quantity,
                (v) => (o.default_quantity = v),
                `edit-option-${gi}-${oi}-default`,
              ),
              numeric(
                'Максимум',
                o.max_quantity,
                (v) => (o.max_quantity = v),
                `edit-option-${gi}-${oi}-max`,
              ),
            ),
            select(
              'Связанная позиция',
              o.linked_product_id ?? '',
              [
                { value: '', label: 'Без связи' },
                ...payload.products
                  .filter((v) => v.id !== p.id)
                  .map((v) => ({ value: v.id, label: v.name.ru })),
              ],
              (v) => {
                o.linked_product_id = v || null;
                changed();
              },
              `edit-option-${gi}-${oi}-link`,
            ),
            field(
              'Множитель пищевой ценности',
              o.nutrition_multiplier === undefined ? '' : String(o.nutrition_multiplier),
              (v) => {
                if (v.trim()) o.nutrition_multiplier = Number(v);
                else delete o.nutrition_multiplier;
                changed();
              },
              { type: 'number', hint: 'Необязательное положительное число, до 100.' },
            ),
            check(
              'Вариант доступен',
              o.available,
              (v) => {
                o.available = v;
                changed();
              },
              `edit-option-${gi}-${oi}-available`,
            ),
            button(
              'Удалить вариант',
              () => {
                g.options.splice(oi, 1);
                changed();
                draw();
              },
              'button danger',
            ),
          );
          s.append(box);
        });
        const add = button(
          'Добавить вариант',
          () => {
            g.options.push({
              id: `option-${g.options.length + 1}`,
              label: { ru: '', kk: '' },
              price_delta_minor: '0',
              default_quantity: 0,
              max_quantity: 1,
              available: true,
              linked_product_id: null,
            });
            changed();
            draw();
          },
          'button',
          `add-option-${gi}`,
        );
        add.disabled = g.options.length >= 20;
        s.append(
          add,
          button(
            'Удалить группу',
            () => {
              if (!window.confirm('Удалить эту группу из редактируемой карточки?')) return;
              p.modifier_groups.splice(gi, 1);
              changed();
              draw();
            },
            'button danger',
          ),
        );
      });
      const add = button(
        'Добавить группу',
        () => {
          const g: Group = {
            id: `group-${p.modifier_groups.length + 1}`,
            title: { ru: '', kk: '' },
            min: 0,
            max: 1,
            options: [],
          };
          p.modifier_groups.push(g);
          changed();
          draw();
        },
        'button',
        'add-modifier-group',
      );
      add.disabled = p.modifier_groups.length >= 10;
      body.append(add);
    } else if (tab === 'components') {
      const s = section('Состав комбо или сета');
      s.append(
        el(
          'p',
          'muted',
          'Компоненты ссылаются на существующие позиции. Циклические ссылки и удаление используемых позиций запрещены. Для отдельной позиции список должен быть пустым.',
        ),
      );
      p.combo_components.forEach((c, i) => {
        const row = grid(
          select(
            'Позиция',
            c.product_id,
            payload.products
              .filter((v) => v.id !== p.id)
              .map((v) => ({ value: v.id, label: v.name.ru })),
            (v) => {
              c.product_id = v;
              changed();
            },
            `component-${i}-product`,
          ),
          numeric('Количество', c.quantity, (v) => (c.quantity = v), `component-${i}-quantity`),
          button(
            'Убрать',
            () => {
              p.combo_components.splice(i, 1);
              changed();
              draw();
            },
            'button danger',
          ),
        );
        s.append(row);
      });
      const add = button(
        'Добавить компонент',
        () => {
          const candidate = payload.products.find(
            (v) => v.id !== p.id && !p.combo_components.some((c) => c.product_id === v.id),
          );
          if (candidate) {
            p.combo_components.push({ product_id: candidate.id, quantity: 1 });
            changed();
            draw();
          }
        },
        'button',
        'add-component',
      );
      add.disabled = p.kind === 'item' || p.combo_components.length >= 40;
      s.append(add);
    } else {
      const s = section('Предпросмотр содержимого');
      s.append(
        el(
          'p',
          'muted',
          'Проверка данных карточки; внешний вид приложения и киоска задаётся их собственным интерфейсом.',
        ),
      );
      const card = el('article', 'preview-card');
      card.append(
        image(p.image_asset_key, p.name.ru),
        el('h2', '', p.name.ru || 'Название не заполнено'),
        el('p', '', p.description.ru),
        el('strong', 'preview-price', money(p.price_minor)),
        el('p', 'muted', p.serving_label.ru),
        el(
          'p',
          '',
          `${p.nutrition.energy_kcal} ккал · Б ${p.nutrition.protein_g} · Ж ${p.nutrition.fat_g} · У ${p.nutrition.carbs_g}`,
        ),
        el(
          'p',
          'muted',
          p.nutrition_status === 'unverified' ? 'КБЖУ не проверены' : 'КБЖУ введены оператором',
        ),
      );
      for (const g of p.modifier_groups)
        card.append(
          el('h3', '', g.title.ru),
          el(
            'p',
            '',
            g.options.map((o) => `${o.label.ru} (+${money(o.price_delta_minor)})`).join(' · '),
          ),
        );
      s.append(card);
    }
    body.scrollTop = 0;
  }
  const apply = button(
    'Применить в черновик',
    () => {
      const issues: string[] = [];
      for (const [key, value] of prices) {
        if (
          key !== p &&
          !p.modifier_groups.some((g) => g.options.includes(key as Group['options'][number]))
        )
          continue;
        try {
          toMinor(value);
        } catch {
          issues.push(`${key === p ? 'Базовая цена' : 'Доплата'}: укажите корректную сумму.`);
        }
      }
      if (isNew && payload.products.some((v) => v.id === p.id))
        issues.push('ID уже используется другой позицией.');
      issues.push(
        ...productIssues(p, {
          ...payload,
          products: payload.products.some((v) => v.id === p.id)
            ? payload.products.map((v) => (v.id === p.id ? p : v))
            : [...payload.products, p],
        }),
      );
      if (issues.length) {
        error.textContent = [...new Set(issues)].join('\n');
        return;
      }
      try {
        onApply(p);
        dirty = false;
        dialog.close();
        dialog.remove();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : 'Не удалось применить изменения.';
      }
    },
    'button primary',
    'editor-apply',
  );
  footer.append(
    error,
    el(
      'p',
      'muted',
      'Применение сохраняет правки в этой вкладке. Затем сохраните серверный черновик.',
    ),
    apply,
  );
  form.addEventListener('submit', (e) => e.preventDefault());
  draw();
  dialog.showModal();
}
