export type Reasoning = 'off' | 'minimal' | 'low' | 'medium' | 'high';
export type GoogleModel = { id: string; name: string; variants?: { id: string; thinking: Reasoning }[] };
const levels: Reasoning[] = ['off', 'minimal', 'low', 'medium', 'high'];
export function googleModels(raw: { id: string; name: string }[]): GoogleModel[] {
  const groups = new Map<string, GoogleModel>();
  for (const item of raw) {
    // Collapse explicit levels, including GPT/Claude; "Thinking" alone is not a level.
    // Preserve opaque provider IDs and never infer availability from a model name.
    const match = /^((?:Gemini\s|Claude\s|GPT[-\s]).+?)\s*\((Off|Minimal|Low|Medium|High)\)$/i.exec(item.name);
    const key = match ? match[1].trim().toLowerCase() : item.id;
    let group = groups.get(key);
    if (!group) { group = { id: match ? match[1].split(/[-\s]/)[0].toLowerCase() + ':' + key.replace(/\s+/g, '-') : item.id, name: match ? match[1].trim() : item.name, ...(match ? { variants: [] } : {}) }; groups.set(key, group); }
    if (match) group.variants!.push({ id: item.id, thinking: match[2].toLowerCase() as Reasoning });
  }
  for (const group of groups.values()) group.variants?.sort((a, b) => levels.indexOf(a.thinking) - levels.indexOf(b.thinking));
  return [...groups.values()];
}
export function googleChoice(models: GoogleModel[], id: string, thinking: Reasoning = 'medium') {
  const family = models.find(m => m.id === id);
  if (family) return { model: family.id, thinking: family.variants?.some(v => v.thinking === thinking) || !family.variants ? thinking : family.variants.find(v => v.thinking === 'medium')?.thinking || family.variants[0].thinking };
  for (const model of models) { const variant = model.variants?.find(v => v.id === id); if (variant) return { model: model.id, thinking: variant.thinking }; }
  return { model: id, thinking };
}
export function googleRuntimeModel(models: GoogleModel[], id: string, thinking: Reasoning) {
  const model = models.find(m => m.id === id);
  if (!model) throw Error('Choose an available model for this Antigravity account.');
  if (!model.variants) return model.id;
  const variant = model.variants.find(v => v.thinking === thinking);
  if (!variant) throw Error('This model does not support that reasoning level.');
  return variant.id;
}
