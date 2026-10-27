import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { viewData, viewHtml } from '../src/view/view.ts';
import { fixtureCopy } from './helpers.ts';

test('the view is one self-contained page that cannot reach the network', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    const data = viewData(db, 'mini-app');
    db.close();
    assert.ok(data.nodes.some((node) => node[1] === 'Core.Store'));
    assert.ok(data.edges.length > 0);
    for (const node of data.nodes) assert.ok(Number.isFinite(node[5]) && Number.isFinite(node[6]));

    const html = viewHtml({ ...data, title: '</script><script>alert(1)</script>' });
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.doesNotMatch(html, /\b(src|href)=["']?https?:/);
    // Embedded data cannot close its script element.
    assert.equal(html.split('</script>').length - 1, 2);
  } finally {
    cleanup();
  }
});
