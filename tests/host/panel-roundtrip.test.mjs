/**
 * 面板「列表 → 编辑 → 保存」的往返：面板把拿到的投影整份写回（`overwrite:true`），
 * 所以投影里缺的字段保存一次就会从磁盘上消失。
 *
 * @module dsh-runninghub-plugin/tests/host/panel-roundtrip
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import * as workflow from '../../host/core/workflow.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { loadClientModule } from '../client/harness.mjs'

async function rig(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-panel-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const store = new Store({ dataDir })
  const rt = { store, dataDir, workflow, warn() {} }
  return { rt, store, methods: buildMethods(rt) }
}

const modelConfigured = () => ({
  id: 'wf1',
  name: '文生图',
  rhWorkflowId: '123',
  region: 'cn',
  outputKind: 'image',
  instanceType: 'default',
  modelPath: 'rhart-image/edit',
  nodes: [
    {
      nodeId: '470',
      fieldName: 'image',
      role: 'image',
      valueType: 'string',
      label: '参考图',
      default: '',
      required: false,
      overridable: false,
      targets: [{ nodeId: '459:474', fieldName: 'images.image_1', output: 0 }],
    },
    {
      nodeId: '6',
      fieldName: 'text',
      role: 'prompt',
      valueType: 'string',
      label: '提示词',
      default: '',
      required: true,
      overridable: true,
      roleConfidence: 'low',
    },
  ],
})

/** 面板流程：读列表 → 改描述 → 带 overwrite 保存。 */
async function savedFromPanel(methods, store, patch) {
  const [listed] = await methods.listWorkflows({})
  const result = await methods.saveWorkflow({ config: { ...listed, ...patch, overwrite: true } })
  assert.equal(result.ok, true)
  return store.getWorkflow('wf1')
}

test('面板只改描述：targets / overridable / roleConfidence / modelPath 都留在磁盘上', async (t) => {
  const { methods, store } = await rig(t)
  await store.saveWorkflow(modelConfigured())
  const saved = await savedFromPanel(methods, store, { description: '新描述' })
  assert.equal(saved.description, '新描述')
  assert.equal(saved.modelPath, 'rhart-image/edit')
  assert.deepEqual(saved.nodes[0].targets, [{ nodeId: '459:474', fieldName: 'images.image_1', output: 0 }])
  assert.equal(saved.nodes[0].overridable, false, 'false 也是配置过的值')
  assert.equal(saved.nodes[1].overridable, true)
  assert.equal(saved.nodes[1].roleConfidence, 'low')
})

test('老配置往返后不会凭空多出这些字段', async (t) => {
  const { methods, store } = await rig(t)
  const config = modelConfigured()
  delete config.modelPath
  for (const node of config.nodes) {
    delete node.targets
    delete node.overridable
    delete node.roleConfidence
  }
  await store.saveWorkflow(config)
  const saved = await savedFromPanel(methods, store, { description: '新描述' })
  assert.equal('modelPath' in saved, false)
  for (const node of saved.nodes) {
    for (const field of ['targets', 'overridable', 'roleConfidence']) assert.equal(field in node, false, field)
  }
})

test('面板编辑节点时 patchNode 保留看不到的字段', async (t) => {
  const { methods, store } = await rig(t)
  await store.saveWorkflow(modelConfigured())
  const [listed] = await methods.listWorkflows({})
  const { exports } = loadClientModule()
  const nodes = exports.patchNode(listed.nodes, '470', { label: '角色图' })
  assert.equal(nodes[0].label, '角色图')
  assert.deepEqual(nodes[0].targets, listed.nodes[0].targets)
  assert.equal(nodes[0].overridable, false)
})

test('面板探测添加的工作流带上素材 targets', async (t) => {
  const { rt, methods } = await rig(t)
  rt.pool = { pick: () => ({ ok: true, id: 'k1', key: 'synthetic' }), report() {} }
  rt.config = {}
  rt.api = {
    getWorkflowJson: async () => ({
      ok: true,
      workflowId: '123',
      workflow: {
        '10': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
        '3': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0] } },
        '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
      },
    }),
  }
  const probed = await methods.probeWorkflow({ request: { workflowId: '123', region: 'cn' } })
  assert.equal(probed.ok, true)
  const image = probed.config.nodes.find((node) => node.nodeId === '10')
  assert.deepEqual(image.targets, [{ nodeId: '3', fieldName: 'pixels', output: 0 }])
})
