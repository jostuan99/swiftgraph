import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover, globToRegExp, lprojLanguage } from '../src/discover/discover.ts';
import { manifestTargets, moduleForPath, productModuleName } from '../src/discover/package-manifest.ts';
import { fixtureCopy, temporaryDirectory } from './helpers.ts';

test('lists only Swift and localization files', () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const { files } = discover(root);
    assert.deepEqual(
      files.map((file) => `${file.path} ${file.kind} ${file.language ?? '-'} ${file.module}`),
      [
        'Package.swift swift - mini-app',
        'Sources/App/AppView.swift swift - App',
        'Sources/App/ItemRow.swift swift - App',
        'Sources/App/MiniApp.swift swift - App',
        'Sources/App/Resources/Settings.xcstrings xcstrings - App',
        'Sources/App/Resources/en.lproj/Localizable.strings strings en App',
        'Sources/App/Resources/en.lproj/Localizable.stringsdict stringsdict en App',
        'Sources/App/Resources/vi.lproj/Localizable.strings strings vi App',
        'Sources/Core/Formatting.swift swift - Core',
        'Sources/Core/Logger.swift swift - Core',
        'Sources/Core/Model.swift swift - Core',
        'Sources/Core/Store+Observation.swift swift - Core',
        'Sources/Core/Store.swift swift - Core',
        'Tests/AppTests/StoreTests.swift swift - AppTests',
      ],
    );
  } finally {
    cleanup();
  }
});

test('skips excluded directories, symbolic links and large files', () => {
  const { root, cleanup } = fixtureCopy();
  try {
    mkdirSync(join(root, '.build'), { recursive: true });
    writeFileSync(join(root, '.build', 'Generated.swift'), 'let x = 1\n');
    mkdirSync(join(root, 'Pods', 'Lib'), { recursive: true });
    writeFileSync(join(root, 'Pods', 'Lib', 'Lib.swift'), 'let y = 1\n');
    mkdirSync(join(root, 'Generated'), { recursive: true });
    writeFileSync(join(root, 'Generated', 'Big.swift'), 'let z = 1\n');
    symlinkSync(join(root, 'Sources', 'Core', 'Model.swift'), join(root, 'Sources', 'Core', 'Link.swift'));
    symlinkSync(join(root, 'Sources'), join(root, 'LinkedSources'));

    const { files, skippedLarge } = discover(root, {
      exclude: ['Generated/**'],
      sizeLimits: { swift: 600 },
    });
    const paths = files.map((file) => file.path);
    assert.ok(!paths.some((path) => path.startsWith('.build/') || path.startsWith('Pods/')));
    assert.ok(!paths.some((path) => path.startsWith('Generated/')));
    assert.ok(!paths.includes('Sources/Core/Link.swift'));
    assert.ok(!paths.some((path) => path.startsWith('LinkedSources/')));
    assert.ok(skippedLarge.includes('Sources/Core/Store.swift'));
    assert.ok(!paths.includes('Sources/Core/Store.swift'));
  } finally {
    cleanup();
  }
});

test('reads targets from Package.swift', () => {
  const targets = manifestTargets(`
    let package = Package(name: "P", targets: [
      .target(name: "Core", path: "Sources/Core"),
      .executableTarget(name: "App", dependencies: ["Core"]),
      .testTarget(name: "AppTests"),
      .target(name: "Dynamic", path: "Sources/\\(name)"),
    ])
  `);
  assert.deepEqual(targets, [
    { name: 'Core', path: 'Sources/Core', factory: 'target' },
    { name: 'App', path: null, factory: 'executableTarget' },
    { name: 'AppTests', path: null, factory: 'testTarget' },
    { name: 'Dynamic', path: null, factory: 'target' },
  ]);
});

test('module overrides win over the manifest and conventions', () => {
  const map = {
    entries: [
      { directory: 'Sources/App', module: 'App', source: 'manifest' as const },
      { directory: 'Sources/App/Legacy', module: 'Legacy', source: 'override' as const },
    ],
    rootModule: 'Repo',
  };
  assert.equal(moduleForPath(map, 'Sources/App/View.swift'), 'App');
  assert.equal(moduleForPath(map, 'Sources/App/Legacy/Old.swift'), 'Legacy');
  assert.equal(moduleForPath(map, 'Sources/Other/File.swift'), 'Other');
  assert.equal(moduleForPath(map, 'Shared/File.swift'), 'Shared');
  assert.equal(moduleForPath(map, 'main.swift'), 'Repo');
});

test('infers modules from the folders next to an Xcode project', () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    const write = (path: string, text = 'struct S {}\n') => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('ios/My App.xcodeproj/project.pbxproj', 'not read');
    write('ios/My App/Views/Home.swift');
    write('ios/My App/en.lproj/Localizable.strings', '"a" = "b";\n');
    write('ios/My AppTests/HomeTests.swift');
    write('ios/Widgets/Legacy/Old.swift');
    write('ios/AppDelegate.swift');
    write('Example/iOS Example.xcodeproj/project.pbxproj', 'not read');
    write('Example/Source/AppDelegate.swift');
    write('Shared/Util.swift');

    for (const gitTrackedOnly of [false, true]) {
      if (gitTrackedOnly) execFileSync('git', ['init', '-q'], { cwd: root });
      const { files } = discover(root, { gitTrackedOnly, modules: { 'ios/Widgets/Legacy': 'Legacy' } });
      assert.deepEqual(
        files.map((file) => `${file.path} ${file.module}`),
        [
          'Example/Source/AppDelegate.swift iOS_Example',
          'Shared/Util.swift Shared',
          'ios/AppDelegate.swift ios',
          'ios/My App/Views/Home.swift My_App',
          'ios/My App/en.lproj/Localizable.strings My_App',
          'ios/My AppTests/HomeTests.swift My_AppTests',
          // An override inside the folder wins; the rest falls back to conventions.
          'ios/Widgets/Legacy/Old.swift Legacy',
        ],
      );
    }
  } finally {
    cleanup();
  }
});

test('helpers', () => {
  assert.equal(productModuleName('My App-iOS'), 'My_App_iOS');
  assert.equal(productModuleName('2D'), '_2D');
  assert.equal(lprojLanguage('A/vi.lproj/Localizable.strings'), 'vi');
  assert.equal(lprojLanguage('A/Base.lproj/Main.strings'), 'Base');
  assert.equal(lprojLanguage('A/Localizable.strings'), null);
  assert.ok(globToRegExp('Generated/**').test('Generated/a/b.swift'));
  assert.ok(globToRegExp('**/*.generated.swift').test('a/b/c.generated.swift'));
  assert.ok(!globToRegExp('*.swift').test('a/b.swift'));
});
