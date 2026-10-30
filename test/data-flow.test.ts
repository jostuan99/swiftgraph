import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.ts';
import { defineText, flowsText, rulesText } from '../src/flow/commands.ts';
import { defineScreen } from '../src/flow/define.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { datasource, valueSource } from '../src/flow/format-define.ts';
import { screenFlows } from '../src/flow/flows.ts';
import { loadRules } from '../src/rules/load.ts';
import { parse as parseYaml } from 'yaml';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { copyFixture, temporaryDirectory } from './helpers.ts';

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
    copyFixture(FIXTURE, root);
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
          'ProductListView#3 Text',
          'ProductRow#1 Text ProductListView#2',
          'ProductRow#2 Text ProductListView#2',
        ],
      );
      // The destination of a NavigationLink is another screen: listed, its items left out.
      assert.deepEqual(
        list.definition.children.map((child) => `${child.name} ${child.how}`),
        ['ProfileView navigation', 'ProductRow row of List'],
      );
      // Pushed and presented screens (a view controller, a SwiftUI view in UIHostingController) too.
      const pushing = defineScreen(engine, 'ProductListViewController');
      assert.ok('definition' in pushing);
      assert.deepEqual(
        pushing.definition.children.map((child) => `${child.name} ${child.how} ${child.transition ?? ''}`.trim()),
        ['ProductCell cell of ProductListViewController#5', 'ProfileViewController navigation push', 'ProfileView navigation modal'],
      );
      assert.ok(pushing.definition.items.every((item) => !item.owner.startsWith('Profile')));
      // flows: OUTPUT, each push or modal with its trigger and condition; INPUT, what callers pass and where it comes from.
      const pushingFlows = screenFlows(engine, 'ProductListViewController');
      assert.ok('flows' in pushingFlows && pushingFlows.flows.io);
      assert.deepEqual(
        pushingFlows.flows.io.outputs.map(
          (output) => `${output.id} ${output.transition} ${output.to} ${output.trigger} ${output.when.join(' && ')}`,
        ),
        [
          'O1 push ProfileViewController tableView(_:didSelectRowAt:) indexPath.row == 0',
          'O2 modal ProfileView tableView(_:didSelectRowAt:) !(indexPath.row == 0)',
        ],
      );
      // `init(coder:)` is left out by the uikit preset.
      assert.deepEqual(
        pushingFlows.flows.io.inputs.map((input) => `${input.name} ${input.kind} ${input.selector} ${input.property}`),
        ['viewModel init init(viewModel:) viewModel'],
      );
      const listFlows = screenFlows(engine, 'ProductListView');
      assert.ok('flows' in listFlows && listFlows.flows.io);
      const linked = listFlows.flows.io.outputs[0]!;
      assert.equal(`${linked.transition} ${linked.to} ${linked.trigger}`, 'push ProfileView ProductListView#3 tap');
      assert.equal(valueSource(linked.arguments[0]!.traced), 'GET https://api.example.com/v1/products title');
      const profileIO = screenFlows(engine, 'ProfileView');
      assert.ok('flows' in profileIO && profileIO.flows.io);
      assert.deepEqual(
        profileIO.flows.io.inputs.map((input) => `${input.name}: ${input.type} ${input.kind} = ${input.default}`),
        ['title: String memberwise = ""'],
      );
      assert.deepEqual(
        profileIO.flows.io.callers.map(
          (caller) => `${caller.from} ${caller.transition} ${caller.arguments.map((argument) => argument.label).join(',')}`,
        ),
        ['ProductListView push title', 'ProductListViewController modal '],
      );
      // One flow (`entry`): no INPUT or OUTPUT.
      const one = screenFlows(engine, 'ProductListViewController', { entry: 'ProductListViewController/F1' });
      assert.ok('flows' in one && one.flows.io === undefined);
      // define lists the screens shown as children, not INPUT or OUTPUT.
      assert.ok(!defineText(db, root, { screen: 'ProductListViewController' }).includes('OUTPUT'));
      // A row's text: from the API (Alamofire, JSON key from CodingKeys) and from the file cache.
      const name = items.find((item) => item.id === 'ProductRow#1')!.data[0]!.traced;
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
      assert.equal(
        datasource(items.find((item) => item.id === 'ProductRow#1')!),
        'GET https://api.example.com/v1/products items[].product_name',
      );

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
    copyFixture(FIXTURE, root);
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

test('flows: project rules for INPUT (an input method) and OUTPUT (a fixed screen, a project transition)', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    copyFixture(FIXTURE, root);
    const config = parseYaml(readFileSync(join(root, 'swiftgraph.json'), 'utf8'));
    config.inputs = [{ id: 'app.configure', kind: 'configure', method: 'configure(with:)', match: { name: '*Cell' } }];
    config.navigation = [
      { id: 'app.reload', call: 'ProductListViewModel.reload()', destination: [], to: 'ProfileViewController', transition: 'replace' },
    ];
    writeFileSync(join(root, 'swiftgraph.json'), JSON.stringify(config));
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const cell = screenFlows(engine, 'ProductCell');
      assert.ok('flows' in cell && cell.flows.io);
      assert.deepEqual(
        cell.flows.io.inputs.map((input) => `${input.name}: ${input.type} ${input.kind} ${input.selector}`),
        ['row: ProductRowViewData configure configure(with:)'],
      );
      assert.deepEqual(
        cell.flows.io.callers.map(
          (caller) => `${caller.from} ${caller.selector} ${caller.arguments.map((argument) => argument.value).join(',')}`,
        ),
        ['ProductListViewController configure(with:) viewModel.rows[]'],
      );
      const list = screenFlows(engine, 'ProductListViewController');
      assert.ok('flows' in list && list.flows.io);
      assert.deepEqual(
        list.flows.io.outputs.map((output) => `${output.transition} ${output.to} ${output.trigger}`),
        [
          'replace ProfileViewController didTapRefresh()',
          'push ProfileViewController tableView(_:didSelectRowAt:)',
          'modal ProfileView tableView(_:didSelectRowAt:)',
        ],
      );
      assert.ok(flowsText(db, root, { screen: 'ProductListViewController' }).includes('O1 | replace | ProfileViewController |'));
      // rules: the rules in effect as a swiftgraph.json template; --write keeps the file's other keys.
      const template = parseYaml(rulesText(db, root));
      assert.match(rulesText(db, root), /^  - \{ id: swift\.init, kind: init, initializer: init\(\* \}$/m);
      assert.deepEqual(Object.keys(template), ['extends', 'inputs', 'navigation', 'localization']);
      // The default language found in the project, as a rule to edit.
      assert.deepEqual(template.localization, [{ id: 'project.default-language.CleanApp', module: 'CleanApp', defaultLanguage: 'en' }]);
      assert.equal(template.inputs[0].id, 'app.configure');
      assert.ok(template.inputs.some((rule: { id: string }) => rule.id === 'swift.init'));
      assert.ok(!('origin' in template.inputs[0]));
      assert.throws(() => rulesText(db, root, ['bogus']), /unknown rule kind "bogus"/);
      rulesText(db, root, ['inputs'], true);
      const written = parseYaml(readFileSync(join(root, 'swiftgraph.json'), 'utf8'));
      assert.equal(written.sources[0].id, 'app.token-read');
      assert.equal(written.navigation[0].id, 'app.reload');
      assert.ok(written.inputs.some((rule: { id: string }) => rule.id === 'swiftui.binding'));
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
    copyFixture(FIXTURE, root);
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
          'ProfileView#2 Button | localized "OK"',
          'ProfileView#3 header > HStack > Text | GET https://api.example.com/v1/me display_name',
          'ProfileView#4 settings > Toggle | userDefaults "notificationsEnabled"',
          'ProfileView#5 settings > TextField | ProfileViewModel.nickname; label localized "Nickname"; placeholder localized "Enter a nickname"',
          'ProfileView#6 settings > Button | localized "Log out"',
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
        'placeholder localized "Enter a nickname"',
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
    copyFixture(FIXTURE, root);
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const result = screenFlows(engine, 'ProductListViewController');
      assert.ok('flows' in result);
      const flows = result.flows.flows;
      assert.deepEqual(
        flows.map((flow) => `${flow.id} ${flow.kind} ${flow.item ?? ''}`.trim()),
        [
          'ProductListViewController/F1 action ProductListViewController#4',
          'ProductListViewController/F2 lifecycle',
          'ProductListViewController/F3 action',
        ],
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
      copyFixture(CUSTOM, root);
      await build(root, { workers: 1 });
      const db = openDatabase(databasePath(root), { readonly: true });
      try {
        const engine = new FlowEngine(db, root);
        const definition = defineScreen(engine, 'LoginView');
        assert.ok('definition' in definition);
        // `Localization.loginFirstName.localized`: the raw value of the case is the key (rule in the fixture's swiftgraph.json).
        const placeholder = definition.definition.items[0]!.data.find((data) => data.role === 'placeholder')!.traced[0]!.origin;
        assert.ok(placeholder.kind === 'localization');
        assert.equal(placeholder.key, 'loginFirstName');
        // `developmentRegion = ja` in project.pbxproj: the default language, listed first.
        assert.equal(placeholder.defaultLanguage, 'ja');
        assert.equal(placeholder.values[0]!.language, 'ja');
        assert.deepEqual(placeholder.missing, []);
        // A router method around pushViewController/present: the transition and the screen shown, not the router's code.
        assert.deepEqual(
          definition.definition.children.map((child) => `${child.name} ${child.how} ${child.transition}`),
          ['DetailView navigation push', 'DetailView navigation modal'],
        );
        const routed = screenFlows(engine, 'LoginView');
        assert.ok('flows' in routed && routed.flows.io);
        assert.deepEqual(
          routed.flows.io.outputs.map((output) => `${output.transition} ${output.to} ${output.trigger} via ${output.via}`),
          [
            'push DetailView LoginView#6 .onTapGesture via BaseRoutingManager.push(_:animated:)',
            'modal DetailView LoginView#7 .onTapGesture via BaseRoutingManager.sheet(_:animated:dismiss:)',
          ],
        );
        const taps = routed.flows.flows.filter((flow) => flow.title.includes('onTapGesture'));
        assert.deepEqual(
          taps.map((flow) => flow.steps.map((step) => `${step.kind} ${step.text} ${step.notes.join(';')}`.trim())),
          [
            ['closure onTapGesture closure', 'navigation push DetailView via BaseRoutingManager.push(_:animated:)'],
            ['closure onTapGesture closure', 'navigation modal DetailView via BaseRoutingManager.sheet(_:animated:dismiss:)'],
          ],
        );

        const flows = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in flows);
        const steps = flows.flows.flows[0]!.steps;
        const anonymous = steps.find((step) => step.text === 'LoginUseCaseImpl.anonymous(_:)')!;
        assert.ok(anonymous.notes.includes('Mapper = AnonymousViewModelMapper'));
        assert.ok(steps.some((step) => step.text === 'LoginViewModel.state = .main'));

        golden('LoginView.define.txt', defineText(db, root, { screen: 'LoginView' }) + '\n', 'custom-clean-app');
        golden('LoginView.flows.txt', flowsText(db, root, { screen: 'LoginView' }) + '\n', 'custom-clean-app');
        // View → Repository with everything in between: the subscription that handles the response, the mapper behind the cast and the register call it starts.
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
            '7 ViewModel LoginViewModel.login()',
            '8 UseCase LoginUseCaseImpl.register(_:)',
            '9 Mapper RegisterViewModelMapper.getRequest()',
            '10 Mapper RegisterEntityMapper.init(_:)',
            '11 Mapper RegisterEntityMapper.domainToRequest(_:)',
            '12 Repository LoginRepositoryImpl.register(_:)',
            '13 UseCase sink async',
            '14 Mapper RegisterViewModelMapper.mapping(_:)',
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
        // Failure handlers that change no data are left out of the data view: the empty
        // AnonymousViewModelMapper.error(_:) is not listed under the first decode.
        const loginData = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in loginData);
        const decode = loginData.flows.flows[0]!.summary.data;
        assert.deepEqual(
          decode.map((data) => data.failure.map((outcome) => `${outcome.when} → ${outcome.target}`)),
          [
            ['cast fails (request) → LoginViewModel.error'],
            ['on failure → LoginViewModel.error', 'cast fails (domain) → LoginViewModel.error'],
          ],
        );
        golden('LoginView.flows-calls.txt', flowsText(db, root, { screen: 'LoginView', calls: true }) + '\n', 'custom-clean-app');
        golden('LoginView.flows-steps.txt', flowsText(db, root, { screen: 'LoginView', steps: true }) + '\n', 'custom-clean-app');
        // The Login action runs the anonymous session, then login() and register(_:): the register mapper writes `.main`.
        const login = screenFlows(engine, 'LoginView', { entry: 'LoginView#5' });
        assert.ok('flows' in login);
        const writeMain = login.flows.flows[0]!.summary.success.find((outcome) => outcome.target === 'LoginViewModel.state')!;
        assert.equal(writeMain.value, '.main');
        assert.equal(writeMain.at.file, 'SampleArchitecture/RegisterViewModelMapper.swift');
        assert.equal(writeMain.never, undefined);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  },
);

test('define: localization keys from an enum, a struct property or a string, by `sources` rules with keyFrom', async () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    mkdirSync(join(root, 'App', 'en.lproj'), { recursive: true });
    writeFileSync(
      join(root, 'App', 'en.lproj', 'Localizable.strings'),
      `"login.title" = "Login";
"login.button" = "Sign in";
"custom.key" = "Custom";
"plain.key" = "Plain";
"Settings" = "Settings";
`,
    );
    writeFileSync(
      join(root, 'App', 'Keys.swift'),
      `import Foundation

enum L10n: String {
    case title = "login.title"
    case button = "login.button"
    func text() -> String { Bundle.main.localizedString(forKey: rawValue, value: nil, table: nil) }
}

enum Screen {
    case Settings
    var title: String { "" }
}

struct LocalizedKey {
    let key: String
    var text: String { NSLocalizedString(key, comment: "") }
}

extension String {
    var localized: String { NSLocalizedString(self, comment: "") }
}
`,
    );
    writeFileSync(
      join(root, 'App', 'LoginView.swift'),
      `import SwiftUI

struct LoginView: View {
    let flag: Bool
    var body: some View {
        let key = flag ? L10n.title : L10n.button
        VStack {
            Text(L10n.title.text())
            Text(key.text())
            Text(Screen.Settings.title)
            Text(LocalizedKey(key: "custom.key").text)
            Text("plain.key".localized)
        }
    }
}
`,
    );
    writeFileSync(
      join(root, 'swiftgraph.json'),
      `{
  "sources": [
    { "id": "app.l10n", "kind": "localization", "call": "L10n.text()", "keyFrom": "rawValue" },
    { "id": "app.screen", "kind": "localization", "member": "Screen.title", "keyFrom": "case" },
    { "id": "app.key", "kind": "localization", "member": "LocalizedKey.text", "keyFrom": "key" },
    { "id": "app.string", "kind": "localization", "member": "String.localized", "keyFrom": "self" }
  ]
}
`,
    );
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const login = defineScreen(engine, 'LoginView');
      assert.ok('definition' in login);
      // Raw value of the case (a method call, a variable holding either case), the case name, a struct property, the string itself.
      assert.deepEqual(
        login.definition.items.map((item) =>
          item.data[0]!.traced.map((traced) => (traced.origin.kind === 'localization' ? traced.origin.key : traced.origin.kind)).join(
            ' | ',
          ),
        ),
        ['login.title', 'login.title | login.button', 'Settings', 'custom.key', 'plain.key'],
      );
      const title = login.definition.items[0]!.data[0]!.traced[0]!.origin;
      assert.ok(title.kind === 'localization');
      assert.deepEqual(title.values, [{ language: 'en', value: 'Login' }]);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('rules: a source rule on a member needs keyFrom; rule files in YAML', () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    writeFileSync(join(root, 'swiftgraph.json'), JSON.stringify({ sources: [{ kind: 'localization', member: 'Localization.localized' }] }));
    assert.throws(() => loadRules(root, new Set()), /needs "keyFrom"/);
    // YAML rule file; one rule file per project.
    writeFileSync(join(root, 'swiftgraph.yaml'), 'localization:\n  - { id: app.ja, defaultLanguage: ja }\n');
    assert.throws(() => loadRules(root, new Set()), /swiftgraph.yaml and swiftgraph.json: keep one rule file/);
    rmSync(join(root, 'swiftgraph.json'));
    const rules = loadRules(root, new Set());
    assert.equal(rules.localization[0]!.origin, 'swiftgraph.yaml');
    assert.equal(rules.localization[0]!.defaultLanguage, 'ja');
  } finally {
    cleanup();
  }
});

test('flows: OUTPUT parameters are the values the next screen receives, named by its parameters and properties', async () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    mkdirSync(join(root, 'App'));
    writeFileSync(
      join(root, 'App', 'Screens.swift'),
      `import UIKit
import SwiftUI

struct Item { let name: String }

final class DetailViewController: UIViewController {
    var item: Item?
    var source = ""
    func configure(with title: String) {}
}

struct RowView: View {
    let item: Item
    init(_ item: Item) { self.item = item }
    var body: some View { Text(item.name) }
}

final class ListViewController: UIViewController {
    let items: [Item] = []
    func open(_ index: Int) {
        let detail = DetailViewController()
        detail.item = items[index]
        detail.source = "list"
        detail.configure(with: "Detail")
        navigationController?.pushViewController(detail, animated: true)
    }
    func preview(_ index: Int) {
        present(UIHostingController(rootView: RowView(items[index])), animated: true)
    }
}
`,
    );
    writeFileSync(
      join(root, 'swiftgraph.json'),
      JSON.stringify({ inputs: [{ id: 'app.configure', kind: 'configure', method: 'configure(with:)' }] }),
    );
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const list = screenFlows(engine, 'ListViewController');
      assert.ok('flows' in list && list.flows.io);
      // Properties set and input methods called before the push; an unlabeled argument takes the parameter's name.
      assert.deepEqual(
        list.flows.io.outputs.map(
          (output) =>
            `${output.to}: ${output.arguments.map((argument) => `${argument.via ? `${argument.via} ` : ''}${argument.label}=${argument.value}`).join(', ')}`,
        ),
        ['DetailViewController: property item=items[], property source="list", configure(with:) title="Detail"', 'RowView: item=items[]'],
      );
      // The next screen lists the properties its creators set as INPUT.
      const detail = screenFlows(engine, 'DetailViewController');
      assert.ok('flows' in detail && detail.flows.io);
      assert.deepEqual(
        detail.flows.io.inputs.map((input) => `${input.name} ${input.kind}`),
        ['title configure', 'item property', 'source property'],
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('define: a localization rule sets the default language; items show its text', async () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const root = join(path, 'clean-app');
    copyFixture(FIXTURE, root);
    const config = parseYaml(readFileSync(join(root, 'swiftgraph.json'), 'utf8'));
    config.localization = [{ id: 'app.ja', module: 'Clean*', defaultLanguage: 'ja' }];
    writeFileSync(join(root, 'swiftgraph.json'), JSON.stringify(config));
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const engine = new FlowEngine(db, root);
      const view = defineScreen(engine, 'ProfileView');
      assert.ok('definition' in view);
      const nickname = view.definition.items.find((item) => item.id === 'ProfileView#5')!;
      // The Japanese text.
      assert.equal(
        datasource(nickname),
        'ProfileViewModel.nickname; label localized "プロフィール"; placeholder localized "ニックネームを入力"',
      );
      // `missing` for a key without Japanese text: the app shows the key.
      const list = defineScreen(engine, 'ProductListView');
      assert.ok('definition' in list);
      assert.equal(datasource(list.definition.items[0]!), 'localized missing');
      // A module the project's rule covers gets no rule from the project files in the template.
      assert.deepEqual(parseYaml(rulesText(db, root, ['localization'])).localization, [
        { id: 'app.ja', module: 'Clean*', defaultLanguage: 'ja' },
      ]);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

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
