import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWorkflow, buildNodeInfoList, defaultValues, validateRun } from '../../host/core/workflow.mjs'

test('结构性 denoise 只限制范围，推断的 UI 步长不会拒绝原有默认值', () => {
  const config = analyzeWorkflow({ '3': { class_type: 'KSampler', inputs: { denoise: 0.625, seed: 1 } } })
  assert.equal(validateRun(config, defaultValues(config)).ok, true)
  assert.equal(validateRun(config, { params: { '3:denoise': 0.625 } }).ok, true)
  assert.equal(validateRun(config, { params: { '3:denoise': 1.01 } }).ok, false)
  const explicit = { nodes: config.nodes.map(node => ({ ...node, boundsSource: 'user' })) }
  assert.equal(validateRun(explicit, { params: { '3:denoise': 0.625 } }).issues[0].code, 'VALUE_STEP_MISMATCH')
  const overridden = analyzeWorkflow({ '3': { class_type: 'KSampler', inputs: { denoise: 0.5 } } }, {
    overrides: [{ nodeId: '3', fieldName: 'denoise', step: 0.2 }],
  })
  assert.equal(overridden.nodes[0].boundsSource, 'user')
  assert.equal(validateRun(overridden, { params: { '3:denoise': 0.5 } }).ok, false)
  const width = analyzeWorkflow({ '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } } }, {
    overrides: [{ nodeId: '4', fieldName: 'width', step: 16 }],
  })
  assert.equal(validateRun(width, { params: { '4:width': 520 } }).ok, false)
})

test('seed 校验原始十进制精度，舍入、下溢和巨大指数不能绕过整数检查', () => {
  const config = analyzeWorkflow({ '3': { class_type: 'KSampler', inputs: { seed: 1 } } })
  for (const raw of ['9007199254740990.5', '1.0000000000000001', '9007199254740991.1', '1e-999999999', '1e-999999999999999999999999999999']) {
    const result = validateRun(config, { params: { '3:seed': raw } })
    assert.equal(result.ok, false, raw)
    assert.ok(result.issues.some(issue => issue.code === 'VALUE_NOT_AN_INTEGER'), raw)
  }
  for (const raw of ['1', '+1.000', '1e3', '1.2e1', '00001', '9007199254740991', '900719925474099100.0e-2', '0e-999999999']) {
    assert.equal(validateRun(config, { params: { '3:seed': raw } }).ok, true, raw)
  }
})

test('加载类媒体默认可选，只有用户明确 override 后才阻止无媒体模式', () => {
  const source = {
    '1': { class_type: 'LoadImage', inputs: { image: 'default.png' } },
    '2': { class_type: 'LoadAudio', inputs: { audio: 'default.wav' } },
    '3': { class_type: 'LoadVideo', inputs: { video: 'default.mp4' } },
  }
  const inferred = analyzeWorkflow(source)
  assert.equal(inferred.nodes.every(node => node.required === false), true)
  assert.equal(validateRun(inferred, {}).ok, true)
  assert.ok(inferred.hints.warnings.some(warning => warning.includes('required')))
  const confirmed = analyzeWorkflow(source, { overrides: [{ nodeId: '1', fieldName: 'image', required: true }] })
  assert.equal(validateRun(confirmed, {}).issues[0].code, 'NODE_MISSING')
})

test('多行字符串标题只提供低置信度提示词候选，不把任意字符串都当提示词', () => {
  const config = analyzeWorkflow({
    '1': { class_type: 'PrimitiveStringMultiline', _meta: { title: '提示词' }, inputs: { value: 'scene' } },
    '2': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'Negative prompt' }, inputs: { value: 'blur' } },
    '3': { class_type: 'PrimitiveString', _meta: { title: '文件名' }, inputs: { value: 'output.png' } },
  })
  assert.equal(config.nodes.find(node => node.nodeId === '1').role, 'prompt')
  assert.equal(config.nodes.find(node => node.nodeId === '1').roleConfidence, 'low')
  assert.equal(config.nodes.find(node => node.nodeId === '2').role, 'negative_prompt')
  assert.equal(config.nodes.find(node => node.nodeId === '3').role, 'other')
  assert.ok(config.hints.warnings.some(warning => warning.includes('置信度')))
})

test('probe 图结构保留实际连线和媒体目标，不把枚举值误当成连线', () => {
  const config = analyzeWorkflow({
    '1': { class_type: 'LoadAudio', inputs: { audio: 'input.wav' } },
    '2': { class_type: 'AudioConsumer', inputs: { audio_1: ['1', 0], mode: ['one', 'two'] } },
  })
  assert.deepEqual(config.graph.links, [{ fromNodeId: '1', fromOutput: 0, toNodeId: '2', toInput: 'audio_1' }])
  assert.deepEqual(config.hints.mediaNodes.find(node => node.nodeId === '1').targets, [{ nodeId: '2', fieldName: 'audio_1', output: 0 }])
  assert.match(config.hints.editableHint, /不限制 API/)
})

test('同一节点有正负向字段时，优化目标默认写入正向字段', () => {
  const config = analyzeWorkflow({ '6': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'default positive', negative_prompt: 'default negative' } } })
  config.promptOptimizer = { targetNodeId: '6' }
  const payload = buildNodeInfoList(config, { prompt: 'new positive' }, { includeDefaults: true })
  assert.equal(payload.find(node => node.fieldName === 'prompt').fieldValue, 'new positive')
  assert.equal(payload.find(node => node.fieldName === 'negative_prompt').fieldValue, 'default negative')
})
