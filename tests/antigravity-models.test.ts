import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleModels, googleChoice, googleRuntimeModel } from '../host/antigravity-models.ts';
test('Gemini reasoning variants become one model with supported runtime choices', () => {
  const models = googleModels([{ id: 'flash-high', name: 'Gemini 3.8 Flash (High)' }, { id: 'flash-medium', name: 'Gemini 3.8 Flash (Medium)' }, { id: 'flash-low', name: 'Gemini 3.8 Flash (Low)' }, { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' }, { id: 'gemini-pro-low', name: 'Gemini 3.1 Pro (Low)' }, { id: 'plain', name: 'Other model' }]);
  assert.equal(models.length, 3); assert.equal(models[0].name, 'Gemini 3.8 Flash'); assert.deepEqual(models[0].variants!.map(v => v.thinking), ['low', 'medium', 'high']);
  const old = googleChoice(models, 'flash-low', 'high'); assert.equal(old.model, models[0].id); assert.equal(old.thinking, 'low');
  assert.equal(googleRuntimeModel(models, models[0].id, 'high'), 'flash-high'); assert.equal(googleRuntimeModel(models, models[1].id, 'high'), 'gemini-pro-agent');
  assert.throws(() => googleRuntimeModel(models, models[0].id, 'off'), /does not support/); assert.throws(() => googleRuntimeModel(models, 'invented', 'high'), /available model/);
  assert.equal(googleChoice(models, models[1].id, 'medium').thinking, 'low'); assert.equal(googleRuntimeModel(models, 'plain', 'medium'), 'plain');
});

test('Antigravity preserves Opus, Sonnet and opaque GPT IDs with only advertised reasoning choices', () => {
  const models = googleModels([{ id: 'MODEL_PLACEHOLDER_M26', name: 'Claude Opus 4.6 (Thinking)' }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Thinking)' }, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }, { id: 'gpt-oss-120b-high', name: 'GPT-OSS 120B (High)' }]);
  assert.equal(models.length, 3); assert.equal(googleRuntimeModel(models, 'MODEL_PLACEHOLDER_M26', 'off'), 'MODEL_PLACEHOLDER_M26');
  assert.equal(models[0].variants, undefined); assert.equal(models[1].variants, undefined);
  const gpt = models[2]; assert.equal(gpt.name, 'GPT-OSS 120B'); assert.deepEqual(gpt.variants!.map(v => v.thinking), ['medium', 'high']);
  assert.equal(googleRuntimeModel(models, gpt.id, 'high'), 'gpt-oss-120b-high'); assert.throws(() => googleRuntimeModel(models, gpt.id, 'low'), /does not support/);
  assert.deepEqual(googleChoice(models, 'gpt-oss-120b-medium', 'high'), { model: gpt.id, thinking: 'medium' });
});
