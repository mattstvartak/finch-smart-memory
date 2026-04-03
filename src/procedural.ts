import type { SmartMemoryConfig, ProceduralRule } from './types.js';
import { Storage } from './storage.js';
import { llmComplete } from './llm.js';

// ── Extraction Prompt ────────────────────────────────────────────────

const PROCEDURAL_EXTRACTION_PROMPT = `You analyze conversations between a user and their AI assistant to extract PROCEDURAL RULES about how this specific user wants things done.

Look for implicit and explicit signals:
- Code style: what the user includes, excludes, or corrects in code
- Communication: length, tone, format, words to avoid
- Workflow: when to act vs ask, when to be thorough vs brief
- Recurring corrections: if the user keeps fixing the same thing, that IS a rule
- Direct instructions: "always do X", "never do Y", "I prefer Z"

IMPORTANT: Extract rules about what the USER wants, not what the assistant did. If the assistant used em-dashes and the user didn't correct it, that's NOT a rule. If the user said "don't use em-dashes", that IS a rule.

CONVERSATION:
{{CONVERSATION}}

USER REACTION SIGNALS (these indicate user approval, frustration, corrections, etc.):
{{SIGNALS}}

EXISTING RULES (numbered -- use the number as ruleIndex when reinforcing or contradicting):
{{EXISTING_RULES}}

For each insight, output one of:
- "new" -- a rule not captured by any existing rule
- "reinforce" -- this conversation provides evidence an existing rule is correct
- "contradict" -- this conversation provides evidence an existing rule is wrong or outdated

Return a JSON array:
[{
  "rule": "Clear, specific, actionable rule",
  "domain": "code"|"communication"|"workflow"|"preference"|"general",
  "action": "new"|"reinforce"|"contradict",
  "ruleIndex": null for new rules, or the number of the existing rule,
  "evidence": "What happened in the conversation that supports this"
}]

Rules should be specific. Bad: "User likes clean code." Good: "Always add explicit return types to TypeScript functions."

If no procedural insights exist in this conversation, return [].
Return ONLY valid JSON. No markdown fences.`;

// ── Extract Rules from Conversation ──────────────────────────────────

export async function extractRules(
  config: SmartMemoryConfig,
  storage: Storage,
  messages: Array<{ role: string; content: string }>,
  signals?: Array<{ type: string; confidence: number }>
): Promise<void> {
  const existing = await storage.getRules();

  const conversation = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const signalText = signals?.map(s => `${s.type} (${s.confidence.toFixed(2)})`).join(', ') || 'none';
  const existingText = existing.length > 0
    ? existing.map((r, i) => `${i}. [${r.domain}] ${r.rule} (confidence: ${r.confidence.toFixed(2)})`).join('\n')
    : 'No existing rules.';

  const prompt = PROCEDURAL_EXTRACTION_PROMPT
    .replace('{{CONVERSATION}}', conversation)
    .replace('{{SIGNALS}}', signalText)
    .replace('{{EXISTING_RULES}}', existingText);

  const text = await llmComplete(config, prompt, 'Extract procedural rules from this conversation.', {
    maxTokens: 800,
    temperature: 0,
  });

  const results = parseJsonArray(text);

  for (const r of results) {
    if (!r.rule || !r.action) continue;

    if (r.action === 'new') {
      const rule: ProceduralRule = {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        rule: r.rule,
        domain: r.domain ?? 'general',
        confidence: 0.5,
        reinforcements: 0,
        contradictions: 0,
        evidence: [r.evidence ?? ''],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await storage.saveRule(rule);
    } else if (r.action === 'reinforce' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.reinforcements++;
        rule.confidence = Math.min(1.0, rule.confidence + 0.1);
        rule.evidence.push(r.evidence ?? '');
        rule.updatedAt = new Date().toISOString();
        await storage.saveRule(rule);
      }
    } else if (r.action === 'contradict' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.contradictions++;
        rule.confidence = Math.max(0.0, rule.confidence - 0.2);
        rule.evidence.push(`CONTRADICTED: ${r.evidence ?? ''}`);
        rule.updatedAt = new Date().toISOString();
        if (rule.confidence <= 0) {
          await storage.deleteRule(rule.id);
        } else {
          await storage.saveRule(rule);
        }
      }
    }
  }
}

// ── Format Rules for System Prompt ───────────────────────────────────

export async function formatRulesForPrompt(storage: Storage): Promise<string> {
  const rules = (await storage.getRules()).filter(r => r.confidence > 0.3);
  if (rules.length === 0) return '';

  return `\n--- PROCEDURAL RULES ---\n${rules.map(r => `- [${r.domain}] ${r.rule}`).join('\n')}\n`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseJsonArray(text: string): Array<Record<string, any>> {
  const match = text.match(/\[[\s\S]*?\]/) ?? text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    const greedy = text.match(/\[[\s\S]*\]/);
    if (greedy) {
      try { return JSON.parse(greedy[0]); } catch { /* noop */ }
    }
    return [];
  }
}
