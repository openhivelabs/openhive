/**
 * Backward-compat shim. The AI binder system prompt is now composed from
 * `prompts/common.ts` plus an optional per-panel-type chapter — see
 * `prompts/index.ts`. Existing callers that imported the legacy constant
 * still resolve through here.
 */
export { buildSystemPrompt } from './prompts'
