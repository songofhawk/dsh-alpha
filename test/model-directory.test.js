const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog } = require('../src/lib/catalog');
const { createTaskEngine } = require('../src/lib/task-engine');
const { createTaskStore } = require('../src/lib/task-store');
const { createApprovalBroker } = require('../src/lib/approvals');
const { createWorkspaceService } = require('../src/lib/workspace-service');
const { createGatewayHub } = require('../src/lib/gateway-hub');
const { runGatewayWorker } = require('../src/lib/gateway-worker');
const { connectWebSocket } = require('../src/adapters/vendor/shared/websocket');
const { tmpDir, cleanupDir, waitFor } = require('./helpers');

const live = { models: ['gpt-5.6-luna', 'gpt-5.5'], default_model: 'gpt-5.6-luna', reasoning_efforts: ['high'] };
const quiet = { log() {}, warn() {}, error() {} };

test('旧 Worker 重连不覆盖实时目录；冷启动不把旧模型列表当白名单', () => {
  const catalog = createCatalog({ allowedRoots: [process.cwd()] });
  const legacyHello = () => catalog.registerRemoteAgent({ machineId: 'worker', provider: 'codex', capabilities: { models: ['gpt-5.5'] }, machine: { allowedRoots: [process.cwd()] } });
  assert.deepEqual(legacyHello().capabilities.models, []);
  catalog.updateAgentCapabilities('worker:codex', live);
  assert.deepEqual(legacyHello().capabilities, live);
  // 显式实时目录更新仍然生效，包括合法的空目录。
  const changed = catalog.registerRemoteAgent({ machineId: 'worker', provider: 'codex', capabilities: { models: [] }, capabilitiesSource: 'runtime', machine: {} });
  assert.deepEqual(changed.capabilities.models, []);
});

test('选择 luna 后，真实 Gateway 断线重连仍以 luna 执行；拒绝时显示有效选择', async (t) => {
  const dir = tmpDir('alpha-model-directory-');
  const catalog = createCatalog({ allowedRoots: [dir] });
  const hub = createGatewayHub({ catalog, tokens: { worker: 'test-token' }, port: 0, log: quiet });
  await hub.start();
  let discoveries = 0;
  let connected = 0;
  const received = [];
  const hellos = [];
  const worker = runGatewayWorker({
    hubUrl: `ws://127.0.0.1:${hub.address().port}/`, gatewayToken: 'test-token', machineId: 'worker',
    providers: ['codex'], allowedRoots: [dir], discoverWorkspaces: false, probeProvider: () => ({ available: true }),
    heartbeatIntervalMs: 20, reconnectMinMs: 10, reconnectMaxMs: 10, log: quiet,
    onConnected: () => { connected++; },
    connect: async (...args) => {
      const socket = await connectWebSocket(...args);
      const send = socket.sendJson.bind(socket);
      socket.sendJson = (message) => { if (message.type === 'hello') hellos.push(message.payload); return send(message); };
      return socket;
    },
    adapterFor: () => ({
      async discoverCapabilities(options) { discoveries++; assert.equal(options.force, true); return live; },
      async *runTurn(context) { received.push(context.settings.model); yield { type: 'complete', payload: { message: context.settings.model } }; },
      async cancelTurn() {}
    })
  });
  const loop = worker.loop();
  t.after(async () => { worker.stop(); await loop; await hub.close(); cleanupDir(dir); });
  await waitFor(() => catalog.listAgents().length === 1);
  assert.deepEqual(catalog.getAgent('worker:codex').capabilities.models, []);
  const found = await hub.discoverCapabilities({ machineId: 'worker', provider: 'codex', force: true });
  catalog.updateAgentCapabilities('worker:codex', found.capabilities);
  const store = createTaskStore({ dataDir: dir });
  const workspaces = createWorkspaceService({ catalog, dataDir: dir });
  workspaces.select('session', { agentId: 'worker:codex', model: 'gpt-5.6-luna' });
  const engine = createTaskEngine({ catalog, store, workspaces, approvals: createApprovalBroker({ store }), allowedRoots: [dir],
    adapterFor: () => ({ async *runTurn(context) { yield* hub.run({ machineId: 'worker', context }); }, async cancelTurn() {} }) });
  const run = () => engine.dispatchAndWait({ sessionId: 'session', model: 'gpt-5.5', prompt: 'model test' });
  assert.equal((await run()).result, 'gpt-5.6-luna');
  worker.disconnect();
  await waitFor(() => connected >= 2 && catalog.getAgent('worker:codex').available);
  assert.deepEqual(catalog.getAgent('worker:codex').capabilities, live);
  assert.equal(discoveries, 1, '重连使用 Worker 已发现的缓存');
  assert.equal(hellos[1].providers[0].capabilitiesSource, 'runtime');
  assert.deepEqual(hellos[1].providers[0].capabilities, live, 'HELLO 本身必须携带实时目录');
  assert.equal((await run()).result, 'gpt-5.6-luna');
  assert.deepEqual(received, ['gpt-5.6-luna', 'gpt-5.6-luna']);
  catalog.updateAgentCapabilities('worker:codex', { models: ['gpt-5.5'] });
  const before = store.listTasks().length;
  assert.throws(() => engine.dispatch({ sessionId: 'session', model: 'gpt-5.5', prompt: 'should fail' }), /生效模型 gpt-5.6-luna（来源：界面选择）.*model 只能是/);
  assert.equal(store.listTasks().length, before);
  assert.equal(workspaces.selection('session').model, 'gpt-5.6-luna', '不能静默删除用户选择');
});
