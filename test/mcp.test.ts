import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { build } from '../src/build.ts';
import { createServer } from '../src/mcp.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

test('MCP tools answer over an in-memory transport', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    const server = createServer(db, root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'find_path',
        'get_callees',
        'get_callers',
        'get_community',
        'get_impact',
        'get_localization_issues',
        'get_neighbors',
        'get_screen_definition',
        'get_screen_flows',
        'get_source',
        'get_string',
        'get_strings_for_symbol',
        'get_symbol',
        'graph_overview',
        'search_strings',
        'search_symbols',
      ]);
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return { text: (result.content as { text: string }[])[0]!.text, isError: result.isError === true };
      };
      assert.match((await call('graph_overview', {})).text, /# Code graph: mini-app/);
      assert.match((await call('get_symbol', { symbol: 'Store.send(_:)' })).text, /→ CALLS \(2\)/);
      assert.match((await call('get_callers', { symbol: 'Store.send(_:)', depth: 1 })).text, /App\.AppView\.body/);
      assert.match((await call('get_string', { key: 'add_button' })).text, /vi {2}"Thêm %@"/);
      assert.match((await call('get_strings_for_symbol', { symbol: 'AppView.body' })).text, /Localizable\/items_title/);
      assert.match((await call('get_source', { symbol: 'Store.reduce(_:)' })).text, /private func reduce/);

      // Out-of-range input is rejected by the schema, not executed.
      const invalid = await call('get_callers', { symbol: 'Store.send(_:)', depth: 99 });
      assert.equal(invalid.isError, true);
      // Unknown symbols produce a message, not an exception.
      assert.match((await call('get_symbol', { symbol: "'; DROP TABLE nodes; --" })).text, /no symbol matches/);
    } finally {
      await client.close();
      await server.close();
      db.close();
    }
  } finally {
    cleanup();
  }
});
