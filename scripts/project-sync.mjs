import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SHARED = 'codex/shared-development';
export const COORDINATION = 'codex/work-coordination';
const REPOSITORY = 'https://github.com/xaaknazar/pickchick.git';
const EMPTY = () => ({ schemaVersion: 1, tasks: [] });
const normalizeRemote = (url) =>
  url
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '');

export function scope(value) {
  const result = value.replace(/\/$/, '');
  if (result !== '*' && !/^@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(result))
    throw new Error('Область должна быть путём проекта, @vps, @windows/cashier или *.');
  if (result.split('/').some((part) => ['.', '..', '.git'].includes(part)))
    throw new Error('Недопустимая область работы.');
  return result;
}
export function overlaps(a, b) {
  return a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
export function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.tasks))
    throw new Error('Неизвестный формат журнала.');
  const ids = new Set();
  for (const task of state.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      ids.has(task.id) ||
      !['active', 'available', 'done'].includes(task.status) ||
      typeof task.owner !== 'string' ||
      typeof task.branch !== 'string' ||
      !/^codex\/[a-zA-Z0-9_./-]+$/.test(task.branch) ||
      typeof task.head !== 'string' ||
      !/^[a-f0-9]{40}$/.test(task.head) ||
      !Array.isArray(task.scopes) ||
      !task.scopes.length ||
      !task.scopes.every((value) => typeof value === 'string' && scope(value) === value)
    )
      throw new Error('Повреждён журнал задач. Не перезаписывайте его.');
    ids.add(task.id);
  }
  return state;
}

// GitHub is the coordination authority. No credentials or working-tree files
// are staged, copied or committed by this tool. All child processes avoid a shell.
export class ProjectSync {
  constructor(cwd = process.cwd(), expectedRemote = REPOSITORY) {
    this.cwd = cwd;
    this.expectedRemote = expectedRemote;
    this.git(['rev-parse', '--show-toplevel']);
    const remote = this.git(['remote', 'get-url', 'origin']);
    if (normalizeRemote(remote) !== normalizeRemote(expectedRemote))
      throw new Error(
        'origin не соответствует каноническому репозиторию. Синхронизация остановлена.',
      );
  }
  git(args, { input, optional = false } = {}) {
    const result = spawnSync('git', args, {
      cwd: this.cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 45000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error || result.status !== 0) {
      if (optional) return null;
      // Avoid echoing remote URLs or credential helpers into a shared handoff.
      throw new Error(
        `Git ${args[0]} не выполнен. Проверьте доступ/сеть и состояние репозитория; данные не сбрасывались.`,
      );
    }
    return result.stdout.trim();
  }
  refresh() {
    if (
      normalizeRemote(this.git(['remote', 'get-url', 'origin'])) !==
      normalizeRemote(this.expectedRemote)
    )
      throw new Error('origin изменён. Синхронизация остановлена.');
    this.git(['fetch', '--prune', '--no-tags', 'origin']);
  }
  owner() {
    const directory = resolve(this.cwd, this.git(['rev-parse', '--git-common-dir']));
    const file = resolve(directory, 'pickchick-workstation-id');
    if (!existsSync(file)) {
      try {
        writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return readFileSync(file, 'utf8').trim();
  }
  branch() {
    return this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }
  head() {
    return this.git(['rev-parse', 'HEAD']);
  }
  dirty() {
    return Boolean(this.git(['status', '--porcelain']));
  }
  ancestor(a, b) {
    return this.git(['merge-base', '--is-ancestor', a, b], { optional: true }) !== null;
  }
  check() {
    this.refresh();
    const shared = this.git(['rev-parse', '--verify', `refs/remotes/origin/${SHARED}`]);
    const branch = this.branch();
    const remoteHead = this.git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      optional: true,
    });
    if (!this.ancestor(shared, 'HEAD'))
      throw new Error(
        `Есть изменения общей версии ${SHARED}. На общей ветке выполните sync; в рабочей ветке явно интегрируйте origin/${SHARED}, сохранив свою работу.`,
      );
    if (remoteHead && !this.ancestor(remoteHead, 'HEAD'))
      throw new Error(
        'На GitHub есть новые изменения вашей ветки. Выполните sync либо разберите расхождение.',
      );
    return {
      branch,
      head: this.head(),
      shared,
      dirty: this.dirty(),
      published: remoteHead === this.head(),
    };
  }
  sync() {
    if (this.dirty())
      throw new Error(
        'Есть локальные изменения. Сохраните их отдельно; автоматическое обновление остановлено.',
      );
    this.refresh();
    const branch = this.branch();
    if (branch === COORDINATION) throw new Error('Служебный журнал не является рабочей веткой.');
    const remote = `refs/remotes/origin/${branch}`;
    this.git(['rev-parse', '--verify', remote]);
    this.git(['merge', '--ff-only', '--no-overwrite-ignore', remote]);
    return this.check();
  }
  state() {
    const ref = `refs/remotes/origin/${COORDINATION}`;
    const parent = this.git(['rev-parse', '--verify', ref], { optional: true });
    if (!parent) return { parent: null, state: EMPTY() };
    const state = JSON.parse(this.git(['show', `${parent}:state.json`]));
    return { parent, state: validateState(state) };
  }
  status() {
    this.refresh();
    return { checkedAt: new Date().toISOString(), tasks: this.state().state.tasks };
  }
  updateRegistry(transform) {
    for (let attempt = 0; attempt < 5; attempt++) {
      this.refresh();
      const { parent, state } = this.state();
      const next = validateState(transform(state));
      const blob = this.git(['hash-object', '-w', '--stdin'], {
        input: JSON.stringify(next, null, 2) + '\n',
      });
      const tree = this.git(['mktree'], { input: `100644 blob ${blob}\tstate.json\n` });
      const commit = this.git([
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        'Update PickChick work coordination',
      ]);
      // Ordinary fast-forward push is the compare-and-swap. A competing writer
      // must win first; then we re-read and check conflicts against its record.
      if (
        this.git(['push', 'origin', `${commit}:refs/heads/${COORDINATION}`], { optional: true }) !==
        null
      ) {
        const remote = this.git(['ls-remote', 'origin', `refs/heads/${COORDINATION}`]).split(
          /\s/,
        )[0];
        if (remote === commit) return next;
        // Another valid append can already be on top. Its ancestry proves this
        // write was preserved; never repeat it just because HEAD moved forward.
        this.refresh();
        if (this.ancestor(commit, `refs/remotes/origin/${COORDINATION}`)) return next;
        throw new Error(
          'Удалённый журнал изменён неожиданным образом. Проверьте результат перед повтором.',
        );
      }
    }
    throw new Error(
      'Не удалось согласовать запись в GitHub. Задача не подтверждена; проверьте журнал.',
    );
  }
  claim(id, scopes) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(id))
      throw new Error('Используйте короткий id задачи: mobile-cards.');
    if (!scopes.length) throw new Error('Укажите хотя бы одну область работы.');
    const areas = [...new Set(scopes.map(scope))];
    const snapshot = this.check();
    if (snapshot.branch === SHARED || snapshot.branch === 'main')
      throw new Error('Сначала создайте отдельную рабочую ветку codex/<task> от общей версии.');
    if (!snapshot.branch.startsWith('codex/'))
      throw new Error('Рабочая ветка должна начинаться с codex/.');
    const owner = this.owner();
    return this.updateRegistry((state) => {
      const previous = state.tasks.find((task) => task.id === id);
      if (
        previous &&
        (previous.branch !== snapshot.branch ||
          previous.status === 'done' ||
          (previous.status === 'active' && previous.owner !== owner))
      )
        throw new Error('Это имя задачи уже используется. Не перехватывайте чужую задачу.');
      if (previous && !this.ancestor(previous.head, snapshot.head))
        throw new Error('Сначала получите сохранённый коммит передаваемой задачи.');
      const combined = [...new Set([...(previous?.scopes ?? []), ...areas])];
      const conflicting = state.tasks.find(
        (task) =>
          task.id !== id &&
          task.status !== 'done' &&
          task.scopes.some((a) => combined.some((b) => overlaps(a, b))),
      );
      if (conflicting)
        throw new Error(
          `Пересечение с задачей ${conflicting.id} (${conflicting.branch}). Согласуйте разделение работ.`,
        );
      const record = {
        ...previous,
        id,
        owner,
        branch: snapshot.branch,
        scopes: combined,
        status: 'active',
        head: snapshot.head,
        updatedAt: new Date().toISOString(),
      };
      return { ...state, tasks: [...state.tasks.filter((task) => task.id !== id), record] };
    });
  }
  finish(id, summary, nextAction, status = 'done') {
    if (!summary?.trim() || !nextAction?.trim())
      throw new Error('Нужны итог и следующий шаг. Не включайте секреты.');
    this.refresh();
    const branch = this.branch();
    const snapshot = {
      branch,
      head: this.head(),
      dirty: this.dirty(),
      published:
        this.git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { optional: true }) ===
        this.head(),
    };
    if (snapshot.dirty || !snapshot.published)
      throw new Error(
        'Сначала сохраните/проверьте изменения и отправьте свою ветку в GitHub. HEAD должен совпадать с origin.',
      );
    if (status === 'done' && !this.ancestor(snapshot.head, `refs/remotes/origin/${SHARED}`))
      throw new Error(
        'Завершение требует включить этот коммит в общую ветку. Для передачи незавершённой работы используйте handoff.',
      );
    return this.updateRegistry((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (
        !task ||
        task.owner !== this.owner() ||
        task.branch !== snapshot.branch ||
        task.status !== 'active'
      )
        throw new Error('Завершить можно только свою активную задачу на той же ветке.');
      return {
        ...state,
        tasks: state.tasks.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status,
                head: snapshot.head,
                summary,
                nextAction,
                updatedAt: new Date().toISOString(),
              },
        ),
      };
    });
  }
}

export function main(args) {
  const [command, ...values] = args;
  const client = new ProjectSync();
  let result;
  if (command === 'check') result = client.check();
  else if (command === 'sync') result = client.sync();
  else if (command === 'status') result = client.status();
  else if (command === 'claim') result = client.claim(values[0], values.slice(1));
  else if (command === 'handoff')
    result = client.finish(values[0], values[1], values[2], 'available');
  else if (command === 'finish') result = client.finish(values[0], values[1], values[2]);
  else
    throw new Error(
      'Команды: check | sync | status | claim <id> <области...> | finish/handoff <id> "итог" "следующий шаг"',
    );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
