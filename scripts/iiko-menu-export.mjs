/** Read-only iiko Cloud export. No PickChick DB connection or publication command.
 * Contract checked against https://api-ru.iiko.services/api-docs/docs (2026-09-25).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IIKO_ORIGIN = 'https://api-ru.iiko.services';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_PATHS = new Set(['/api/1/organizations', '/api/2/menu', '/api/menu/v3/by_id']);
const MAX_BYTES = 16 * 1024 * 1024;
export class IikoExportError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'IikoExportError';
    this.code = code;
    this.status = status;
  }
}
const invalid = () => {
  throw new IikoExportError('INVALID_SOURCE_RESPONSE');
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2000;
function list(value, optional = false) {
  if (optional && value == null) return [];
  if (!Array.isArray(value) || value.length > 100000) invalid();
  return value;
}
function dictionary(value, optional = false) {
  const rows = list(value, optional),
    result = new Map();
  for (const row of rows) {
    if (!object(row) || !text(row.id) || result.has(row.id)) invalid();
    result.set(row.id, row);
  }
  return result;
}

/** Decimal conversion for a review preview only. Missing/negative/sub-minor values never round. */
export function minorPreview(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 9e12)
    return null;
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return (BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))).toString();
}

/** Inventory of the v3 source. This is deliberately NOT an approved sellable catalog. */
export function reviewMenu(menu) {
  if (!object(menu) || !text(menu.id) || !text(menu.name)) invalid();
  const products = dictionary(menu.products, true);
  const modifiers = dictionary(menu.modifiers, true);
  const combos = dictionary(menu.combos, true);
  const taxes = dictionary(menu.taxCategories, true);
  const groups = dictionary(menu.itemsGroups, true);
  const issues = [],
    placements = [];
  const issue = (code, path) => issues.push({ code, path });
  for (const [id, product] of products) {
    if (!text(product.sku)) invalid();
    if (!product.taxCategoryId) issue('TAX_REVIEW_REQUIRED', `products/${id}`);
    else if (!taxes.has(product.taxCategoryId)) issue('MISSING_TAX_REFERENCE', `products/${id}`);
    if (product.canSetOpenPrice || product.splittable)
      issue('OPEN_PRICE_OR_SPLIT_REQUIRES_MAPPING', `products/${id}`);
  }
  for (const [id, combo] of combos) {
    // iiko FIXED/BY_COMPONENT and component overrides must not be flattened silently.
    if (!text(combo.sku)) invalid();
    issue('COMBO_PRICING_REQUIRES_MAPPING', `combos/${id}`);
  }
  for (const [groupId, group] of groups) {
    if (!text(group.name)) invalid();
    if (group.scheduleId) issue('SCHEDULE_REQUIRES_MAPPING', `itemsGroups/${groupId}`);
    for (const [index, item] of list(group.items, true).entries()) {
      if (!object(item) || !text(item.name)) invalid();
      const path = `itemsGroups/${groupId}/items/${index}`;
      const isCombo = item.itemType === 'COMBO';
      if (item.itemType != null && !['PRODUCT', 'COMBO'].includes(item.itemType))
        issue('UNKNOWN_ITEM_TYPE', path);
      const id = isCombo ? item.comboId : item.productId;
      if (!text(id) || !(isCombo ? combos : products).has(id))
        issue('MISSING_ITEM_REFERENCE', path);
      const sizes = list(item.sizePrices, true).map((size) => {
        if (!object(size)) invalid();
        const minor = minorPreview(size.price);
        if (minor === null) issue('PRICE_MISSING_OR_UNSUPPORTED', path);
        return {
          sizeId: size.sizeId ?? null,
          sizeName: size.sizeName ?? null,
          sourcePrice: size.price ?? null,
          priceMinorPreview: minor,
          hidden: size.isHidden === true,
          image: size.image ?? (size.buttonImageUrl ? { url: size.buttonImageUrl } : null),
        };
      });
      if (!isCombo && sizes.length === 0) issue('PRICE_MISSING_OR_UNSUPPORTED', path);
      const modifierGroups = list(item.modifierGroups, true);
      for (const [mIndex, modifierGroup] of modifierGroups.entries()) {
        if (!object(modifierGroup) || !text(modifierGroup.name)) invalid();
        const modifierPath = `${path}/modifierGroups/${mIndex}`;
        // Per-option minima, freeQuantity and independentQuantity differ from PickChick contracts.
        issue('MODIFIER_RULES_REQUIRE_MAPPING', modifierPath);
        for (const option of list(modifierGroup.items, true)) {
          if (!object(option) || !text(option.id)) invalid();
          if (!modifiers.has(option.id)) issue('MISSING_MODIFIER_REFERENCE', modifierPath);
        }
      }
      placements.push({
        groupId,
        groupName: group.name,
        sourceId: id ?? null,
        name: item.name,
        sku: (isCombo ? combos : products).get(id)?.sku ?? null,
        itemType: item.itemType ?? 'PRODUCT',
        hidden: group.isHidden === true || item.isHidden === true,
        sizes,
        modifierGroupCount: modifierGroups.length,
      });
    }
  }
  if (placements.length === 0) issue('EMPTY_MENU', 'itemsGroups');
  return {
    sourceMenuId: menu.id,
    sourceMenuName: menu.name,
    counts: {
      groups: groups.size,
      products: products.size,
      combos: combos.size,
      modifiers: modifiers.size,
      taxes: taxes.size,
      placements: placements.length,
    },
    publishable: false,
    requiredReview: [
      'source_currency',
      'channel_prices',
      'ru_kk_content',
      'taxes',
      'combo_and_modifier_rules',
      'control_baskets',
      'owner_acceptance',
    ],
    placements,
    issues,
  };
}

export function createIikoReader(
  credentials,
  { fetcher = fetch, timeoutMs = 30000, maxBytes = MAX_BYTES } = {},
) {
  const { apiKey, appId, clientSecret } = credentials ?? {};
  if (![apiKey, appId, clientSecret].every(text) || !UUID.test(appId))
    throw new IikoExportError('IIKO_V2_CREDENTIALS_REQUIRED');
  let token;
  async function request(path, body, auth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${IIKO_ORIGIN}${path}`, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected) throw new IikoExportError('IIKO_REDIRECT_REJECTED');
      // Never include a remote error body: providers can echo credentials.
      if (!response.ok) {
        await response.body?.cancel();
        throw new IikoExportError('IIKO_HTTP_ERROR', response.status);
      }
      if (
        !response.headers.get('content-type')?.includes('application/json') ||
        Number(response.headers.get('content-length')) > maxBytes ||
        !response.body
      )
        throw new IikoExportError('IIKO_INVALID_RESPONSE');
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) throw new IikoExportError('IIKO_RESPONSE_TOO_LARGE');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new IikoExportError('IIKO_INVALID_JSON');
      }
      return { data, raw };
    } catch (error) {
      if (error instanceof IikoExportError) throw error;
      throw new IikoExportError('IIKO_TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async read(path, body) {
      if (!READ_PATHS.has(path)) throw new IikoExportError('IIKO_METHOD_NOT_READ_ONLY');
      if (!token) {
        const result = await request('/api/v2/access_token', { apiKey, appId, clientSecret });
        if (!text(result.data?.token)) throw new IikoExportError('IIKO_INVALID_TOKEN');
        token = result.data.token;
      }
      return request(path, body, token);
    },
  };
}

/** No destructive methods, no images fetched, no fallback to another organization or price category. */
export async function collectExport(
  reader,
  { organizationId, menuIds = [], priceCategoryId = null } = {},
) {
  if (
    !UUID.test(organizationId ?? '') ||
    (priceCategoryId !== null && !UUID.test(priceCategoryId)) ||
    !Array.isArray(menuIds) ||
    menuIds.some((id) => !text(id)) ||
    new Set(menuIds).size !== menuIds.length
  )
    throw new IikoExportError('INVALID_EXPORT_SCOPE');
  const organizations = await reader.read('/api/1/organizations', {
    organizationIds: [organizationId],
    returnAdditionalInfo: false,
    includeDisabled: false,
  });
  const orgs = dictionary(organizations.data.organizations);
  if (orgs.size !== 1 || !orgs.has(organizationId))
    throw new IikoExportError('ORGANIZATION_MISMATCH');
  const menus = await reader.read('/api/2/menu');
  const available = dictionary(menus.data.externalMenus, true);
  const categories = dictionary(menus.data.priceCategories, true);
  if (priceCategoryId !== null && !categories.has(priceCategoryId))
    throw new IikoExportError('PRICE_CATEGORY_NOT_AVAILABLE');
  const selected = menuIds.length ? menuIds : [...available.keys()];
  if (!selected.length || selected.length > 100 || selected.some((id) => !available.has(id)))
    throw new IikoExportError('MENU_NOT_AVAILABLE');
  const files = [],
    reviews = [];
  for (const menuId of selected) {
    const result = await reader.read('/api/menu/v3/by_id', {
      externalMenuId: menuId,
      organizationId,
      priceCategoryId,
    });
    if (result.data.id !== menuId) throw new IikoExportError('MENU_MISMATCH');
    reviews.push(reviewMenu(result.data));
    // Filenames never use remote IDs/names.
    files.push({ name: `menu-${files.length + 1}.json`, raw: result.raw, menuId });
  }
  return {
    files,
    review: {
      schemaVersion: 1,
      source: IIKO_ORIGIN,
      collectedAt: new Date().toISOString(),
      organizationId,
      priceCategoryId,
      completeForSelectedScope: true,
      publishable: false,
      organizations: [...orgs.values()].map(({ id, name }) => ({ id, name })),
      availableMenus: [...available.values()].map(({ id, name }) => ({ id, name })),
      priceCategories: [...categories.values()].map(({ id, name }) => ({ id, name })),
      menus: reviews,
    },
  };
}

export async function saveExport(repoRoot, result) {
  const root = await realpath(repoRoot),
    local = join(root, '.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  if ((await realpath(local)) !== local) throw new IikoExportError('UNSAFE_OUTPUT_DIRECTORY');
  const directory = join(local, `iiko-menu-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  for (const file of result.files) {
    if (!/^menu-[1-9][0-9]*\.json$/.test(file.name))
      throw new IikoExportError('INVALID_OUTPUT_NAME');
    await writeFile(join(directory, file.name), file.raw, { flag: 'wx', mode: 0o600 });
    files.push({
      name: file.name,
      menuId: file.menuId,
      bytes: Buffer.byteLength(file.raw),
      sha256: createHash('sha256').update(file.raw).digest('hex'),
    });
  }
  await writeFile(join(directory, 'review.json'), JSON.stringify(result.review, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  // Written last. A partial directory without this manifest is not a completed export.
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        collectedAt: result.review.collectedAt,
        organizationId: result.review.organizationId,
        priceCategoryId: result.review.priceCategoryId,
        files,
        publishable: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return directory;
}

async function main(args) {
  if (args.includes('--help')) {
    console.log(
      'Usage: node --env-file=.local/iiko.env scripts/iiko-menu-export.mjs --discover\n' +
        '   or: ... --organization UUID [--menu ID ...] [--price-category UUID]\n' +
        'Required env: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET. Output: private .local/iiko-menu-UUID.',
    );
    return;
  }
  const options = { menuIds: [] };
  let discover = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--discover') {
      discover = true;
      continue;
    }
    if (
      !['--organization', '--menu', '--price-category'].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new IikoExportError('INVALID_ARGUMENTS');
    const value = args[++i];
    if (key === '--menu') options.menuIds.push(value);
    else {
      const name = key === '--organization' ? 'organizationId' : 'priceCategoryId';
      if (options[name] !== undefined) throw new IikoExportError('INVALID_ARGUMENTS');
      options[name] = value;
    }
  }
  if (discover && args.length !== 1) throw new IikoExportError('INVALID_ARGUMENTS');
  const reader = createIikoReader({
    apiKey: process.env.IIKO_API_KEY,
    appId: process.env.IIKO_APP_ID,
    clientSecret: process.env.IIKO_CLIENT_SECRET,
  });
  if (discover) {
    const orgs = await reader.read('/api/1/organizations', {
      returnAdditionalInfo: false,
      includeDisabled: false,
    });
    const menus = await reader.read('/api/2/menu');
    const values = (input) =>
      [...dictionary(input, true).values()].map(({ id, name }) => ({ id, name }));
    console.log(
      JSON.stringify(
        {
          organizations: values(orgs.data.organizations),
          menus: values(menus.data.externalMenus),
          priceCategories: values(menus.data.priceCategories),
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await collectExport(reader, options);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await saveExport(root, result);
  console.log(JSON.stringify({ directory, menus: result.files.length, publishable: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        code: error instanceof IikoExportError ? error.code : 'EXPORT_FAILED',
        ...(error instanceof IikoExportError && error.status ? { status: error.status } : {}),
      }),
    );
    process.exitCode = 1;
  });
}
