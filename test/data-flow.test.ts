import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.ts';
import { defineText, flowsText } from '../src/flow/commands.ts';
import { defineScreen } from '../src/flow/define.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { datasource } from '../src/flow/format-define.ts';
import { screenFlows } from '../src/flow/flows.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { temporaryDirectory } from './helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'clean-app');

const CUSTOM = join(HERE, 'fixtures', 'custom-clean-app');

// Expected output: run with UPDATE_GOLDEN=1 to regenerate, then review the diff.
function golden(name: string, actual: string, fixture = 'clean-app'): void {
  const path = join(HERE, 'expected', `${fixture}.${name}`);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, actual);
  assert.equal(actual, readFileSync(path, 'utf8'));
}

test('define: items of SwiftUI and UIKit screens and the sources of their data', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    cpSync(FIXTURE, root, { recursive: true });
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const list = defineScreen(engine, 'ProductListView');
      assert.ok('definition' in list);
      const items = list.definition.items;
      assert.deepEqual(
        items.map((item) => `${item.id} ${item.kind} ${item.parent ?? ''}`.trim()),
        [
          'ProductListView#1 navigationTitle',
          'ProductListView#2 List',
          'ProductRow#1 Text ProductListView#2',
          'ProductRow#2 Text ProductListView#2',
        ],
      );
      // A row's text: from the API (Alamofire, JSON key from CodingKeys) and from the file cache.
      const name = items[2]!.data[0]!.traced;
      const api = name.find((traced) => traced.origin.kind === 'source' && traced.origin.source === 'api')!;
      assert.equal(api.origin.kind === 'source' && api.origin.endpoint, 'https://api.example.com/v1/products');
      assert.deepEqual(api.fields, ['items', '[]', 'name']);
      assert.equal(api.jsonKey, 'product_name');
      assert.ok(name.some((traced) => traced.origin.kind === 'source' && traced.origin.source === 'local.file'));

      const controller = defineScreen(engine, 'ProductListViewController');
      assert.ok('definition' in controller);
      const byKey = new Map(controller.definition.items.map((item) => [item.path.join('.'), item]));
      assert.deepEqual(
        [...byKey.keys()],
        ['titleLabel', 'lastUpdatedLabel', 'errorLabel', 'refreshButton', 'tableView', 'nameLabel', 'priceLabel'],
      );
      // `lastUpdatedLabel.isHidden = date == nil` decides when the label shows.
      assert.ok(byKey.get('lastUpdatedLabel')!.shownWhen.includes('!(date == nil)'));
      const date = byKey.get('lastUpdatedLabel')!.data[0]!.traced[0]!;
      assert.ok(
        date.origin.kind === 'derived' &&
          date.origin.inputs.some(
            (input) => input.origin.kind === 'source' && input.origin.source === 'local.userDefaults' && input.origin.key === 'lastUpdated',
          ),
      );
      // The error label shows the error caught from the API call.
      assert.equal(datasource(byKey.get('errorLabel')!), 'error GET https://api.example.com/v1/products');
      assert.ok(byKey.get('errorLabel')!.shownWhen.includes('!(message == nil)'));
      // The cell's labels belong to the cell, inside the table.
      assert.equal(byKey.get('nameLabel')!.id, 'ProductCell#1');
      assert.equal(byKey.get('nameLabel')!.parent, 'ProductListViewController#5');
      // ITEMS datasource: the view-model variable and the sources behind it.
      assert.equal(datasource(byKey.get('nameLabel')!), 'GET https://api.example.com/v1/products items[].product_name');
      assert.equal(datasource(byKey.get('lastUpdatedLabel')!), 'userDefaults "lastUpdated"');
      assert.equal(datasource(items[2]!), 'GET https://api.example.com/v1/products items[].product_name');

      golden('ProductListView.define.txt', defineText(db, root, { screen: 'ProductListView' }) + '\n');
      golden('ProductListViewController.define.txt', defineText(db, root, { screen: 'ProductListViewController' }) + '\n');
      golden(
        'ProductListViewController.define-detail.txt',
        defineText(db, root, { screen: 'ProductListViewController', detail: true }) + '\n',
      );
      golden(
        'ProductListViewController.define-compact.txt',
        defineText(db, root, { screen: 'ProductListViewController', format: 'compact' }) + '\n',
      );
      // The default shows ITEMS and SUMMARY only; DATA and CONDITIONS come with --detail or --item.
      const brief = defineText(db, root, { screen: 'ProductListViewController' });
      assert.ok(!brief.includes('\nDATA') && brief.includes('\nSUMMARY'));
      assert.ok(defineText(db, root, { screen: 'ProductListViewController', item: 'ProductCell#1' }).includes('\nDATA'));
      const json = JSON.parse(defineText(db, root, { screen: 'ProductCell', format: 'json' })) as { items: { id: string }[] };
      assert.deepEqual(
        json.items.map((item) => item.id),
        ['ProductCell#1', 'ProductCell#2'],
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('define: a project rule in swiftgraph.json names a Keychain wrapper', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    cpSync(FIXTURE, root, { recursive: true });
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const rule = engine.rules.sources.find((candidate) => candidate.id === 'app.token-read')!;
      assert.equal(rule.origin, 'swiftgraph.json');
      // Project rules come before the presets.
      assert.equal(engine.rules.sources[0]!.origin, 'swiftgraph.json');
      const service = engine.declaration('swift:CleanApp/ProductServiceImpl.fetchProducts()')!;
      const frame = engine.frameOf(service)!;
      const headers = frame.file.facts.flow.bindings.find((binding) => binding.name === 'headers')!;
      const keychain = engine
        .trace(headers.value, frame)
        .find((result) => result.origin.kind === 'source' && result.origin.source === 'local.keychain');
      assert.ok(keychain?.origin.kind === 'source');
      assert.equal(keychain.origin.key, 'accessToken');
      assert.equal(keychain.origin.rule, 'app.token-read');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('define and flows: a screen split into components and extensions in several files', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    cpSync(FIXTURE, root, { recursive: true });
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      // SwiftUI: `header` and `settings` live in extensions in other files; PointsBadge and AvatarView in their own files.
      const view = defineScreen(engine, 'ProfileView');
      assert.ok('definition' in view);
      assert.deepEqual(
        view.definition.items.map((item) => `${item.id} ${item.path.join(' > ')} | ${datasource(item)}`),
        [
          'ProfileView#1 alert | error GET https://api.example.com/v1/me',
          'ProfileView#2 Button | localization "common.ok"',
          'ProfileView#3 header > HStack > Text | GET https://api.example.com/v1/me display_name',
          'ProfileView#4 settings > Toggle | userDefaults "notificationsEnabled"',
          'ProfileView#5 settings > TextField | ProfileViewModel.nickname; label localization "profile.nickname" (en "Nickname", missing ja); placeholder localization "profile.nickname.placeholder" (en "Enter a nickname", ja "ニックネームを入力")',
          'ProfileView#6 settings > Button | localization "profile.logout"',
          'PointsBadge#1 VStack > PointsBadge > Label | GET https://api.example.com/v1/me points',
          'AvatarView#1 header > HStack > AvatarView > AsyncImage | GET https://api.example.com/v1/me avatar_url',
        ],
      );
      // The view model's loading code is an extension in another file too.
      const avatar = view.definition.items.at(-1)!.data[0]!.traced[0]!;
      assert.ok(
        avatar.steps.some((step) => step.symbol === 'ProfileViewModel.load()' && step.at.file.endsWith('ProfileViewModel+Loading.swift')),
      );

      // A text field's localized placeholder (UIKit `placeholder = NSLocalizedString(…)`).
      const controllerPlaceholder = defineScreen(engine, 'ProfileViewController');
      assert.ok('definition' in controllerPlaceholder);
      assert.equal(
        datasource(controllerPlaceholder.definition.items.find((item) => item.kind === 'UITextField')!),
        'placeholder localization "profile.nickname.placeholder" (en "Enter a nickname", ja "ニックネームを入力")',
      );
      // The alert shows while `showsError` is true, with the error of the request as its message.
      assert.deepEqual(view.definition.items[0]!.shownWhen, ['viewModel.showsError']);
      const profileFlows = screenFlows(engine, 'ProfileView');
      assert.ok('flows' in profileFlows);
      const [created, task] = profileFlows.flows.flows;
      // A read of a datasource names the variable it fills; the request's failure sets the alert.
      assert.equal(created!.summary.data[0]!.text, 'ProfileViewModel.notificationsEnabled ← read userDefaults "notificationsEnabled"');
      assert.deepEqual(
        task!.summary.data[0]!.failure.map((outcome) => `${outcome.target} ← ${outcome.value}`),
        ['ProfileViewModel.errorMessage ← error.localizedDescription', 'ProfileViewModel.showsError ← true'],
      );
      // UIKit: setup and bindings in extensions of the view controller.
      const controller = defineScreen(engine, 'ProfileViewController');
      assert.ok('definition' in controller);
      assert.deepEqual(
        controller.definition.items.map((item) => `${item.id} ${item.path.join('.')} ${item.at.file.split('/').at(-1)}`),
        [
          'ProfileViewController#1 nameLabel ProfileViewController+Binding.swift',
          'ProfileViewController#2 pointsLabel ProfileViewController+Binding.swift',
          'ProfileViewController#3 nicknameField ProfileViewController+Setup.swift',
          'ProfileViewController#4 logoutButton ProfileViewController+Setup.swift',
        ],
      );
      const flows = screenFlows(engine, 'ProfileViewController');
      assert.ok('flows' in flows);
      assert.deepEqual(
        flows.flows.flows.map((flow) => `${flow.kind} ${flow.item ?? ''}`.trim()),
        ['create', 'action ProfileViewController#4', 'lifecycle'],
      );
      const lifecycle = flows.flows.flows[2]!.steps.map((step) => step.text);
      for (const text of [
        'ProfileViewController.setupViews()',
        'ProfileViewController.bind()',
        'nameLabel.text = name',
        'ProfileViewModel.load()',
      ]) {
        assert.ok(lifecycle.includes(text), text);
      }
      golden('ProfileView.define.txt', defineText(db, root, { screen: 'ProfileView' }) + '\n');
      golden('ProfileViewController.flows.txt', flowsText(db, root, { screen: 'ProfileViewController' }) + '\n');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('flows: entry points of a screen and their steps through the layers', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    cpSync(FIXTURE, root, { recursive: true });
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const result = screenFlows(engine, 'ProductListViewController');
      assert.ok('flows' in result);
      const flows = result.flows.flows;
      assert.deepEqual(
        flows.map((flow) => `${flow.id} ${flow.kind} ${flow.item ?? ''}`.trim()),
        ['ProductListViewController/F1 action ProductListViewController#4', 'ProductListViewController/F2 lifecycle'],
      );
      // The refresh button: Task → view model → repository and service through DI → Keychain and API.
      const action = flows[0]!.steps;
      const step = (text: string) => action.find((candidate) => candidate.text.startsWith(text))!;
      assert.equal(step('Task').async, true);
      assert.equal(step('ProductListViewModel.reload()').layer, 'ViewModel');
      assert.ok(
        step('ProductRepositoryImpl.products()').notes.some((note) => note.startsWith('DI: ProductRepository → ProductRepositoryImpl')),
      );
      assert.equal(step('TokenStore.read').layer, 'local.keychain');
      assert.ok(step('serializingDecodable').notes.includes('GET "https://api.example.com/v1/products"'));
      assert.ok(step('UserDefaults.set').notes.includes('key "lastUpdated"'));
      // Writes of the flow and the items of `define` that show them.
      assert.deepEqual(flows[0]!.shown.find((shown) => shown.property === 'ProductListViewModel.rows')!.items, [
        'ProductListViewController#5',
        'ProductCell#1',
        'ProductCell#2',
      ]);
      // viewDidLoad: the sink on `$title` runs later and writes the label.
      const lifecycle = flows[1]!.steps;
      const sink = lifecycle.find((candidate) => candidate.text.startsWith('viewModel.$title.sink'))!;
      assert.equal(sink.async, true);
      assert.ok(lifecycle.some((candidate) => candidate.kind === 'write' && candidate.text === 'titleLabel.text = title'));

      // Error handling of the refresh: both catch blocks; the profile flow shows an alert on failure.
      assert.deepEqual(flows[0]!.errors, [
        'catch let error as AFError → ProductListViewModel.errorMessage = error.errorDescription',
        'catch → ProductListViewModel.rows = []',
        'catch → ProductListViewModel.errorMessage = error.localizedDescription',
      ]);
      const profile = screenFlows(engine, 'ProfileView');
      assert.ok('flows' in profile);
      assert.ok(profile.flows.flows.some((flow) => flow.errors.includes('catch → ProfileViewModel.showsError = true')));
      // Summary: success with the mapping from JSON fields, failure from the catch blocks.
      const summary = flows[0]!.summary;
      assert.deepEqual(summary.path.slice(-3), [
        'keychain "accessToken"',
        'GET https://api.example.com/v1/products',
        'SettingsStore.markUpdated(_:)',
      ]);
      const rows = summary.success.find((outcome) => outcome.target === 'ProductListViewModel.rows')!;
      assert.equal(rows.mapping?.mappedTo, 'ProductRowViewData');
      assert.deepEqual(rows.mapping?.fields, [
        { field: 'name', from: 'items[].product_name' },
        { field: 'price', from: 'items[].price', computed: true },
      ]);
      assert.deepEqual(
        summary.failure.map((outcome) => `${outcome.when} → ${outcome.target}`),
        [
          'catch let error as AFError → ProductListViewModel.errorMessage',
          'catch → ProductListViewModel.rows',
          'catch → ProductListViewModel.errorMessage',
        ],
      );
      assert.deepEqual(summary.stores, ['userDefaults "lastUpdated"  (UserDefaults.set)']);
      // Data view: one step per get/set of data, the layers in between left out.
      assert.deepEqual(
        summary.data.map((step) => `${step.number} ${step.kind} ${step.text}`),
        [
          '1 viewModel ProductListViewModel.errorMessage ← nil',
          '2 keychain read keychain "accessToken"',
          '3 api GET https://api.example.com/v1/products → ProductListResponse',
          '4 userDefaults write userDefaults "lastUpdated" ← Date()',
        ],
      );
      assert.deepEqual(
        summary.data[2]!.success.map((outcome) => outcome.target),
        ['ProductListViewModel.title', 'ProductListViewModel.rows', 'ProductListViewModel.lastUpdated'],
      );
      assert.equal(summary.data[2]!.failure.length, 3);
      // Numbered steps: success and failure sit on the request that can fail.
      const request = summary.steps.find((step) => step.text.startsWith('GET https://api.example.com/v1/products'))!;
      assert.equal(request.number, 7);
      assert.equal(request.failable, true);
      assert.ok(request.success.some((outcome) => outcome.target === 'ProductListViewModel.rows'));
      assert.equal(request.failure.length, 3);
      assert.deepEqual(
        summary.steps.map((step) => `${step.number} ${step.depth} ${step.layer}`),
        // The Task, and the `map` that builds the rows from the response, are steps too.
        [
          '1 0 View',
          '2 1 View',
          '3 2 ViewModel',
          '4 3 Repository',
          '5 4 Service',
          '6 5 keychain',
          '7 5 api',
          '8 3 ViewModel',
          '9 3 Storage',
          '10 4 userDefaults',
        ],
      );
      // Only the view model and the repository: the request becomes a note of the repository step, with its outcomes.
      const layered = screenFlows(engine, 'ProductListViewController', { layers: ['ViewModel', 'repository'] });
      assert.ok('flows' in layered);
      assert.equal(layered.flows.flows.length, 1);
      const [viewModelStep, repositoryStep] = layered.flows.flows[0]!.summary.steps;
      assert.deepEqual(
        [viewModelStep!.text, repositoryStep!.text, repositoryStep!.depth],
        ['ProductListViewModel.reload()', 'ProductRepositoryImpl.products()', 1],
      );
      assert.deepEqual(repositoryStep!.notes.slice(1), [
        '→ read "accessToken"',
        '→ GET https://api.example.com/v1/products → ProductListResponse',
      ]);
      assert.ok(repositoryStep!.success.some((outcome) => outcome.target === 'ProductListViewModel.rows'));
      assert.equal(repositoryStep!.failure.length, 3);
      const entry = screenFlows(engine, 'ProductListViewController', { entry: 'ProductListViewController#4' });
      assert.ok('flows' in entry && entry.flows.flows.length === 1);

      golden('ProductListView.flows.txt', flowsText(db, root, { screen: 'ProductListView' }) + '\n');
      golden('ProductListViewController.flows.txt', flowsText(db, root, { screen: 'ProductListViewController' }) + '\n');
      const compact = flowsText(db, root, { screen: 'ProductListViewController', format: 'compact' });
      golden('ProductListViewController.flows-compact.txt', compact + '\n');
      // Compact: the API host, the view model and DI bindings once in the legend; no column padding.
      assert.ok(compact.includes('# api = https://api.example.com') && compact.includes('# vm = ProductListViewModel'));
      // Padding only as nesting: at the start of a line or right after a step number.
      assert.ok(
        compact.includes('GET /v1/products') && compact.split('\n').every((line) => !/\S {2,}/.test(line.replace(/^\s*\d+ +/, ''))),
      );
      assert.match(
        flowsText(db, root, { screen: 'ProductListView', entry: 'ProductListView/F2', format: 'mermaid' }),
        /View->>ViewModel: await ProductListViewModel.reload\(\)/,
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

// The sample of docs/05-data-flow.md (sections 2 and 6). It is not tracked, so the test is skipped without it.
test(
  'define and flows on the generic mapper sample',
  { skip: !existsSync(CUSTOM) && 'test/fixtures/custom-clean-app is not present' },
  async () => {
    const { path, cleanup } = temporaryDirectory();
    try {
      const root = join(path, 'custom-clean-app');
      cpSync(CUSTOM, root, { recursive: true });
      await build(root, { workers: 1 });
      const db = openDatabase(databasePath(root), { readonly: true });
      try {
        const engine = new FlowEngine(db, root);
        const definition = defineScreen(engine, 'LoginView');
        assert.ok('definition' in definition);
        const state = definition.definition.conditions.find((condition) => condition.expression === 'vm.state')!;
        const main = state.writes.find((write) => write.value === '.main')!;
        // `.main` comes from a mapper reached through a generic receiver; the cast before it always fails.
        assert.equal(main.symbol, 'RegisterViewModelMapper.mapping(_:)');
        assert.ok(main.unreachable?.startsWith('cast AnonymousSession → String always fails'));
        const decoded = main.because.find((traced) => traced.origin.kind === 'source')!;
        assert.equal(decoded.origin.kind === 'source' && decoded.origin.api, 'JSONDecoder.decode');
        assert.equal(decoded.origin.kind === 'source' && decoded.origin.type?.text, 'AnonymousSession');

        const flows = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in flows);
        const steps = flows.flows.flows[0]!.steps;
        const anonymous = steps.find((step) => step.text === 'LoginUseCaseImpl.anonymous(_:)')!;
        assert.ok(anonymous.notes.includes('Mapper = AnonymousViewModelMapper'));
        assert.ok(steps.some((step) => step.text === 'LoginViewModel.state = .main'));

        golden('LoginView.define.txt', defineText(db, root, { screen: 'LoginView' }) + '\n', 'custom-clean-app');
        golden('LoginView.flows.txt', flowsText(db, root, { screen: 'LoginView' }) + '\n', 'custom-clean-app');
        // View → Repository with everything in between: the subscription that handles the response and the mapper behind the cast.
        const until = screenFlows(engine, 'LoginView', { entry: 'LoginView#5', until: 'Repository' });
        assert.ok('flows' in until);
        const untilSteps = until.flows.flows[0]!.summary.steps;
        assert.deepEqual(
          untilSteps.map((step) => `${step.number} ${step.layer} ${step.text}`),
          [
            '1 ViewModel LoginViewModel.anonymousSession()',
            '2 UseCase LoginUseCaseImpl.anonymous(_:)',
            '3 Mapper AnonymousEntityMapper.init()',
            '4 Repository LoginRepositoryImpl.anonymousSession(_:)',
            '5 UseCase sink async',
            '6 Mapper AnonymousViewModelMapper.mapping(_:)',
          ],
        );
        assert.equal(untilSteps[3]!.handledBy, 5);
        assert.ok(untilSteps[3]!.notes.includes('→ api JSONDecoder.decode(AnonymousSession)'));
        assert.equal(untilSteps[5]!.when, 'let domain = domain as? Mapper.EntityResult');
        golden(
          'LoginView.flows-until-repository.txt',
          flowsText(db, root, { screen: 'LoginView', until: 'Repository', format: 'compact' }) + '\n',
          'custom-clean-app',
        );
        // Failure handlers that change no data are left out of the data view.
        const loginData = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in loginData);
        const decode = loginData.flows.flows[0]!.summary.data;
        assert.equal(decode.length, 1);
        assert.deepEqual(decode[0]!.failure, []);
        assert.ok(decode[0]!.success[0]!.never?.startsWith('cast AnonymousSession → String always fails'));
        golden('LoginView.flows-calls.txt', flowsText(db, root, { screen: 'LoginView', calls: true }) + '\n', 'custom-clean-app');
        golden('LoginView.flows-steps.txt', flowsText(db, root, { screen: 'LoginView', steps: true }) + '\n', 'custom-clean-app');
        // The Login action stops at the cast that always fails: `.main` is never written.
        const login = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in login);
        const writeMain = login.flows.flows[0]!.summary.success.find((outcome) => outcome.target === 'LoginViewModel.state')!;
        assert.ok(writeMain.never?.startsWith('cast AnonymousSession → String always fails'));
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  },
);

test('define: SwiftData @Query and Core Data @FetchRequest are datasources', async () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    mkdirSync(join(root, 'App'));
    writeFileSync(
      join(root, 'App', 'Notes.swift'),
      `import SwiftUI
import SwiftData
import CoreData

@Model final class Note { var title: String = "" }

struct NotesView: View {
    @Query var notes: [Note]
    var body: some View {
        List(notes) { note in Text(note.title) }
    }
}

struct TasksView: View {
    @FetchRequest(sortDescriptors: []) var tasks: FetchedResults<TaskEntity>
    var body: some View {
        Text(tasks.first?.name ?? "")
    }
}
`,
    );
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const notes = defineScreen(engine, 'NotesView');
      assert.ok('definition' in notes);
      assert.deepEqual(notes.definition.items.map(datasource), ['swiftData [Note]', 'swiftData [Note][].title']);
      const tasks = defineScreen(engine, 'TasksView');
      assert.ok('definition' in tasks);
      assert.deepEqual(tasks.definition.items.map(datasource), ['coreData FetchedResults<TaskEntity>[].name']);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
